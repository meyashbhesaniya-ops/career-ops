#!/usr/bin/env node
/**
 * agents/evaluator.mjs — Multi-model A-G job evaluator
 *
 * HTTP service on port 9002.
 * pm2 start agents/evaluator.mjs --name evaluator
 *
 * Model chain:
 *   Primary:   Groq Llama 3.3 70B (free, fast)
 *   Fallback:  NVIDIA NIM (free credits)
 */

import 'dotenv/config';
import express from 'express';
import { readFileSync } from 'fs';
import {
  getJob, updateJobStatus, upsertJob, getSystemState,
  audit,
} from '../bridge/lib/db.mjs';
import { sendMatchCard, sendAlert } from '../bridge/lib/notify.mjs';

const PORT = parseInt(process.env.EVALUATOR_PORT || '9002', 10);
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

// Load CV for context
const CV_PATH = new URL('../cv.md', import.meta.url).pathname;

let cvText = '';

function reloadPrompts() {
  try {
    cvText = readFileSync(CV_PATH, 'utf-8');
  } catch (err) {
    console.error('[evaluator] Error loading CV:', err.message);
  }
}
reloadPrompts();

const app = express();
app.use(express.json({ limit: '5mb' }));

// ── LLM Clients ───────────────────────────────────────────────────────────────

async function callGroq(systemPrompt, userPrompt) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      temperature: 0.3,
      max_tokens: 2048,
    }),
  });
  if (!resp.ok) throw new Error(`Groq: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.choices[0].message.content;
}

async function callNvidia(systemPrompt, userPrompt) {
  if (!NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY not set');
  const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'meta/llama-3.3-70b-instruct',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      temperature: 0.3,
      max_tokens: 2048,
    }),
  });
  if (!resp.ok) throw new Error(`NVIDIA: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.choices[0].message.content;
}

