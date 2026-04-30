import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// Load .env from parent repo if bridge .env doesn't have the key
let apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  try {
    const parentEnv = join(ROOT, '.env');
    if (existsSync(parentEnv)) {
      const lines = readFileSync(parentEnv, 'utf-8').split('\n');
      for (const line of lines) {
        const m = line.match(/^GEMINI_API_KEY=(.+)/);
        if (m) { apiKey = m[1].trim(); break; }
      }
    }
  } catch { /* ignore */ }
}

let genAI = null;

async function getClient() {
  if (genAI) return genAI;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  genAI = new GoogleGenerativeAI(apiKey);
  return genAI;
}

/**
 * Call Gemini with a system prompt and user message.
 * Returns the text response.
 */
export async function geminiChat(systemPrompt, userMessage, opts = {}) {
  const client = await getClient();
  const modelName = opts.model || process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  const model = client.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxTokens ?? 8192,
    },
  });

  const result = await model.generateContent([
    { text: systemPrompt },
    { text: userMessage },
  ]);

  return result.response.text();
}

/**
 * Load mode files for building prompts.
 */
export function loadModeFiles() {
  const read = (p) => {
    const full = join(ROOT, p);
    return existsSync(full) ? readFileSync(full, 'utf-8').trim() : '';
  };

  return {
    shared: read('modes/_shared.md'),
    oferta: read('modes/oferta.md'),
    autoPipeline: read('modes/auto-pipeline.md'),
    pdf: read('modes/pdf.md'),
    apply: read('modes/apply.md'),
    cv: read('cv.md'),
    profile: read('modes/_profile.md'),
  };
}
