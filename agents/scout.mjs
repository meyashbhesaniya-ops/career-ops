#!/usr/bin/env node
/**
 * agents/scout.mjs — 24/7 job discovery worker
 *
 * Wraps existing scan.mjs logic as a cron worker.
 * Runs on Oracle E2.1.Micro #0.
 * pm2 start agents/scout.mjs --name scout
 *
 * Schedule: every 30 minutes via node-cron.
 * Also callable on-demand via POST /cmd/scan on orchestrator.
 */

import 'dotenv/config';
import cron from 'node-cron';
import express from 'express';
import { readFileSync, appendFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import {
  upsertJob, updateJobStatus, urlExists, getSystemState,
  updateSystemState, audit,
} from '../bridge/lib/db.mjs';
import { sendMatchCard, sendAlert } from '../bridge/lib/notify.mjs';

const PORTALS_PATH = new URL('../portals.yml', import.meta.url).pathname;
const SCAN_HISTORY_PATH = new URL('../data/scan-history.tsv', import.meta.url).pathname;
const FETCH_TIMEOUT_MS = 12_000;
const CONCURRENCY = 8;

// ── Load config ───────────────────────────────────────────────────────────────

function loadConfig() {
  return yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
}

// ── ATS API fetchers (reuse logic from scan.mjs) ──────────────────────────────

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function detectApi(company) {
  if (company.api?.includes('greenhouse')) return { type: 'greenhouse', url: company.api };
  const url = company.careers_url || '';
  const ashby = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashby) return { type: 'ashby', url: `https://api.ashbyhq.com/posting-api/job-board/${ashby[1]}?includeCompensation=true` };
  const lever = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (lever) return { type: 'lever', url: `https://api.lever.co/v0/postings/${lever[1]}` };
  const ghEu = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEu) return { type: 'greenhouse', url: `https://boards-api.greenhouse.io/v1/boards/${ghEu[1]}/jobs` };
  return null;
}

function parseJobs(type, json, company) {
  if (type === 'greenhouse') {
    return (json.jobs || []).map(j => ({
      title: j.title || '', url: j.absolute_url || '',
      company: company.name, location: j.location?.name || '',
      portal: 'greenhouse', external_id: String(j.id || ''),
    }));
  }
  if (type === 'ashby') {
    return (json.jobs || []).map(j => ({
      title: j.title || '', url: j.jobUrl || '',
      company: company.name, location: j.location || '',
      portal: 'ashby', external_id: j.id || '',
      salary_raw: j.compensation?.summary || null,
    }));
  }
  if (type === 'lever') {
    return (Array.isArray(json) ? json : []).map(j => ({
      title: j.text || '', url: j.hostedUrl || '',
      company: company.name, location: j.categories?.location || '',
      portal: 'lever', external_id: j.id || '',
    }));
  }
  return [];
}

// ── Title filter ──────────────────────────────────────────────────────────────

function matchesFilter(title, filters) {
  const t = title.toLowerCase();
  const { positive, negative, seniority_boost } = filters;
  const hasPositive = positive.some(k => t.includes(k.toLowerCase()));
  const hasNegative = negative.some(k => t.includes(k.toLowerCase()));
  return hasPositive && !hasNegative;
}

// ── Dedup via TSV history (local fallback, DB is primary) ─────────────────────

const seenUrls = new Set();

function loadHistory() {
  if (!existsSync(SCAN_HISTORY_PATH)) return;
  readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').forEach(line => {
    const url = line.split('\t')[0];
    if (url) seenUrls.add(url.trim());
  });
}

function markSeen(url) {
  seenUrls.add(url);
  appendFileSync(SCAN_HISTORY_PATH, `${url}\t${new Date().toISOString()}\n`);
}

// ── Language detection (basic) ────────────────────────────────────────────────

function detectLanguage(title, location) {
  const combined = `${title} ${location}`.toLowerCase();
  const deSignals = ['ingenieur', 'wissenschaftler', 'entwickler', 'leiter', 'teamleiter', 'ki-', 'künstliche'];
  return deSignals.some(s => combined.includes(s)) ? 'de' : 'en';
}

// ── Main scan function ────────────────────────────────────────────────────────

