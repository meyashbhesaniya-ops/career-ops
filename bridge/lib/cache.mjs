import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', '..', 'local', 'cache');

// Ensure cache directory exists
mkdirSync(CACHE_DIR, { recursive: true });

/**
 * Generate a cache key from domain + form structure hash.
 */
export function cacheKey(domain, formHash) {
  const hash = createHash('sha256').update(`${domain}:${formHash}`).digest('hex').slice(0, 16);
  return hash;
}

/**
 * Get cached field mappings for a domain+form combo.
 * Returns null if not cached.
 */
export function getCache(domain, formHash) {
  const key = cacheKey(domain, formHash);
  const path = join(CACHE_DIR, `${key}.json`);

  if (!existsSync(path)) return null;

  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return data.fields || null;
  } catch {
    return null;
  }
}

/**
 * Store field mappings in cache.
 */
export function setCache(domain, formHash, fields) {
  const key = cacheKey(domain, formHash);
  const path = join(CACHE_DIR, `${key}.json`);

  const data = {
    domain,
    formHash,
    cachedAt: new Date().toISOString(),
    fields,
  };

  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}
