/**
 * Per-chat role file resolver.
 *
 * Each bot can have per-group role definitions at:
 *   {workingDir}/roles/{chatId}.md
 *
 * Role content is injected into the CLI prompt as a <role> block, allowing
 * the same bot to adopt different personas in different Lark groups.
 */

import { existsSync, readFileSync, statSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { logger } from '../utils/logger.js';

const MAX_ROLE_BYTES = 4 * 1024; // 4 KB

interface CacheEntry {
  mtimeMs: number;
  content: string | null; // null = file not found (negative cache)
}

const cache = new Map<string, CacheEntry>();

function cacheKey(workingDir: string, chatId: string): string {
  return `${workingDir}::${chatId}`;
}

/**
 * Resolve the role content for a given bot working directory and chat.
 * Returns the role markdown string, or null if no role file exists.
 */
export function resolveRoleFile(workingDir: string, chatId: string): string | null {
  if (!workingDir || !chatId) return null;

  const key = cacheKey(workingDir, chatId);
  const filePath = join(workingDir, 'roles', `${chatId}.md`);

  let stat: ReturnType<typeof statSync> | null = null;
  try {
    if (!existsSync(filePath)) {
      // Negative cache
      cache.set(key, { mtimeMs: 0, content: null });
      return null;
    }
    stat = statSync(filePath);
  } catch {
    cache.set(key, { mtimeMs: 0, content: null });
    return null;
  }

  // Cache hit — skip read if mtime unchanged
  const cached = cache.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.content;
  }

  // Read & validate
  try {
    const raw = readFileSync(filePath, 'utf-8');

    // Truncate by UTF-8 byte length, not JS string length (CJK chars are 3 bytes each)
    let content = raw.trim();
    if (Buffer.byteLength(content, 'utf-8') > MAX_ROLE_BYTES) {
      logger.warn(`[role] ${filePath} exceeds ${MAX_ROLE_BYTES} UTF-8 bytes (${Buffer.byteLength(content, 'utf-8')}), truncating`);
      while (Buffer.byteLength(content, 'utf-8') > MAX_ROLE_BYTES) {
        content = content.slice(0, -1);
      }
    }

    if (!content) {
      cache.set(key, { mtimeMs: stat.mtimeMs, content: null });
      return null;
    }

    cache.set(key, { mtimeMs: stat.mtimeMs, content });
    logger.info(`[role] chat=${chatId} file=${filePath} (${Buffer.byteLength(content, 'utf-8')} bytes)`);
    return content;
  } catch (err: any) {
    logger.warn(`[role] failed to read ${filePath}: ${err?.message ?? err}`);
    cache.set(key, { mtimeMs: 0, content: null });
    return null;
  }
}

/** Clear the in-memory cache (useful for testing or manual reload). */
export function clearRoleCache(): void {
  cache.clear();
}

/** Invalidate cache for a specific workingDir + chatId pair. */
export function invalidateRoleCache(workingDir: string, chatId: string): void {
  cache.delete(cacheKey(workingDir, chatId));
}

/** Write or overwrite role content for a chat. Creates the roles/ directory if needed. */
export function writeRoleFile(workingDir: string, chatId: string, content: string): void {
  const rolesDir = join(workingDir, 'roles');
  mkdirSync(rolesDir, { recursive: true });
  const filePath = join(rolesDir, `${chatId}.md`);
  // Truncate by UTF-8 byte length, not JS string length
  let trimmed = content.trim();
  while (Buffer.byteLength(trimmed, 'utf-8') > MAX_ROLE_BYTES) {
    trimmed = trimmed.slice(0, -1);
  }
  writeFileSync(filePath, trimmed, 'utf-8');
  const key = cacheKey(workingDir, chatId);
  cache.delete(key); // invalidate so next read picks up the new content
  logger.info(`[role] wrote chat=${chatId} file=${filePath} (${Buffer.byteLength(trimmed, 'utf-8')} bytes)`);
}

/** Delete a role file for a chat. */
export function deleteRoleFile(workingDir: string, chatId: string): boolean {
  const filePath = join(workingDir, 'roles', `${chatId}.md`);
  try {
    unlinkSync(filePath);
    const key = cacheKey(workingDir, chatId);
    cache.delete(key);
    logger.info(`[role] deleted chat=${chatId} file=${filePath}`);
    return true;
  } catch (err: any) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    logger.warn(`[role] failed to delete ${filePath}: ${err?.message ?? err}`);
    return false;
  }
}
