#!/usr/bin/env node
/**
 * agents/tailor.mjs — CV tailoring + cover letter + Q&A agent
 *
 * HTTP service on port 9001, runs on Oracle E2.1.Micro #1 (130.162.209.192)
 * pm2 start agents/tailor.mjs --name tailor
 *
 * On POST /tailor { jobId }:
 *   1. Reads cv.md + article-digest.md + JD
 *   2. Generates tailored CV PDF (1-page target, 1.5-page ceiling)
 *   3. Generates German cover letter if JD language = 'de' and portal requires it
 *   4. Pre-generates Q&A answers (cached by question hash)
 *   5. Uploads to Supabase Storage
 *   6. Triggers GitHub Actions filler workflow (dry-run)
 */

import 'dotenv/config';
import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

import {
  getJob, createApplication, updateJobStatus,
  getCachedAnswer, cacheAnswer, audit,
} from '../bridge/lib/db.mjs';
import { sendAlert } from '../bridge/lib/notify.mjs';
import { triggerFillerWorkflow } from './orchestrator.mjs';

const PORT = parseInt(process.env.TAILOR_PORT || '9001', 10);
const TAILOR_TOKEN = process.env.TAILOR_TOKEN || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const app = express();
app.use(express.json());

// ── Auth ──────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (req.path === '/healthz') return next();
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (TAILOR_TOKEN && token !== TAILOR_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ── LLM helper (same fallback chain as evaluator) ─────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callLLMOnce(systemPrompt, userPrompt) {
  const providers = [
    async () => {
      if (!GROQ_API_KEY) throw new Error('no groq key');
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], temperature: 0.4, max_tokens: 3000 }),
      });
      if (!r.ok) { const err = new Error(`Groq ${r.status}`); err.status = r.status; throw err; }
      return (await r.json()).choices[0].message.content;
    },
    async () => {
      if (!NVIDIA_API_KEY) throw new Error('no nvidia key');
      const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'meta/llama-3.3-70b-instruct', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], temperature: 0.4, max_tokens: 3000 }),
      });
      if (!r.ok) { const err = new Error(`NVIDIA ${r.status}`); err.status = r.status; throw err; }
      return (await r.json()).choices[0].message.content;
    },
  ];
  let lastErr;
  for (const p of providers) {
    try { return await p(); } catch (e) { lastErr = e; console.warn('[tailor]', e.message); }
  }
  throw lastErr || new Error('All LLM providers failed (Groq + NVIDIA)');
}

// Retry with exponential backoff on 429
async function callLLM(systemPrompt, userPrompt) {
  const maxAttempts = 5;
  let delay = 8000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callLLMOnce(systemPrompt, userPrompt);
    } catch (e) {
      const is429 = String(e.message).includes('429');
      if (!is429 || attempt === maxAttempts) throw e;
      console.warn(`[tailor] 429 — backing off ${delay}ms (attempt ${attempt}/${maxAttempts})`);
      await sleep(delay);
      delay *= 2;
    }
  }
  throw new Error('All LLM providers failed (Groq + NVIDIA)');
}

// ── CV tailoring ──────────────────────────────────────────────────────────────

async function tailorCV(job) {
  const cvMd = readFileSync(join(ROOT, 'cv.md'), 'utf-8');
  const digestPath = join(ROOT, 'article-digest.md');
  const digest = existsSync(digestPath) ? readFileSync(digestPath, 'utf-8') : '';

  const systemPrompt = `You are an expert CV writer specialising in the German tech job market.
Your task: rewrite the candidate's CV to maximally match the target job.

RULES:
- Output ONLY valid Markdown, same structure as the input CV
- Hard limit: fit within 1 page. If critical proof points for THIS job would be cut, extend to max 1.5 pages.
- Trim order: oldest experience bullets → secondary projects → soft-skill bullets → education detail
- Replace generic bullets with job-specific ones from the proof points bank
- NEVER invent metrics. Only use metrics from cv.md or article-digest.md
- Keep all personal info (name, contact, links) unchanged
- German JD → keep CV in English unless the candidate's profile is in German

## Candidate Proof Points Bank
${digest}`;

  const userPrompt = `## Target Job\nCompany: ${job.company}\nTitle: ${job.title}\nLocation: ${job.location}\nLanguage: ${job.language}\n\n## JD\n${job.jd_text?.slice(0, 3000) || 'Not available'}\n\n## Current CV\n${cvMd}`;

  return await callLLM(systemPrompt, userPrompt);
}

