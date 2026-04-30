#!/usr/bin/env node
/**
 * groq-eval.mjs — Groq-powered Job Offer Evaluator for career-ops
 *
 * Drop-in replacement for gemini-eval.mjs.
 * Uses Groq Cloud (OpenAI-compatible API) — no SDK install needed.
 * Also supports NVIDIA NIM API as fallback (same OpenAI-compat format).
 *
 * Usage:
 *   node groq-eval.mjs "Paste full JD text here"
 *   node groq-eval.mjs --file ./jds/my-job.txt
 *   node groq-eval.mjs --provider nvidia "..."
 *
 * Requires ONE of:
 *   GROQ_API_KEY   in bridge/.env   → https://console.groq.com/keys
 *   NVIDIA_API_KEY in bridge/.env   → https://build.nvidia.com
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Bootstrap: load .env before anything else
// Load both bridge/.env (where keys live) and parent .env
// ---------------------------------------------------------------------------
try {
  const { config } = await import('dotenv');
  const ROOT = dirname(fileURLToPath(import.meta.url));
  config({ path: join(ROOT, 'bridge', '.env') });
  config({ path: join(ROOT, '.env') });
} catch {
  // dotenv optional
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = dirname(fileURLToPath(import.meta.url));

const PATHS = {
  shared:  join(ROOT, 'modes', '_shared.md'),
  oferta:  join(ROOT, 'modes', 'oferta.md'),
  cv:      join(ROOT, 'cv.md'),
  reports: join(ROOT, 'reports'),
  tracker: join(ROOT, 'data', 'applications.md'),
};

// ---------------------------------------------------------------------------
// Provider config — Groq first, NVIDIA fallback
// ---------------------------------------------------------------------------
const PROVIDERS = {
  groq: {
    baseUrl:  'https://api.groq.com/openai/v1',
    key:      () => process.env.GROQ_API_KEY,
    // Free tier: 6k TPM — aggressively truncate context to fit
    model:    process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    name:     'Groq (llama-3.1-8b-instant)',
    maxChars: 4000, // ~1000 tokens reserved for prompt boilerplate
  },
  nvidia: {
    baseUrl:  'https://integrate.api.nvidia.com/v1',
    key:      () => process.env.NVIDIA_API_KEY,
    // llama-3.3-70b-instruct: high quality, generous limits
    model:    process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct',
    name:     'NVIDIA NIM (llama-3.3-70b-instruct)',
    maxChars: 24000,
  },
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║          career-ops — Groq / NVIDIA Evaluator                   ║
╚══════════════════════════════════════════════════════════════════╝

  Evaluate a job offer using Groq or NVIDIA NIM (no Gemini key needed).

  USAGE
    node groq-eval.mjs "<JD text>"
    node groq-eval.mjs --file ./jds/my-job.txt
    node groq-eval.mjs --provider nvidia "<JD text>"

  OPTIONS
    --file <path>        Read JD from a file
    --provider groq      Use Groq Cloud (default, free tier)
    --provider nvidia    Use NVIDIA NIM API
    --model <name>       Override the model name
    --no-save            Do not save report to reports/
    --help               Show this help

  SETUP
    Add ONE of these to bridge/.env:

      GROQ_API_KEY=gsk_...     (get free key: https://console.groq.com/keys)
      NVIDIA_API_KEY=nvapi-... (get key: https://build.nvidia.com)
`);
  process.exit(0);
}

// Parse flags
let jdText = '';
let providerName = process.env.EVAL_PROVIDER || 'nvidia';
let modelOverride = null;
let saveReport = true;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    const filePath = args[++i];
    if (!existsSync(filePath)) { console.error(`❌  File not found: ${filePath}`); process.exit(1); }
    jdText = readFileSync(filePath, 'utf-8').trim();
  } else if (args[i] === '--provider' && args[i + 1]) {
    providerName = args[++i];
  } else if (args[i] === '--model' && args[i + 1]) {
    modelOverride = args[++i];
  } else if (args[i] === '--no-save') {
    saveReport = false;
  } else if (!args[i].startsWith('--')) {
    jdText += (jdText ? '\n' : '') + args[i];
  }
}

if (!jdText) {
  console.error('❌  No Job Description provided. Run with --help for usage.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Select provider — auto-fallback if key missing
// ---------------------------------------------------------------------------
let provider = PROVIDERS[providerName];
if (!provider) {
  console.error(`❌  Unknown provider "${providerName}". Use: groq | nvidia`);
  process.exit(1);
}

// Auto-fallback: if selected provider has no key, try the other
if (!provider.key()) {
  const other = providerName === 'groq' ? 'nvidia' : 'groq';
  if (PROVIDERS[other].key()) {
    console.warn(`⚠️  ${providerName.toUpperCase()}_API_KEY not set. Falling back to ${other.toUpperCase()}.`);
    provider = PROVIDERS[other];
    providerName = other;
  } else {
    console.error(`
❌  No API key found.

   Add at least ONE of these to bridge/.env:

     GROQ_API_KEY=gsk_...     → https://console.groq.com/keys (free)
     NVIDIA_API_KEY=nvapi-... → https://build.nvidia.com
`);
    process.exit(1);
  }
}

const modelName = modelOverride || provider.model;

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------
function readFile(path, label) {
  if (!existsSync(path)) {
    console.warn(`⚠️   ${label} not found at: ${path}`);
    return `[${label} not found — skipping]`;
  }
  return readFileSync(path, 'utf-8').trim();
}

function nextReportNumber() {
  if (!existsSync(PATHS.reports)) return '001';
  const files = readdirSync(PATHS.reports)
    .filter(f => /^\d{3}-/.test(f))
    .map(f => parseInt(f.slice(0, 3)))
    .filter(n => !isNaN(n));
  if (files.length === 0) return '001';
  return String(Math.max(...files) + 1).padStart(3, '0');
}

// ---------------------------------------------------------------------------
// Load context files (with per-provider char budget to stay within TPM)
// ---------------------------------------------------------------------------
console.log('\n📂  Loading context files...');

const MAX = provider.maxChars || 20000;
// Allocate: 35% shared, 35% oferta, 30% cv
const truncate = (text, limit) => text.length > limit ? text.slice(0, limit) + '\n...[truncated]' : text;

const sharedContext = truncate(readFile(PATHS.shared, 'modes/_shared.md'), Math.floor(MAX * 0.35));
const ofertaLogic   = truncate(readFile(PATHS.oferta, 'modes/oferta.md'), Math.floor(MAX * 0.35));
const cvContent     = truncate(readFile(PATHS.cv, 'cv.md'),               Math.floor(MAX * 0.30));

// ---------------------------------------------------------------------------
// Build system prompt (identical to gemini-eval — same evaluation quality)
// ---------------------------------------------------------------------------
const systemPrompt = `You are career-ops, an AI-powered job search assistant.
You evaluate job offers against the user's CV using a structured A-G scoring system.

Your evaluation methodology is defined below. Follow it exactly.

═══════════════════════════════════════════════════════
SYSTEM CONTEXT (_shared.md)
═══════════════════════════════════════════════════════
${sharedContext}

═══════════════════════════════════════════════════════
EVALUATION MODE (oferta.md)
═══════════════════════════════════════════════════════
${ofertaLogic}

═══════════════════════════════════════════════════════
CANDIDATE RESUME (cv.md)
═══════════════════════════════════════════════════════
${cvContent}

═══════════════════════════════════════════════════════
IMPORTANT OPERATING RULES FOR THIS CLI SESSION
═══════════════════════════════════════════════════════
1. You do NOT have access to WebSearch, Playwright, or file writing tools.
   - For Block D (Comp research): provide salary estimates based on your training data, clearly noted as estimates.
   - For Block G (Legitimacy): analyze the JD text only; skip URL/page freshness checks.
   - Post-evaluation file saving is handled by the script, not by you.
2. Generate Blocks A through G in full, in English, unless the JD is in another language.
3. At the very end, output a machine-readable summary block in this exact format:

---SCORE_SUMMARY---
COMPANY: <company name or "Unknown">
ROLE: <role title>
SCORE: <global score as decimal, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---
`;

// ---------------------------------------------------------------------------
// Call the API (OpenAI-compatible format — works for both Groq and NVIDIA)
// ---------------------------------------------------------------------------
console.log(`🤖  Calling ${provider.name}... this may take 30-60 seconds.\n`);

let evaluationText;
try {
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provider.key()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `JOB DESCRIPTION TO EVALUATE:\n\n${jdText}` },
      ],
      temperature: 0.4,
      max_tokens: 8192,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  evaluationText = data.choices?.[0]?.message?.content;

  if (!evaluationText) {
    throw new Error('Empty response from API — try again or switch provider.');
  }
} catch (err) {
  console.error('❌  API error:', err.message);
  if (err.message?.includes('401') || err.message?.includes('invalid_api_key')) {
    console.error(`    Check your ${providerName.toUpperCase()}_API_KEY in bridge/.env`);
  } else if (err.message?.includes('429') || err.message?.includes('rate')) {
    console.error('    Rate limit hit. Wait 60s and retry, or switch --provider.');
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Display evaluation
// ---------------------------------------------------------------------------
console.log('\n' + '═'.repeat(66));
console.log(`  CAREER-OPS EVALUATION — powered by ${provider.name}`);
console.log('═'.repeat(66) + '\n');
console.log(evaluationText);

// ---------------------------------------------------------------------------
// Parse score summary
// ---------------------------------------------------------------------------
const summaryMatch = evaluationText.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);

let company    = 'unknown';
let role       = 'unknown';
let score      = '?';
let archetype  = 'unknown';
let legitimacy = 'unknown';

if (summaryMatch) {
  const block = summaryMatch[1];
  const extract = (key) => {
    const m = block.match(new RegExp(`${key}:\\s*(.+)`));
    return m ? m[1].trim() : 'unknown';
  };
  company    = extract('COMPANY');
  role       = extract('ROLE');
  score      = extract('SCORE');
  archetype  = extract('ARCHETYPE');
  legitimacy = extract('LEGITIMACY');
}

// Machine-readable output (for bridge/routes/evaluate.mjs to parse)
process.stdout.write(`\nSCORE: ${score}\nCOMPANY: ${company}\nROLE: ${role}\nLEGITIMACY: ${legitimacy}\n`);

// ---------------------------------------------------------------------------
// Save report
// ---------------------------------------------------------------------------
if (saveReport) {
  try {
    if (!existsSync(PATHS.reports)) mkdirSync(PATHS.reports, { recursive: true });

    const num         = nextReportNumber();
    const today       = new Date().toISOString().split('T')[0];
    const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const filename    = `${num}-${companySlug}-${today}.md`;
    const reportPath  = join(PATHS.reports, filename);

    const reportContent = `# Evaluation: ${company} — ${role}

**Date:** ${today}
**Archetype:** ${archetype}
**Score:** ${score}/5
**Legitimacy:** ${legitimacy}
**PDF:** pending
**Tool:** ${provider.name} (${modelName})

---

${evaluationText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`;

    writeFileSync(reportPath, reportContent, 'utf-8');
    console.log(`\n✅  Report saved: reports/${filename}`);
    console.log(`\n📊  Add to tracker (data/applications.md):`);
    console.log(`    | ${num} | ${today} | ${company} | ${role} | ${score}/5 | Evaluated | ❌ | [${num}](reports/${filename}) |`);
  } catch (err) {
    console.warn(`⚠️   Could not save report: ${err.message}`);
  }
}

console.log('\n' + '─'.repeat(66));
console.log(`  Score: ${score}/5  |  Archetype: ${archetype}  |  Legitimacy: ${legitimacy}`);
console.log('─'.repeat(66) + '\n');
