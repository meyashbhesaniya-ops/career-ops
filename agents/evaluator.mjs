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

// Load CV + profile for context
const CV_PATH = new URL('../cv.md', import.meta.url).pathname;
const PROFILE_PATH = new URL('../config/profile.yml', import.meta.url).pathname;
const OFERTA_MODE_PATH = new URL('../modes/oferta.md', import.meta.url).pathname;
const OFERTA_DE_PATH = new URL('../modes/de/angebot.md', import.meta.url).pathname;

let cvText = '';
let ofertaPrompt = '';
let ofertaDePrompt = '';

function reloadPrompts() {
  try {
    cvText = readFileSync(CV_PATH, 'utf-8');
    ofertaPrompt = readFileSync(OFERTA_MODE_PATH, 'utf-8');
    ofertaDePrompt = readFileSync(OFERTA_DE_PATH, 'utf-8');
  } catch (err) {
    console.error('[evaluator] Error loading prompts:', err.message);
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

// ── Evaluation ────────────────────────────────────────────────────────────────

async function evaluateJob(job) {
  const modePrompt = job.language === 'de' ? ofertaDePrompt : ofertaPrompt;
  const systemPrompt = `${modePrompt}\n\n## Candidate CV\n${cvText}`;
  const userPrompt = `## Job Description\n**Company:** ${job.company}\n**Title:** ${job.title}\n**Location:** ${job.location}\n**Salary:** ${job.salary_raw || 'Not specified'}\n\n${job.jd_text || 'No JD text available — evaluate from title and company only.'}`;

  const raw = await callLLM(systemPrompt, userPrompt);

  // Extract score from output — look for patterns like "Score: 4.2" or "**4.2**/5"
  const scoreMatch = raw.match(/(?:score|puntuacion|wertung|bewertung)[:\s*]*([0-9]\.[0-9])/i)
    || raw.match(/\b([0-9]\.[0-9])\/5\b/)
    || raw.match(/\*\*([0-9]\.[0-9])\*\*/);
  const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;

  // Extract match summary (first meaningful sentence after score)
  const summaryMatch = raw.match(/match[:\s]+(.+?)(?:\n|\.)/i)
    || raw.match(/summary[:\s]+(.+?)(?:\n|\.)/i);
  const match_summary = summaryMatch?.[1]?.trim() ?? 'See evaluation for details';

  return {
    score,
    evaluation_json: {
      raw_output: raw.slice(0, 3000),
      match_summary,
      model_used: 'multi-fallback',
      evaluated_at: new Date().toISOString(),
    },
  };
}

// ── Route: POST /evaluate ─────────────────────────────────────────────────────

app.post('/evaluate', async (req, res) => {
  const { jobId, jdText } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  res.json({ ok: true, queued: true }); // respond immediately, process async

  setImmediate(async () => {
    try {
      const job = await getJob(jobId);
      if (!job) return;

      // Optionally update JD text if provided (from extension scrape)
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
        await upsertJob({ ...updatedJob, telegram_msg_id: msgId });
      } else {
        await updateJobStatus(jobId, 'SCORED', { score, evaluation_json });
        await audit('JOB_SCORED_BELOW_THRESHOLD', { jobId, payload: { score, threshold: state.score_threshold } });
        console.log(`[evaluator] Job ${jobId} scored ${score} — below threshold ${state.score_threshold}, not notifying`);
      }
    } catch (err) {
      console.error(`[evaluator] Error evaluating ${jobId}:`, err);
      await updateJobStatus(jobId, 'DISCOVERED').catch(() => {}); // reset for retry
    }
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[evaluator] Listening on port ${PORT}`);
});