// ── Cover letter ──────────────────────────────────────────────────────────────

async function generateCoverLetter(job, tailoredCV) {
  const lang = job.language === 'de' ? 'German' : 'English';
  const modeFile = job.language === 'de' ? join(ROOT, 'modes/de/bewerben.md') : join(ROOT, 'modes/apply.md');
  const modePrompt = existsSync(modeFile) ? readFileSync(modeFile, 'utf-8') : '';

  const systemPrompt = `${modePrompt}\n\nWrite a concise, professional cover letter in ${lang} for the German job market.
- Max 3 paragraphs: hook (specific to company), value (top 2 matching proof points), close (call to action)
- No generic phrases like "I am applying for..."
- Mirror the JD's language and tone
- Output ONLY the letter body, no headers or metadata`;

  const userPrompt = `Job: ${job.title} at ${job.company} (${job.location})\n\nJD excerpt:\n${job.jd_text?.slice(0, 2000) || job.title}\n\nTailored CV summary:\n${tailoredCV.slice(0, 1500)}`;

  return await callLLM(systemPrompt, userPrompt);
}

// ── Q&A generation ────────────────────────────────────────────────────────────

async function generateAnswers(questions, job, tailoredCV) {
  const results = [];
  for (const q of questions) {
    let answer = await getCachedAnswer(q);
    if (!answer) {
      const systemPrompt = `You are answering job application questions for ${job.company}.
Use STAR+R format. Be concise (max 3 sentences). Use proof points from the CV.
Language: ${job.language === 'de' ? 'German' : 'English'}`;
      const userPrompt = `Question: ${q}\n\nCV context:\n${tailoredCV.slice(0, 1500)}`;
      answer = await callLLM(systemPrompt, userPrompt);
      await cacheAnswer(q, answer, job.language);
    }
    results.push({ question: q, answer });
  }
  return results;
}

// ── PDF generation using existing generate-pdf.mjs ───────────────────────────

