#!/usr/bin/env node
/**
 * agents/orchestrator.mjs — Job state machine & agent router
 *
 * Runs on Oracle E2.1.Micro #0 (89.168.115.96)
 * Managed by pm2: pm2 start agents/orchestrator.mjs --name orchestrator
 *
 * Responsibilities:
 *  - Exposes HTTP endpoints consumed by GitHub Actions filler workflow
 *  - Drives job state transitions
 *  - Triggers GitHub Actions filler via repository_dispatch
 *  - /healthz endpoint for Cloudflare Workers watchdog
 */

import 'dotenv/config';
import express from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  getJob, updateJobStatus, getJobsByStatus,
  getApplicationForJob, updateApplication, createApplication,
  getSystemState, updateSystemState, audit, getDailyStats,
} from '../bridge/lib/db.mjs';
import { sendAlert, sendReviewCard, sendConfirmation, sendScreenshot, sendDocument } from '../bridge/lib/notify.mjs';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const PORT = parseInt(process.env.ORCHESTRATOR_PORT || '9000', 10);
const GITHUB_PAT = process.env.GITHUB_PAT;
const GITHUB_REPO = process.env.GITHUB_REPO || 'santifer/career-ops';
const GH_WEBHOOK_SECRET = process.env.GH_WEBHOOK_SECRET || '';

const app = express();
app.use(express.json({ limit: '20mb' }));

// ── Security middleware ───────────────────────────────────────────────────────

function verifyGHSignature(req, res, next) {
  const sig = req.headers['x-hub-signature-256'];
  if (!GH_WEBHOOK_SECRET || !sig) return next(); // open if no secret set
  const expected = 'sha256=' + createHmac('sha256', GH_WEBHOOK_SECRET)
    .update(JSON.stringify(req.body)).digest('hex');
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  next();
}

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── Filler callback endpoints (called by GitHub Actions) ──────────────────────

/**
 * POST /filler/preview
 * GitHub Actions sends dry-run results: screenshots, filled fields, Q&A.
 */
