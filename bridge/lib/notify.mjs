/**
 * bridge/lib/notify.mjs — Telegram notification helpers
 *
 * Wraps grammy Bot instance for sending structured messages.
 * Imported by orchestrator and agents.
 */

import { Bot, InlineKeyboard } from 'grammy';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) throw new Error('[notify] TELEGRAM_BOT_TOKEN not set');
if (!CHAT_ID)   throw new Error('[notify] TELEGRAM_CHAT_ID not set');

// Shared bot instance (used for send-only; full command handling in telegram-bot.mjs)
const bot = new Bot(BOT_TOKEN);

function escapeMarkdown(text) {
  // Escape MarkdownV2 special chars
  return String(text ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Send a job match card to the user.
 * Returns the Telegram message_id so we can later edit it.
 */
export async function sendMatchCard(job) {
  const {
    id: jobId, company, title, location, salary_raw, score, evaluation_json,
  } = job;

  const salaryStr = salary_raw ? ` · 💶 ${salary_raw}` : '';
  const matchSummary = evaluation_json?.match_summary ?? 'Strong profile overlap';
  const langBadge = job.language === 'de' ? ' 🇩🇪' : '';

  const keyboard = new InlineKeyboard()
    .text('✅ Prepare', `approve:${jobId}`)
    .text('⏭ Skip', `skip:${jobId}`)
    .text('🔍 JD', `jd:${jobId}`)
    .text('📊 Why', `why:${jobId}`);

  const text =
    `🏢 *${escapeMarkdown(company)} — ${escapeMarkdown(title)}*${escapeMarkdown(langBadge)}\n` +
    `📍 ${escapeMarkdown(location ?? 'Unknown')}${escapeMarkdown(salaryStr)} · ⭐ ${escapeMarkdown(score)}/5\n` +
    `_${escapeMarkdown(matchSummary)}_`;

  const msg = await bot.api.sendMessage(CHAT_ID, text, {
    parse_mode: 'MarkdownV2',
    reply_markup: keyboard,
  });
  return msg.message_id;
}

/**
 * Send review card with CV + cover letter + form screenshot.
 * Returns the Telegram message_id.
 */
export async function sendReviewCard({ jobId, appId, applicationRef, cvUrl, coverUrl, screenshotPath, fieldsCount, fieldsList, qaCount }) {
  const keyboard = new InlineKeyboard()
    .text('🚀 Submit', `submit:${jobId}`)
    .text('✏️ Edit', `edit:${jobId}`)
    .row()
    .text('👁 All answers', `answers:${jobId}`)
    .text('❌ Cancel', `cancel:${jobId}`);

  const coverLine = coverUrl ? `📎 cover\\-de\\.pdf\n` : '';

  const text =
    `📋 *Ready for review* \\#${escapeMarkdown(applicationRef)}\n\n` +
    `📎 cv\\.pdf\n${coverLine}` +
    `✅ ${escapeMarkdown(String(fieldsCount))} fields filled\n` +
    `💬 ${escapeMarkdown(String(qaCount))} custom Q&A\n\n` +
    `_Reply \`/edit ${escapeMarkdown(jobId)} field\\=value\` to patch any field_`;

  const msg = await bot.api.sendMessage(CHAT_ID, text, {
    parse_mode: 'MarkdownV2',
    reply_markup: keyboard,
  });
  return msg.message_id;
}

/**
 * Send a confirmation after successful submission.
 */
export async function sendConfirmation({ company, title, confirmationId, gsheetRow }) {
  const text =
    `✅ *Submitted to ${escapeMarkdown(company)}*\n` +
    `Role: ${escapeMarkdown(title)}\n` +
    (confirmationId ? `Confirmation: \`${escapeMarkdown(confirmationId)}\`\n` : '') +
    (gsheetRow ? `GSheet row ${escapeMarkdown(String(gsheetRow))}` : '');
  await bot.api.sendMessage(CHAT_ID, text, { parse_mode: 'MarkdownV2' });
}

/**
 * Send a simple text alert (errors, captcha, system status).
 */
export async function sendAlert(text, { silent = false } = {}) {
  await bot.api.sendMessage(CHAT_ID, text, {
    disable_notification: silent,
  });
}

/**
 * Send daily digest.
 */
export async function sendDailyDigest({ scanned, scored, pending, submitted, rejected }) {
  const now = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });
  await bot.api.sendMessage(CHAT_ID,
    `📊 *Daily Digest* — ${escapeMarkdown(now)}\n\n` +
    `🔍 Scanned: ${scanned}\n` +
    `⭐ Scored ≥ threshold: ${scored}\n` +
    `⏳ Pending your review: ${pending}\n` +
    `🚀 Submitted today: ${submitted}\n` +
    `❌ Rejected: ${rejected}`,
    { parse_mode: 'MarkdownV2' }
  );
}

/**
 * Send a screenshot as a photo.
 */
export async function sendScreenshot(screenshotBuffer, caption = '') {
  await bot.api.sendPhoto(CHAT_ID, new Uint8Array(screenshotBuffer), { caption });
}

/**
 * Send a document (CV PDF, cover letter).
 */
export async function sendDocument(fileBuffer, filename, caption = '') {
  await bot.api.sendDocument(
    CHAT_ID,
    new Uint8Array(fileBuffer),
    { caption },
    { filename }
  );
}

/**
 * Edit an existing message (update match card on status change).
 */
export async function editMessage(messageId, newText) {
  try {
    await bot.api.editMessageText(CHAT_ID, messageId, newText, { parse_mode: 'MarkdownV2' });
  } catch {
    // Message not found or not modified — safe to ignore
  }
}

export { bot };
