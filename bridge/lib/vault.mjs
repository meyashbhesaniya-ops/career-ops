/**
 * bridge/lib/vault.mjs — Credential vault
 *
 * AES-256-GCM encryption for portal credentials stored in Supabase.
 * Master key loaded from VAULT_KEY env var (32-byte hex string).
 *
 * Usage:
 *   const vault = new Vault();
 *   await vault.store('linkedin.com', { email, password, otpSeed });
 *   const creds = await vault.get('linkedin.com');
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { getCredentials, upsertCredentials } from './db.mjs';

const ALGO = 'aes-256-gcm';
const KEY_HEX_LEN = 64; // 32 bytes = 64 hex chars

function getKey() {
  const hex = process.env.VAULT_KEY;
  if (!hex || hex.length !== KEY_HEX_LEN) {
    throw new Error(
      '[vault] VAULT_KEY must be a 64-character hex string. ' +
      'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(24 hex) + tag(32 hex) + ciphertext(hex)
  return iv.toString('hex') + tag.toString('hex') + encrypted.toString('hex');
}

function decrypt(ciphertext) {
  const key = getKey();
  const iv = Buffer.from(ciphertext.slice(0, 24), 'hex');
  const tag = Buffer.from(ciphertext.slice(24, 56), 'hex');
  const data = Buffer.from(ciphertext.slice(56), 'hex');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8');
}

export class Vault {
  /**
   * Store credentials for a domain.
   * @param {string} domain - e.g. 'linkedin.com'
   * @param {{ email, password, otpSeed?, cookies? }} creds
   */
  async store(domain, { email, password, otpSeed = null, cookies = null }) {
    await upsertCredentials(domain, {
      email_enc: encrypt(email),
      password_enc: encrypt(password),
      otp_seed_enc: otpSeed ? encrypt(otpSeed) : null,
      cookies_enc: cookies ? encrypt(JSON.stringify(cookies)) : null,
    });
  }

  /**
   * Retrieve and decrypt credentials for a domain.
   * Returns null if not found.
   */
  async get(domain) {
    const row = await getCredentials(domain);
    if (!row) return null;
    return {
      email: decrypt(row.email_enc),
      password: decrypt(row.password_enc),
      otpSeed: row.otp_seed_enc ? decrypt(row.otp_seed_enc) : null,
      cookies: row.cookies_enc ? JSON.parse(decrypt(row.cookies_enc)) : null,
      cookiesExpiry: row.cookies_expiry,
      lastLogin: row.last_login,
    };
  }

  /**
   * Update only the cookies for a domain (called after each successful login).
   */
  async updateCookies(domain, cookies, expiry = null) {
    const { upsertCredentials: upsert } = await import('./db.mjs');
    await upsertCredentials(domain, {
      cookies_enc: encrypt(JSON.stringify(cookies)),
      cookies_expiry: expiry,
      last_login: new Date().toISOString(),
      login_ok: true,
    });
  }

  /**
   * Mark login as failed (clears cookie cache so next attempt re-authenticates).
   */
  async markLoginFailed(domain) {
    await upsertCredentials(domain, {
      cookies_enc: null,
      cookies_expiry: null,
      login_ok: false,
    });
  }

  /**
   * List all stored domains.
   */
  async listDomains() {
    const { db } = await import('./db.mjs');
    const { data } = await db.from('credentials').select('domain, login_ok, last_login');
    return data ?? [];
  }

  /**
   * Generate a new vault key — call once during setup, store in .env
   */
  static generateKey() {
    return randomBytes(32).toString('hex');
  }
}