async function runScan() {
  const state = await getSystemState();
  if (state.paused) {
    console.log('[scout] System paused — skipping scan');
    return;
  }

  console.log(`[scout] Starting scan at ${new Date().toISOString()}`);
  const config = loadConfig();
  const companies = config.tracked_companies || config.companies || [];
  const filters = config.title_filter;

  let discovered = 0;
  let notified = 0;

  // Process in batches to respect concurrency
  for (let i = 0; i < companies.length; i += CONCURRENCY) {
    const batch = companies.slice(i, i + CONCURRENCY).filter(c => c.enabled !== false);
    await Promise.allSettled(batch.map(async (company) => {
      try {
        const api = detectApi(company);
        if (!api) return; // no supported API

        const json = await fetchWithTimeout(api.url);
        const rawJobs = parseJobs(api.type, json, company);
        const filtered = rawJobs.filter(j => j.url && matchesFilter(j.title, filters));

        for (const rawJob of filtered) {
          if (seenUrls.has(rawJob.url)) continue;
          const inDb = await urlExists(rawJob.url);
          if (inDb) { seenUrls.add(rawJob.url); continue; }

          const language = detectLanguage(rawJob.title, rawJob.location || '');
          const job = await upsertJob({
            portal: rawJob.portal,
            external_id: rawJob.external_id || null,
            url: rawJob.url,
            title: rawJob.title,
            company: rawJob.company,
            location: rawJob.location || '',
            salary_raw: rawJob.salary_raw || null,
            language,
            status: 'DISCOVERED',
          });

          markSeen(rawJob.url);
          discovered++;
          await audit('JOB_DISCOVERED', { jobId: job.id, payload: { portal: rawJob.portal, title: rawJob.title } });

          // Trigger evaluator inline (lightweight — just sends to evaluator endpoint)
          await triggerEvaluator(job.id).catch(err =>
            console.error(`[scout] Evaluator trigger failed for ${job.id}: ${err.message}`)
          );
        }
      } catch (err) {
        console.error(`[scout] Error scanning ${company.name}: ${err.message}`);
      }
    }));
  }

  await updateSystemState({ last_scout_at: new Date().toISOString() });
  console.log(`[scout] Done. Discovered: ${discovered} new jobs.`);
}

async function triggerEvaluator(jobId) {
  const evalUrl = process.env.EVALUATOR_URL || 'http://localhost:9002';
  await fetch(`${evalUrl}/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId }),
  });
}

// ── Cron schedule ─────────────────────────────────────────────────────────────

loadHistory();

// Every 30 minutes
cron.schedule('*/30 * * * *', async () => {
  try {
    await runScan();
  } catch (err) {
    console.error('[scout] Unhandled error:', err);
    await sendAlert(`⚠️ Scout error: ${err.message}`).catch(() => {});
  }
});

// Liveness recheck daily at 03:00 CET
cron.schedule('0 3 * * *', async () => {
  try {
    await runLivenessCheck();
  } catch (err) {
    console.error('[scout] Liveness check error:', err);
  }
});

// Daily digest at 20:00 CET
cron.schedule('0 20 * * *', async () => {
  try {
    const { sendDailyDigest } = await import('../bridge/lib/notify.mjs');
    const stats = await (await import('../bridge/lib/db.mjs')).getDailyStats();
    await sendDailyDigest({
      scanned: stats.scanned,
      scored: 0, // TODO: track
      pending: stats.pending,
      submitted: stats.submitted,
      rejected: 0,
    });
  } catch (err) {
    console.error('[scout] Daily digest error:', err);
  }
});

async function runLivenessCheck() {
  // Import and run liveness check on DISCOVERED/SCORED jobs older than 7 days
  const { db } = await import('../bridge/lib/db.mjs');
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: staleJobs } = await db
    .from('jobs')
    .select('id, url')
    .in('status', ['DISCOVERED', 'SCORED', 'PENDING_USER'])
    .lt('discovered_at', sevenDaysAgo);

  console.log(`[scout] Liveness: checking ${(staleJobs || []).length} stale jobs`);
  // Mark as DEAD (simplified — full liveness logic in check-liveness.mjs)
  for (const j of staleJobs || []) {
    await updateJobStatus(j.id, 'DEAD').catch(() => {});
  }
}

// Run immediately on startup
runScan().catch(err => console.error('[scout] Initial scan error:', err));

// ── HTTP endpoint for on-demand scan trigger ──────────────────────────────────

const SCOUT_PORT = parseInt(process.env.SCOUT_PORT || '9003', 10);
const scoutApp = express();
scoutApp.use(express.json());

scoutApp.get('/healthz', (_req, res) => res.json({ ok: true }));

scoutApp.post('/trigger', async (_req, res) => {
  try {
    res.json({ ok: true, message: 'Scan triggered' });
    // Run scan async after responding
    runScan().catch(err => console.error('[scout] On-demand scan error:', err));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

scoutApp.listen(SCOUT_PORT, '127.0.0.1', () => {
  console.log(`[scout] HTTP trigger listening on port ${SCOUT_PORT}`);
});

console.log('[scout] Worker started. Cron: every 30 min. Digest: 20:00 CET.');