async function callLLM(systemPrompt, userPrompt) {
  const models = [
    { name: 'groq', fn: () => callGroq(systemPrompt, userPrompt) },
    { name: 'nvidia', fn: () => callNvidia(systemPrompt, userPrompt) },
  ];
  for (const model of models) {
    try {
      const result = await model.fn();
      console.log(`[evaluator] Used model: ${model.name}`);
      return result;
    } catch (err) {
      console.warn(`[evaluator] ${model.name} failed: ${err.message}`);
    }
  }
  throw new Error('All LLM providers failed');
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

const EVAL_DELAY_MS = 6000; // 6s between evaluations to respect Groq 12K TPM
let evalQueue = [];
let processing = false;

function enqueueEval(jobId, jdText) {
  evalQueue.push({ jobId, jdText });
  processQueue();
}

async function processQueue() {
  if (processing || evalQueue.length === 0) return;
  processing = true;
  while (evalQueue.length > 0) {
    const { jobId, jdText } = evalQueue.shift();
    try {
      await processEvaluation(jobId, jdText);
    } catch (err) {
      console.error(`[evaluator] Error evaluating ${jobId}:`, err.message);
      await updateJobStatus(jobId, 'DISCOVERED').catch(() => {});
    }
    if (evalQueue.length > 0) await sleep(EVAL_DELAY_MS);
  }
  processing = false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── LLM with retry ───────────────────────────────────────────────────────────

async function callLLMWithRetry(systemPrompt, userPrompt, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await callLLM(systemPrompt, userPrompt);
    } catch (err) {
      if (attempt < retries - 1 && err.message.includes('429')) {
        const delay = (attempt + 1) * 5000;
        console.log(`[evaluator] Rate limited, waiting ${delay}ms...`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

// ── Evaluation ────────────────────────────────────────────────────────────────

const EVAL_SYSTEM_PROMPT = `You are a job-match scoring engine. Given a candidate's CV and a job posting, output ONLY a JSON object with these fields:
- "score": number from 1.0 to 5.0 (1 decimal place). 5.0 = perfect match, 1.0 = no match.
- "summary": one sentence explaining the match quality
- "strengths": array of 1-3 matching strengths
- "gaps": array of 0-3 gaps or mismatches
- "recommendation": "apply" | "maybe" | "skip"

Scoring guide:
- 4.5-5.0: Near-perfect match — skills, seniority, domain all align
- 3.5-4.4: Good match — most requirements met, minor gaps
- 2.5-3.4: Partial match — significant gaps but some relevant experience
- 1.0-2.4: Poor match — different domain, wrong seniority, or unrelated skills

CRITICAL: Output ONLY valid JSON. No markdown, no explanation, no code fences.`;

async function evaluateJob(job) {
  const userPrompt = `## Candidate CV (summary)
${cvText.slice(0, 2000)}

## Job Posting
**Company:** ${job.company}
**Title:** ${job.title}
**Location:** ${job.location || 'Not specified'}
**Salary:** ${job.salary_raw || 'Not specified'}

${job.jd_text ? job.jd_text.slice(0, 2000) : 'No JD text — evaluate from title/company only.'}`;

  const raw = await callLLMWithRetry(EVAL_SYSTEM_PROMPT, userPrompt);

  // Parse JSON response
  let parsed;
  try {
    // Try to extract JSON from response (handle if LLM wraps in code fences)
    const jsonStr = raw.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    // Fallback: try to find JSON object in response
    const jsonMatch = raw.match(/\{[\s\S]*"score"[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch {}
    }
  }

  if (parsed && typeof parsed.score === 'number') {
    const score = Math.round(parsed.score * 10) / 10; // ensure 1 decimal
    return {
      score: Math.min(5.0, Math.max(1.0, score)),
      evaluation_json: {
        ...parsed,
        raw_output: raw.slice(0, 1500),
        model_used: 'multi-fallback',
        evaluated_at: new Date().toISOString(),
      },
    };
  }

  // Last resort: regex extraction
  const scoreMatch = raw.match(/["']?score["']?\s*[:=]\s*([0-9]\.[0-9])/i)
    || raw.match(/\b([0-9]\.[0-9])\/5\b/)
    || raw.match(/\b([4-5]\.[0-9])\b/);
  const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;

  return {
    score,
    evaluation_json: {
      raw_output: raw.slice(0, 1500),
      match_summary: parsed?.summary || 'Could not parse structured response',
      model_used: 'multi-fallback',
      evaluated_at: new Date().toISOString(),
    },
  };
}

// ── Process single evaluation ─────────────────────────────────────────────────

async function processEvaluation(jobId, jdText) {
  const job = await getJob(jobId);
  if (!job) return;

  if (jdText) {
    await upsertJob({ ...job, jd_text: jdText });
    job.jd_text = jdText;
  }

  const { score, evaluation_json } = await evaluateJob(job);

  if (!score) {
    console.warn(`[evaluator] Could not parse score for ${jobId}`);
    await updateJobStatus(jobId, 'SCORED', { evaluation_json, score: 0 });
    return;
  }

  const state = await getSystemState();
  if (score >= state.score_threshold) {
    await updateJobStatus(jobId, 'PENDING_USER', { score, evaluation_json });
    await audit('JOB_SCORED', { jobId, payload: { score } });

    // Send match card to Telegram
    const updatedJob = { ...job, score, evaluation_json };
    const msgId = await sendMatchCard(updatedJob);
    if (msgId) await upsertJob({ ...updatedJob, telegram_msg_id: msgId });
    console.log(`[evaluator] Job ${jobId} scored ${score} ✅ → PENDING_USER (notified)`);
  } else {
    await updateJobStatus(jobId, 'SCORED', { score, evaluation_json });
    console.log(`[evaluator] Job ${jobId} scored ${score} — below ${state.score_threshold}`);
  }
}

// ── Route: POST /evaluate ─────────────────────────────────────────────────────

app.post('/evaluate', async (req, res) => {
  const { jobId, jdText } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  enqueueEval(jobId, jdText);
  res.json({ ok: true, queued: true, queueSize: evalQueue.length });
});

// ── Route: POST /re-evaluate — re-queue all zero-score jobs ───────────────────

app.post('/re-evaluate', async (req, res) => {
  const { limit = 50 } = req.body || {};
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: jobs, error } = await supabase
      .from('jobs')
      .select('id')
      .or('status.eq.DISCOVERED,and(status.eq.SCORED,score.eq.0)')
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });
    for (const j of jobs) enqueueEval(j.id, null);
    res.json({ ok: true, queued: jobs.length, total_queue: evalQueue.length });
    console.log(`[evaluator] Re-evaluate: queued ${jobs.length} jobs`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Route: GET /queue-status ──────────────────────────────────────────────────

app.get('/queue-status', (_req, res) => {
  res.json({ queueSize: evalQueue.length, processing });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, queueSize: evalQueue.length }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[evaluator] Listening on port ${PORT}`);
});