async function generatePDF(tailoredCVMarkdown, jobId) {
  mkdirSync(join(ROOT, 'output'), { recursive: true });

  // generate-pdf.mjs expects HTML input, so wrap markdown in minimal HTML
  const htmlPath = join(ROOT, `output/${jobId}-cv.html`);
  const htmlContent = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><style>
body { font-family: 'Inter', system-ui, sans-serif; font-size: 11pt; line-height: 1.5; max-width: 210mm; margin: 0 auto; padding: 15mm; }
h1 { font-size: 18pt; margin-bottom: 4pt; } h2 { font-size: 13pt; border-bottom: 1px solid #333; margin-top: 12pt; }
ul { padding-left: 18pt; margin: 4pt 0; } li { margin-bottom: 2pt; }
</style></head><body>
${markdownToHtml(tailoredCVMarkdown)}
</body></html>`;
  writeFileSync(htmlPath, htmlContent, 'utf-8');

  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const exec = promisify(execFile);

  // generate-pdf.mjs uses positional args: <input.html> <output.pdf> [--format=a4]
  const pdfPath = join(ROOT, `output/${jobId}-cv.pdf`);
  await exec('node', [join(ROOT, 'generate-pdf.mjs'), htmlPath, pdfPath, '--format=a4'], {
    cwd: ROOT,
    env: { ...process.env },
    timeout: 60_000,
  });

  return pdfPath;
}

/** Minimal markdown→HTML converter for CV structure (headings, lists, bold, links) */
function markdownToHtml(md) {
  return md
    .split('\n')
    .map(line => {
      if (line.startsWith('# ')) return `<h1>${line.slice(2)}</h1>`;
      if (line.startsWith('## ')) return `<h2>${line.slice(3)}</h2>`;
      if (line.startsWith('### ')) return `<h3>${line.slice(4)}</h3>`;
      if (line.startsWith('- ') || line.startsWith('* ')) return `<li>${line.slice(2)}</li>`;
      if (line.trim() === '') return '<br>';
      return `<p>${line}</p>`;
    })
    .join('\n')
    .replace(/<br>\n(<li>)/g, '<ul>\n$1')
    .replace(/(<\/li>)\n(?!<li>)/g, '$1\n</ul>\n')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
}

// ── Supabase Storage upload ───────────────────────────────────────────────────

async function uploadToStorage(filePath, storageKey) {
  const { readFileSync: read } = await import('fs');
  const buf = read(filePath);
  const { data, error } = await supabase.storage
    .from('applications')
    .upload(storageKey, buf, { contentType: 'application/pdf', upsert: true });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  const { data: { publicUrl } } = supabase.storage.from('applications').getPublicUrl(storageKey);
  return publicUrl;
}

// ── Main route ────────────────────────────────────────────────────────────────

// Serial queue: process one job at a time to respect Groq TPM (12K/min on free tier)
const tailorQueue = [];
let tailorBusy = false;

async function processTailorJob({ jobId, questions }) {
  try {
    const job = await getJob(jobId);
    if (!job) throw new Error('Job not found');

    console.log(`[tailor] Starting tailoring for ${job.company} — ${job.title}`);
    await updateJobStatus(jobId, 'TAILORING');

    // 1. Tailor CV
    const tailoredCV = await tailorCV(job);

    // 2. Generate PDF
    let cvUrl = null;
    try {
      const pdfPath = await generatePDF(tailoredCV, jobId);
      cvUrl = await uploadToStorage(pdfPath, `${jobId}/cv.pdf`);
    } catch (err) {
      console.error('[tailor] PDF generation failed:', err.message);
      await sendAlert(`⚠️ PDF generation failed for ${job.company}: ${err.message}. Will use markdown fallback.`);
    }

    // 3. Generate cover letter
    const coverText = await generateCoverLetter(job, tailoredCV);
    let coverUrl = null;
    const coverPath = join(ROOT, `output/${jobId}-cover.txt`);
    writeFileSync(coverPath, coverText, 'utf-8');

    // 4. Generate Q&A answers for provided questions
    const qa = questions.length > 0 ? await generateAnswers(questions, job, tailoredCV) : [];

    // 5. Create application record in DB
    const appRecord = await createApplication({
      job_id: jobId,
      cv_url: cvUrl,
      cover_url: coverUrl,
      custom_qa: qa,
      fields_filled: {},
    });

    await audit('TAILORING_DONE', { jobId, applicationId: appRecord.id, payload: { cvUrl, qaCount: qa.length } });

    // 6. Trigger GitHub Actions filler (dry-run mode)
    await triggerFillerWorkflow(jobId, appRecord.id, { submit: false, cvUrl, coverText });

    console.log(`[tailor] Done for job ${jobId}. Triggering filler...`);
  } catch (err) {
    console.error('[tailor] Error:', err);
    await updateJobStatus(jobId, 'SCORED').catch(() => {}); // reset for retry
    await sendAlert(`❌ Tailor failed for job ${jobId}: ${err.message}`);
  }
}

async function pumpTailorQueue() {
  if (tailorBusy) return;
  tailorBusy = true;
  while (tailorQueue.length > 0) {
    const item = tailorQueue.shift();
    await processTailorJob(item);
    // Pacing: wait between jobs so Groq TPM resets
    if (tailorQueue.length > 0) await sleep(8000);
  }
  tailorBusy = false;
}

app.post('/tailor', async (req, res) => {
  const { jobId, questions = [] } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  tailorQueue.push({ jobId, questions });
  res.json({ ok: true, queued: true, queueSize: tailorQueue.length });
  setImmediate(pumpTailorQueue);
});

app.get('/queue-status', (_req, res) => {
  res.json({ queueSize: tailorQueue.length, processing: tailorBusy });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[tailor] Listening on port ${PORT}`);
});
