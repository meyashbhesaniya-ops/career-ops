#!/usr/bin/env node
/**
 * agents/telegram-bot.mjs — grammy Telegram bot
 *
 * Runs on Oracle E2.1.Micro #0 alongside orchestrator.
 * pm2 start agents/telegram-bot.mjs --name telegram-bot
 *
 * Uses long-polling (no public HTTPS webhook needed for Micro).
 */

import 'dotenv/config';
import { Bot, InlineKeyboard, session } from 'grammy';
import {
  getJob, getJobsByStatus, updateJobStatus, getApplicationForJob,
  updateApplication, getSystemState, updateSystemState, getDailyStats,
} from '../bridge/lib/db.mjs';
import { Vault } from '../bridge/lib/vault.mjs';
import { sendAlert } from '../bridge/lib/notify.mjs';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = parseInt(process.env.TELEGRAM_CHAT_ID, 10);
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:9000';

if (!BOT_TOKEN) throw new Error('[bot] TELEGRAM_BOT_TOKEN not set');
if (!CHAT_ID) throw new Error('[bot] TELEGRAM_CHAT_ID not set');

const bot = new Bot(BOT_TOKEN);
const vault = new Vault();

// ── Security: only respond to owner chat_id ───────────────────────────────────

bot.use(async (ctx, next) => {
  if (ctx.chat?.id !== CHAT_ID) {
    await ctx.reply('Unauthorized.');
    return;
  }
  await next();
});

// ── /start ────────────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  await ctx.reply(
    '👋 *AutoApply Bot online*\n\n' +
    '`/status` — System status\n' +
    '`/stats` — Today\'s numbers\n' +
    '`/pending` — Jobs waiting for review\n' +
    '`/pause` — Pause all scanning\n' +
    '`/resume` — Resume scanning\n' +
    '`/scan` — Trigger scan now\n' +
    '`/threshold 4.2` — Set match score threshold\n' +
    '`/creds add domain` — Store portal credentials\n' +
    '`/vaults` — List stored credentials\n' +
    '`/approve <job_id>` — Approve a job for preparation\n' +
    '`/skip <job_id>` — Skip a job\n' +
    '`/submit <job_id>` — Submit after reviewing preview\n' +
    '`/edit <job_id> field=value` — Patch a filled field\n' +
    '`/answers <job_id>` — Show all Q&A for a job',
    { parse_mode: 'Markdown' }
  );
});

// ── /status ───────────────────────────────────────────────────────────────────

bot.command('status', async (ctx) => {
  const state = await getSystemState();
  const status = state.paused ? '⏸ PAUSED' : '▶️ RUNNING';
  await ctx.reply(
    `*System Status*\n\n` +
    `${status}\n` +
    `Score threshold: ${state.score_threshold}/5\n` +
    `Daily limit: ${state.applies_today}/${state.max_applies_per_day}\n` +
    `Last scout: ${state.last_scout_at ? new Date(state.last_scout_at).toLocaleString('de-DE') : 'never'}`,
    { parse_mode: 'Markdown' }
  );
});

// ── /stats ────────────────────────────────────────────────────────────────────

bot.command('stats', async (ctx) => {
  const stats = await getDailyStats();
  await ctx.reply(
    `*Today\'s Stats*\n\n` +
    `🔍 Scanned: ${stats.scanned}\n` +
    `⏳ Pending review: ${stats.pending}\n` +
    `🚀 Submitted: ${stats.submitted}`,
    { parse_mode: 'Markdown' }
  );
});

// ── /pending ──────────────────────────────────────────────────────────────────

