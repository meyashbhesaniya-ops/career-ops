import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');

/**
 * Ensure a BRIDGE_TOKEN exists in .env. Generate one on first run.
 * Returns the token string.
 */
export function ensureToken() {
  let envContent = '';
  if (existsSync(ENV_PATH)) {
    envContent = readFileSync(ENV_PATH, 'utf-8');
  }

  const match = envContent.match(/^BRIDGE_TOKEN=(.+)$/m);
  if (match && match[1].trim()) {
    return match[1].trim();
  }

  // Generate a secure random token
  const token = randomBytes(32).toString('hex');

  if (envContent.includes('BRIDGE_TOKEN=')) {
    envContent = envContent.replace(/^BRIDGE_TOKEN=.*$/m, `BRIDGE_TOKEN=${token}`);
  } else {
    envContent += `\nBRIDGE_TOKEN=${token}\n`;
  }
  writeFileSync(ENV_PATH, envContent, 'utf-8');
  return token;
}

/**
 * Express middleware: validate Bearer token using timing-safe comparison.
 */
export function authMiddleware(expectedToken) {
  const expectedBuf = Buffer.from(expectedToken, 'utf-8');

  return (req, res, next) => {
    // Skip auth for health check
    if (req.path === '/health') return next();

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const tokenBuf = Buffer.from(header.slice(7), 'utf-8');

    if (tokenBuf.length !== expectedBuf.length ||
        !timingSafeEqual(tokenBuf, expectedBuf)) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    next();
  };
}