app.post('/filler/preview', verifyGHSignature, async (req, res) => {
  const { jobId, appId, fieldsCount, fieldsList, qaCount, screenshotBase64s, cvUrl, coverUrl } = req.body;
  try {
    const job = await getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Update application with fill data
    await updateApplication(appId, {
      fields_filled: fieldsList,
      custom_qa: qaCount > 0 ? req.body.qa : [],
    });
    await updateJobStatus(jobId, 'READY_FOR_REVIEW');
    await audit('FILL_PREVIEW_READY', { jobId, payload: { fieldsCount, qaCount } });

    // Send screenshots to Telegram
    for (const b64 of (screenshotBase64s || []).slice(0, 3)) {
      const buf = Buffer.from(b64, 'base64');
      await sendScreenshot(buf, `Form preview — ${job.company} (${job.title})`);
    }

    // Send review card
    await sendReviewCard({
      jobId,
      appId,
      applicationRef: appId.slice(0, 8).toUpperCase(),
      cvUrl,
      coverUrl,
      fieldsCount,
      fieldsList: fieldsList || {},
      qaCount: qaCount || 0,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[orchestrator] /filler/preview error:', err);
    await sendAlert(`⚠️ Filler preview error for job ${jobId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /filler/done
 * GitHub Actions sends final submission result.
 */
app.post('/filler/done', verifyGHSignature, async (req, res) => {
  const { jobId, appId, success, confirmationId, error: fillError } = req.body;
  try {
    const job = await getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (success) {
      await updateJobStatus(jobId, 'CONFIRMED');
      await updateApplication(appId, {
        submitted_at: new Date().toISOString(),
        confirmed_at: new Date().toISOString(),
        portal_response: confirmationId || 'submitted',
      });
      await audit('SUBMITTED', { jobId, applicationId: appId, payload: { confirmationId } });

      // Update daily counter
      const state = await getSystemState();
      await updateSystemState({ applies_today: (state.applies_today || 0) + 1 });

      await sendConfirmation({
        company: job.company,
        title: job.title,
        confirmationId,
        gsheetRow: null, // GSheet sync fills this
      });
    } else {
      await updateJobStatus(jobId, 'FAILED');
      await audit('SUBMIT_FAILED', { jobId, applicationId: appId, payload: { error: fillError } });
      await sendAlert(`❌ Submit FAILED for ${job.company} — ${job.title}\n${fillError}`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[orchestrator] /filler/done error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /filler/captcha
 * Filler detected a captcha — notify user.
 */
app.post('/filler/captcha', verifyGHSignature, async (req, res) => {
  const { jobId, screenshotBase64, manualUrl } = req.body;
  const job = await getJob(jobId).catch(() => null);
  const label = job ? `${job.company} — ${job.title}` : jobId;
  await sendAlert(
    `🤖 CAPTCHA detected for ${label}\n` +
    `Solve manually: ${manualUrl || job?.url || '(no URL)'}\n` +
    `Then reply /resume ${jobId}`
  );
  if (screenshotBase64) {
    await sendScreenshot(Buffer.from(screenshotBase64, 'base64'), 'Captcha screenshot');
  }
  await updateJobStatus(jobId, 'FAILED');
  res.json({ ok: true });
});

// ── User commands from Telegram bot (internal IPC) ────────────────────────────

/**
 * POST /cmd/scan
 * Trigger an on-demand scan via scout agent.
 */
app.post('/cmd/scan', async (req, res) => {
  try {
    const scoutUrl = process.env.SCOUT_URL || 'http://127.0.0.1:9003';
    const resp = await fetch(`${scoutUrl}/trigger`, { method: 'POST' });
    const body = await resp.json();
    res.json(body);
  } catch (err) {
    console.error('[orchestrator] /cmd/scan error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /cmd/pause
 * Pause all scanning and auto-applications.
 */
app.post('/cmd/pause', async (req, res) => {
  try {
    await updateSystemState({ paused: true });
    await audit('SYSTEM_PAUSED', { actor: 'user' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /cmd/resume
 * Resume scanning and auto-applications.
 */
app.post('/cmd/resume', async (req, res) => {
  try {
    await updateSystemState({ paused: false });
    await audit('SYSTEM_RESUMED', { actor: 'user' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /cmd/approve  { jobId }
 * Called by telegram-bot when user taps ✅ Prepare
 */
app.post('/cmd/approve', async (req, res) => {
  const { jobId } = req.body;
  try {
    const state = await getSystemState();
    if (state.paused) {
      await sendAlert('⏸ System is paused. Send /resume to continue.');
      return res.json({ ok: false, reason: 'paused' });
    }

    // Rate limit check
    const appliesLeft = state.max_applies_per_day - (state.applies_today || 0);
    if (appliesLeft <= 0) {
      await sendAlert(`🚫 Daily apply limit (${state.max_applies_per_day}) reached. Resets tomorrow.`);
      return res.json({ ok: false, reason: 'rate_limit' });
    }

    await updateJobStatus(jobId, 'TAILORING');
    await audit('USER_APPROVED', { jobId, actor: 'user' });

    // Trigger tailor agent (running on Micro #1 via HTTP)
    const tailorUrl = process.env.TAILOR_URL || 'http://130.162.209.192:9001';
    await fetch(`${tailorUrl}/tailor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.TAILOR_TOKEN}` },
      body: JSON.stringify({ jobId }),
    });

    await sendAlert(`⚙️ Preparing application for job ${jobId.slice(0, 8)}... (~30s)`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[orchestrator] /cmd/approve error:', err);
    await updateJobStatus(jobId, 'SCORED').catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /cmd/submit  { jobId }
 * Called by telegram-bot when user taps 🚀 Submit
 */
app.post('/cmd/submit', async (req, res) => {
  const { jobId } = req.body;
  try {
    const job = await getJob(jobId);
    if (!job || job.status !== 'READY_FOR_REVIEW') {
      return res.status(400).json({ error: 'Job not in READY_FOR_REVIEW state' });
    }
    const app_ = await getApplicationForJob(jobId);
    if (!app_) return res.status(404).json({ error: 'No application found for job' });

    // Pre-submit invariants
    const approvedAt = app_.approval_ts ? new Date(app_.approval_ts) : null;
    const minsAgo = approvedAt ? (Date.now() - approvedAt.getTime()) / 60000 : Infinity;
    if (minsAgo > 60) {
      await sendAlert('⏰ Approval expired (>60 min). Tap ✅ Prepare again.');
      return res.status(400).json({ error: 'Approval expired' });
    }

    await updateJobStatus(jobId, 'PENDING_SUBMIT');
    await updateApplication(app_.id, {
      approved_by_user: true,
      approval_ts: new Date().toISOString(),
    });
    await audit('USER_SUBMIT_REQUESTED', { jobId, applicationId: app_.id, actor: 'user' });

    // Trigger GitHub Actions filler in submit mode
    await triggerFillerWorkflow(jobId, app_.id, { submit: true });

    await sendAlert(`⏳ Submitting application to ${job.company}...`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[orchestrator] /cmd/submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /cmd/skip  { jobId }
 */
app.post('/cmd/skip', async (req, res) => {
  const { jobId } = req.body;
  await updateJobStatus(jobId, 'SKIPPED');
  await audit('USER_SKIPPED', { jobId, actor: 'user' });
  res.json({ ok: true });
});

// ── GitHub Actions trigger ────────────────────────────────────────────────────

async function triggerFillerWorkflow(jobId, appId, extra = {}) {
  if (!GITHUB_PAT) throw new Error('GITHUB_PAT not set — cannot trigger GitHub Actions');
  const resp = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_PAT}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        event_type: 'filler-trigger',
        client_payload: { jobId, appId, ...extra },
      }),
    }
  );
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub Actions dispatch failed: ${resp.status} ${body}`);
  }
}

export { triggerFillerWorkflow };

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[orchestrator] Listening on port ${PORT}`);
});

export default app;