bot.command('pending', async (ctx) => {
  const jobs = await getJobsByStatus('PENDING_USER');
  if (!jobs.length) {
    return ctx.reply('No jobs pending your review.');
  }
  for (const job of jobs.slice(0, 5)) {
    const keyboard = new InlineKeyboard()
      .text('✅ Prepare', `approve:${job.id}`)
      .text('⏭ Skip', `skip:${job.id}`);
    await ctx.reply(
      `*${job.company} — ${job.title}*\n` +
      `${job.location} · ⭐ ${job.score}/5\n` +
      `ID: \`${job.id.slice(0, 8)}\``,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  }
  if (jobs.length > 5) {
    await ctx.reply(`...and ${jobs.length - 5} more.`);
  }
});

// ── /pause & /resume ──────────────────────────────────────────────────────────

bot.command('pause', async (ctx) => {
  await updateSystemState({ paused: true });
  await ctx.reply('⏸ System paused. No new scans or applications will run.');
});

bot.command('resume', async (ctx) => {
  await updateSystemState({ paused: false });
  await ctx.reply('▶️ System resumed.');
});

// ── /scan ─────────────────────────────────────────────────────────────────────

bot.command('scan', async (ctx) => {
  await ctx.reply('🔍 Triggering manual scan...');
  try {
    const resp = await fetch(`${ORCHESTRATOR_URL}/cmd/scan`, { method: 'POST' });
    const body = await resp.json();
    if (body.ok) {
      await ctx.reply('Scan started. Results incoming shortly.');
    } else {
      await ctx.reply(`Scan error: ${body.error}`);
    }
  } catch (err) {
    await ctx.reply(`Failed to trigger scan: ${err.message}`);
  }
});

// ── /threshold ────────────────────────────────────────────────────────────────

bot.command('threshold', async (ctx) => {
  const val = parseFloat(ctx.match);
  if (isNaN(val) || val < 0 || val > 5) {
    return ctx.reply('Usage: /threshold 4.2 (value between 0 and 5)');
  }
  await updateSystemState({ score_threshold: val });
  await ctx.reply(`✅ Score threshold set to ${val}/5`);
});

// ── /approve ──────────────────────────────────────────────────────────────────

bot.command('approve', async (ctx) => {
  const jobId = ctx.match?.trim();
  if (!jobId) return ctx.reply('Usage: /approve <job_id>');
  await callOrchestrator('/cmd/approve', { jobId }, ctx);
});

// ── /skip ─────────────────────────────────────────────────────────────────────

bot.command('skip', async (ctx) => {
  const jobId = ctx.match?.trim();
  if (!jobId) return ctx.reply('Usage: /skip <job_id>');
  await callOrchestrator('/cmd/skip', { jobId }, ctx);
  await ctx.reply(`⏭ Job ${jobId.slice(0, 8)} skipped.`);
});

// ── /submit ───────────────────────────────────────────────────────────────────

bot.command('submit', async (ctx) => {
  const jobId = ctx.match?.trim();
  if (!jobId) return ctx.reply('Usage: /submit <job_id>');
  await callOrchestrator('/cmd/submit', { jobId }, ctx);
});

// ── /edit ─────────────────────────────────────────────────────────────────────

bot.command('edit', async (ctx) => {
  // Format: /edit <job_id> field=value
  const parts = ctx.match?.split(' ');
  if (!parts || parts.length < 2) {
    return ctx.reply('Usage: /edit <job_id> field=value');
  }
  const [jobId, ...rest] = parts;
  const raw = rest.join(' ');
  const eqIdx = raw.indexOf('=');
  if (eqIdx < 0) return ctx.reply('Usage: /edit <job_id> field=value');
  const field = raw.slice(0, eqIdx).trim();
  const value = raw.slice(eqIdx + 1).trim();

  const app_ = await getApplicationForJob(jobId);
  if (!app_) return ctx.reply('No application found for that job ID.');

  const fields = { ...(app_.fields_filled || {}), [field]: value };
  await updateApplication(app_.id, { fields_filled: fields });
  await ctx.reply(`✅ Field \`${field}\` updated to: ${value}`, { parse_mode: 'Markdown' });
});

// ── /answers ──────────────────────────────────────────────────────────────────

bot.command('answers', async (ctx) => {
  const jobId = ctx.match?.trim();
  if (!jobId) return ctx.reply('Usage: /answers <job_id>');
  const app_ = await getApplicationForJob(jobId);
  if (!app_) return ctx.reply('No application found.');
  const qa = app_.custom_qa || [];
  if (!qa.length) return ctx.reply('No custom Q&A for this job.');
  const text = qa.map((q, i) => `*Q${i + 1}:* ${q.question}\n*A:* ${q.answer}`).join('\n\n');
  await ctx.reply(text.slice(0, 4000), { parse_mode: 'Markdown' });
});

// ── /creds add ────────────────────────────────────────────────────────────────

bot.command('creds', async (ctx) => {
  const parts = ctx.match?.split(' ');
  const sub = parts?.[0];
  const domain = parts?.[1];

  if (sub === 'add' && domain) {
    // Start a guided DM conversation
    await ctx.reply(
      `🔐 Adding credentials for *${domain}*\n\nPlease send your email:`,
      { parse_mode: 'Markdown' }
    );
    // Store pending state in memory (simple approach for single-user bot)
    pendingCreds.set(CHAT_ID, { domain, step: 'email' });
    return;
  }

  if (sub === 'list') {
    const domains = await vault.listDomains();
    if (!domains.length) return ctx.reply('No credentials stored yet.');
    const text = domains.map(d => `• ${d.domain} (${d.login_ok ? '✅' : '❌'} last: ${d.last_login?.slice(0, 10) ?? 'never'})`).join('\n');
    return ctx.reply(`Stored credentials:\n${text}`);
  }

  await ctx.reply('Usage:\n`/creds add <domain>` — store credentials\n`/creds list` — list stored domains', { parse_mode: 'Markdown' });
});

// ── Credential collection state machine ──────────────────────────────────────

const pendingCreds = new Map(); // chatId → { domain, step, email? }

bot.on('message:text', async (ctx) => {
  const state_ = pendingCreds.get(ctx.chat.id);
  if (!state_) return; // not in a creds flow — ignore

  const text = ctx.message.text.trim();

  if (state_.step === 'email') {
    pendingCreds.set(ctx.chat.id, { ...state_, email: text, step: 'password' });
    await ctx.reply('Now send your password:');
    return;
  }

  if (state_.step === 'password') {
    pendingCreds.set(ctx.chat.id, { ...state_, password: text, step: 'otp' });
    await ctx.reply('OTP/TOTP seed? (send "skip" to skip):');
    return;
  }

  if (state_.step === 'otp') {
    const otpSeed = text.toLowerCase() === 'skip' ? null : text;
    const { domain, email, password } = state_;
    await vault.store(domain, { email, password, otpSeed });
    pendingCreds.delete(ctx.chat.id);
    // Delete the user's messages containing secrets from Telegram
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply(`✅ Credentials for *${domain}* stored securely.`, { parse_mode: 'Markdown' });
    return;
  }
});

// ── Inline button callbacks ───────────────────────────────────────────────────

bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
  const jobId = ctx.match[1];
  await ctx.answerCallbackQuery('⚙️ Preparing...');
  await callOrchestrator('/cmd/approve', { jobId }, ctx);
});

