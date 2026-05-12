import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

/** Global submit log — CoCo appends one JSON line here on every successful
 *  user submit across all sessions (mode:"user"). Format observed:
 *  `{"content":"...","mode":"user","timestamp":"..."}`. Used the same way
 *  the Codex adapter uses ~/.codex/history.jsonl: write → poll for our
 *  marker → retry Enter if missing → return {submitted:false, recheck}
 *  on final failure so worker can surface a Lark warning. */
const HISTORY_PATH = join(homedir(), '.cache', 'coco', 'history.jsonl');

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function currentFileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

function historyDeltaContains(path: string, fromByte: number, marker: string): boolean {
  if (!existsSync(path)) return false;
  let size: number;
  try { size = statSync(path).size; } catch { return false; }
  if (size <= fromByte) return false;
  const len = size - fromByte;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, fromByte);
  } finally {
    closeSync(fd);
  }
  const delta = buf.toString('utf8');
  for (const line of delta.split('\n')) {
    if (line.includes('"mode":"user"') && line.includes(marker)) return true;
  }
  return false;
}

async function waitForHistoryAppend(
  path: string, fromByte: number, marker: string, timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (historyDeltaContains(path, fromByte, marker)) return true;
    await delay(100);
  }
  return false;
}

/** Build a JSON-escaped prefix of content so substring-match against the raw
 *  history.jsonl works (the content field stores \n as the two-char escape
 *  `\n`, not a literal newline). 40 chars is unique enough across concurrent
 *  bots. Mirrors codex.ts's approach. */
function historyMarker(content: string): string {
  const prefix = content.slice(0, 40);
  return JSON.stringify(prefix).slice(1, -1);  // strip surrounding quotes
}

export function createCocoAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'coco');
  return {
    id: 'coco',
    resolvedBin: bin,

    buildArgs({ sessionId, resume }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      args.push('--yolo');
      args.push('--disallowed-tool', 'EnterPlanMode', '--disallowed-tool', 'ExitPlanMode');
      return args;
    },

    buildResumeCommand({ sessionId }) {
      return `coco --resume ${sessionId}`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      // CoCo is a Claude Code fork (Ink TUI) and inherits Claude Code's two
      // failure modes when content has embedded newlines:
      //   1. tmux `send-keys -l` treats each \n as Enter, so a raw sendText
      //      of multi-line content either submits fragments line-by-line or
      //      paste-burst-coalesces with the *trailing* Enter consumed as part
      //      of the paste — text just sits in the input box, never submitted.
      //   2. The old adapter had no verification, so the worker never knew
      //      and the user stared at Lark waiting for a reply that never came.
      //
      // Fix mirrors claude-code.ts:
      //   - split content by \n, type each line via send-keys -l, insert
      //     soft-newline (`\` + Enter) between lines — Claude Code's
      //     documented idiom to add a newline without submitting.
      //   - throttle each tmux call (~30ms) to stay under the paste-burst
      //     threshold so soft-newlines aren't silently swallowed as a paste.
      //   - submitDelay then a single Enter to actually submit.
      //
      // Verification mirrors codex.ts using ~/.cache/coco/history.jsonl:
      // write → poll for our content prefix in the delta → retry Enter up
      // to 3 times → return {submitted:false, recheck} on final miss so the
      // worker can defer-recheck and otherwise surface a Lark warning.
      const hasImagePath = /\.(jpe?g|png|gif|webp|svg|bmp)\b/i.test(content);
      const submitDelay = hasImagePath ? 800 : 500;
      const TYPING_THROTTLE_MS = 30;

      const tick = () => new Promise<void>(r => setTimeout(r, TYPING_THROTTLE_MS));

      const trySendEnter = (): boolean => {
        try {
          if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
          else pty.write('\r');
          return true;
        } catch {
          // tmux session is gone (CLI exited mid-write) — bail cleanly
          // rather than crashing the worker on unhandled execFileSync.
          return false;
        }
      };

      const baseByte = currentFileSize(HISTORY_PATH);
      const marker = historyMarker(content);

      try {
        if (pty.sendText && pty.sendSpecialKeys) {
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].length > 0) {
              pty.sendText(lines[i]);
              await tick();
            }
            if (i < lines.length - 1) {
              // Soft-newline: `\` + Enter inserts a newline without submitting.
              pty.sendText('\\');
              await tick();
              pty.sendSpecialKeys('Enter');
              await tick();
            }
          }
        } else {
          // Non-tmux fallback (raw PTY): bracketed paste is reliable here
          // since we control the markers directly — no send-keys -l \n quirk.
          pty.write('\x1b[200~' + content + '\x1b[201~');
        }
      } catch {
        return { submitted: false };
      }
      await delay(submitDelay);
      if (!trySendEnter()) return { submitted: false };

      // Fresh-install short-wait: when history.jsonl is absent at submit
      // time, give CoCo up to 1.2s to create it. If our marker shows up →
      // success. If the file is still absent → trust the Enter and return
      // (this is the genuine "first run / coco doesn't write history"
      // case). If the file appeared but our marker isn't there → fall
      // through to the normal retry/failure loop — better to warn than to
      // silently mask a real submit failure on a new install.
      if (!existsSync(HISTORY_PATH) && baseByte === 0) {
        if (await waitForHistoryAppend(HISTORY_PATH, baseByte, marker, 1200)) {
          return undefined;
        }
        if (!existsSync(HISTORY_PATH)) {
          return undefined;
        }
        // File appeared during the wait but our marker isn't in it — fall
        // through to the retry loop. baseByte stays 0 so the loop scans
        // the whole file.
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        if (await waitForHistoryAppend(HISTORY_PATH, baseByte, marker, 800)) {
          return undefined;
        }
        if (!trySendEnter()) return { submitted: false };
      }
      if (await waitForHistoryAppend(HISTORY_PATH, baseByte, marker, 800)) {
        return undefined;
      }
      // In-band budget exhausted. Hand the worker a recheck closure: a slow
      // CoCo (cold start, large initial prompt, heavy hooks) may still
      // append our marker after retries gave up. Worker re-scans after a
      // delay before deciding whether to warn the user.
      const recheck = (): boolean => historyDeltaContains(HISTORY_PATH, baseByte, marker);
      return { submitted: false, recheck };
    },

    completionPattern: undefined,
    // `⏵⏵` only shows when CoCo runs with --yolo (bypass permissions). Adopted
    // CoCo processes started by the user manually usually don't have that flag,
    // so the status bar shows just the model badge `⬡ <model>` instead. Match
    // either — without this, idle detection never fires for adopt mode and the
    // transcript bridge never drains.
    readyPattern: /⏵⏵|⬡/,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: false,
  };
}

export const create = createCocoAdapter;
