import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// Load Groq API key
let groqKey = process.env.GROQ_API_KEY;
if (!groqKey) {
  try {
    const parentEnv = join(ROOT, '.env');
    if (existsSync(parentEnv)) {
      const lines = readFileSync(parentEnv, 'utf-8').split('\n');
      for (const line of lines) {
        const m = line.match(/^GROQ_API_KEY=(.+)/);
        if (m) { groqKey = m[1].trim(); break; }
      }
    }
  } catch { /* ignore */ }
}

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Detect form fields from a screenshot + DOM outline using Groq Vision.
 *
 * @param {string} screenshotB64 - Base64-encoded PNG screenshot of the form region
 * @param {string} domOutline - Stripped DOM outline (tag, name, id, label text)
 * @param {string} url - The page URL for context
 * @returns {Array<{kind: string, selector: string}>} - Detected fields
 */
export async function detectFields(screenshotB64, domOutline, url) {
  if (!groqKey) {
    throw new Error('GROQ_API_KEY not configured. Add it to bridge/.env or parent .env');
  }

  const systemPrompt = `You are a form field detector. Given a screenshot of a job application form and its DOM outline, identify each input field and map it to a standard field kind.

Return ONLY valid JSON — an array of objects with "kind" and "selector" keys.

Standard field kinds: first_name, last_name, full_name, email, phone, linkedin, github, portfolio_url, location, address, city, state, zip, country, resume_upload, cover_letter_upload, cover_letter_text, salary_expectation, start_date, work_authorization, visa_sponsorship, gender, race, veteran_status, disability_status, custom_question

For "selector", provide a CSS selector that uniquely identifies the input element (prefer #id, then [name=...], then label-based selectors).

Example output:
[
  {"kind": "first_name", "selector": "#first_name"},
  {"kind": "last_name", "selector": "[name='last_name']"},
  {"kind": "email", "selector": "#email"},
  {"kind": "resume_upload", "selector": "input[type='file'][name='resume']"}
]`;

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${groqKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.2-11b-vision-preview',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `URL: ${url}\n\nDOM Outline:\n${domOutline}`,
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${screenshotB64}` },
            },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) throw new Error('Empty response from Groq');

  try {
    const parsed = JSON.parse(content);
    // Handle both {fields: [...]} and [...] formats
    const fields = Array.isArray(parsed) ? parsed : (parsed.fields || []);
    // Validate structure
    return fields.filter(f => f.kind && f.selector);
  } catch {
    throw new Error(`Failed to parse Groq response as JSON: ${content.slice(0, 200)}`);
  }
}
