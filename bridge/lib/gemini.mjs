import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

/**
 * Call LLM with a system prompt and user message (Groq primary, NVIDIA fallback).
 * Drop-in replacement for the old geminiChat — same signature.
 */
export async function geminiChat(systemPrompt, userMessage, opts = {}) {
  const temperature = opts.temperature ?? 0.4;
  const maxTokens = opts.maxTokens ?? 8192;

  // Try Groq first
  if (GROQ_API_KEY) {
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
          temperature, max_tokens: maxTokens,
        }),
      });
      if (!resp.ok) throw new Error(`Groq: ${resp.status}`);
      const data = await resp.json();
      return data.choices[0].message.content;
    } catch (err) {
      console.warn('[llm] Groq failed:', err.message);
    }
  }

  // Fallback to NVIDIA
  if (NVIDIA_API_KEY) {
    const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'meta/llama-3.3-70b-instruct',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
        temperature, max_tokens: maxTokens,
      }),
    });
    if (!resp.ok) throw new Error(`NVIDIA: ${resp.status} ${await resp.text()}`);
    const data = await resp.json();
    return data.choices[0].message.content;
  }

  throw new Error('No LLM provider available (need GROQ_API_KEY or NVIDIA_API_KEY)');
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