bot.callbackQuery(/^skip:(.+)$/, async (ctx) => {
  const jobId = ctx.match[1];
  await ctx.answerCallbackQuery('⏭ Skipped');
  await callOrchestrator('/cmd/skip', { jobId }, ctx);
});

bot.callbackQuery(/^submit:(.+)$/, async (ctx) => {
  const jobId = ctx.match[1];
  await ctx.answerCallbackQuery('🚀 Submitting...');
  await callOrchestrator('/cmd/submit', { jobId }, ctx);
});

bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
  const jobId = ctx.match[1];
  await ctx.answerCallbackQuery('❌ Cancelled');
  await updateJobStatus(jobId, 'SCORED');
  await ctx.reply('Application cancelled. Job returned to scored state.');
});

bot.callbackQuery(/^jd:(.+)$/, async (ctx) => {
  const jobId = ctx.match[1];
  const job = await getJob(jobId);
  await ctx.answerCallbackQuery();
  if (!job) return ctx.reply('Job not found.');
  await ctx.reply(`🔗 ${job.url}`);
});

bot.callbackQuery(/^why:(.+)$/, async (ctx) => {
  const jobId = ctx.match[1];
  const job = await getJob(jobId);
  await ctx.answerCallbackQuery();
  if (!job?.evaluation_json) return ctx.reply('No evaluation available.');
  const ev = job.evaluation_json;
  const text = [
    ev.block_a && `*A — Role Fit:* ${ev.block_a}`,
    ev.block_b && `*B — Tech Match:* ${ev.block_b}`,
    ev.block_c && `*C — Compensation:* ${ev.block_c}`,
    ev.block_d && `*D — Company:* ${ev.block_d}`,
    ev.block_e && `*E — Growth:* ${ev.block_e}`,
  ].filter(Boolean).join('\n\n');
  await ctx.reply(text.slice(0, 4000) || 'No details available.', { parse_mode: 'Markdown' });
});

bot.callbackQuery(/^answers:(.+)$/, async (ctx) => {
  const jobId = ctx.match[1];
  await ctx.answerCallbackQuery();
  const app_ = await getApplicationForJob(jobId);
  if (!app_?.custom_qa?.length) return ctx.reply('No custom Q&A.');
  const text = app_.custom_qa.map((q, i) => `*Q${i + 1}:* ${q.question}\n*A:* ${q.answer}`).join('\n\n');
  await ctx.reply(text.slice(0, 4000), { parse_mode: 'Markdown' });
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function callOrchestrator(path, body, ctx) {
  try {
    const resp = await fetch(`${ORCHESTRATOR_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      await ctx.reply(`Error: ${data.error || data.reason || 'unknown'}`);
    }
  } catch (err) {
    await ctx.reply(`Failed to reach orchestrator: ${err.message}`);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

bot.catch((err) => {
  console.error('[telegram-bot] Unhandled error:', err.message);
});

bot.start({ onStart: () => console.log('[telegram-bot] Bot started (long-poll)') });
