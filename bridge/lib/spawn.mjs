import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

/**
 * Spawn a script from the career-ops root and capture stdout + stderr.
 * Returns { stdout, stderr, code }.
 */
export function spawnScript(scriptName, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(ROOT, scriptName), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...opts.env },
      timeout: opts.timeout || 120_000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}
