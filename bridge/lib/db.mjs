/**
 * bridge/lib/db.mjs — Supabase client wrapper
 * Single shared client instance for all agents.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('[db] SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in environment');
}

export const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ── Jobs ────────────────────────────────────────────────────────────────────

export async function upsertJob(job) {
  const { data, error } = await db
    .from('jobs')
    .upsert(job, { onConflict: 'url', ignoreDuplicates: false })
    .select()
    .single();
  if (error) throw new Error(`[db] upsertJob: ${error.message}`);
  return data;
}

export async function getJob(id) {
  const { data, error } = await db.from('jobs').select('*').eq('id', id).single();
  if (error) throw new Error(`[db] getJob: ${error.message}`);
  return data;
}

export async function updateJobStatus(id, status, extra = {}) {
  const { error } = await db
    .from('jobs')
    .update({ status, ...extra })
    .eq('id', id);
  if (error) throw new Error(`[db] updateJobStatus: ${error.message}`);
}

export async function getJobsByStatus(status) {
  const { data, error } = await db
    .from('jobs')
    .select('*')
    .eq('status', status)
    .order('score', { ascending: false });
  if (error) throw new Error(`[db] getJobsByStatus: ${error.message}`);
  return data;
}

export async function urlExists(url) {
  const { count, error } = await db
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .eq('url', url);
  if (error) throw new Error(`[db] urlExists: ${error.message}`);
  return count > 0;
}

// ── Applications ─────────────────────────────────────────────────────────────

export async function createApplication(app) {
  const { data, error } = await db
    .from('applications')
    .insert(app)
    .select()
    .single();
  if (error) throw new Error(`[db] createApplication: ${error.message}`);
  return data;
}

export async function updateApplication(id, fields) {
  const { error } = await db.from('applications').update(fields).eq('id', id);
  if (error) throw new Error(`[db] updateApplication: ${error.message}`);
}

export async function getApplicationForJob(jobId) {
  const { data, error } = await db
    .from('applications')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (error && error.code !== 'PGRST116') throw new Error(`[db] getApplicationForJob: ${error.message}`);
  return data ?? null;
}

// ── Q&A Cache ────────────────────────────────────────────────────────────────

import { createHash } from 'crypto';

export function hashQuestion(text) {
  return createHash('sha256').update(text.toLowerCase().trim()).digest('hex');
}

export async function getCachedAnswer(questionText) {
  const hash = hashQuestion(questionText);
  const { data } = await db
    .from('qa_answers')
    .select('answer_text')
    .eq('question_hash', hash)
    .single();
  return data?.answer_text ?? null;
}

export async function cacheAnswer(questionText, answerText, language = 'en') {
  const hash = hashQuestion(questionText);
  const { error } = await db.from('qa_answers').upsert({
    question_hash: hash,
    question_text: questionText,
    answer_text: answerText,
    language,
    used_count: 1,
    last_used_at: new Date().toISOString(),
  }, { onConflict: 'question_hash' });
  if (error) throw new Error(`[db] cacheAnswer: ${error.message}`);
}

// ── Selector cache ────────────────────────────────────────────────────────────

export async function getCachedSelector(domain, formHash, fieldName) {
  const { data } = await db
    .from('selector_cache')
    .select('selector')
    .eq('domain', domain)
    .eq('form_hash', formHash)
    .eq('field_name', fieldName)
    .single();
  return data?.selector ?? null;
}

export async function cacheSelector(domain, formHash, fieldName, selector) {
  const { error } = await db.from('selector_cache').upsert({
    domain, form_hash: formHash, field_name: fieldName, selector,
    last_used_at: new Date().toISOString(),
  }, { onConflict: 'domain,form_hash,field_name' });
  if (error) throw new Error(`[db] cacheSelector: ${error.message}`);
}

// ── Credentials ───────────────────────────────────────────────────────────────

export async function getCredentials(domain) {
  const { data } = await db
    .from('credentials')
    .select('*')
    .eq('domain', domain)
    .single();
  return data ?? null;
}

export async function upsertCredentials(domain, fields) {
  const { error } = await db.from('credentials').upsert(
    { domain, ...fields, updated_at: new Date().toISOString() },
    { onConflict: 'domain' }
  );
  if (error) throw new Error(`[db] upsertCredentials: ${error.message}`);
}

// ── System state ──────────────────────────────────────────────────────────────

export async function getSystemState() {
  const { data, error } = await db
    .from('system_state')
    .select('*')
    .eq('id', 1)
    .single();
  if (error) throw new Error(`[db] getSystemState: ${error.message}`);
  // Reset daily counter if date changed
  if (data.applies_today_date !== new Date().toISOString().slice(0, 10)) {
    await db.from('system_state').update({
      applies_today: 0,
      applies_today_date: new Date().toISOString().slice(0, 10),
    }).eq('id', 1);
    data.applies_today = 0;
  }
  return data;
}

export async function updateSystemState(fields) {
  const { error } = await db.from('system_state').update(fields).eq('id', 1);
  if (error) throw new Error(`[db] updateSystemState: ${error.message}`);
}

// ── Audit log ─────────────────────────────────────────────────────────────────

import { createHash as sha256hash } from 'crypto';

export async function audit(event, { jobId = null, applicationId = null, actor = 'system', payload = {} } = {}) {
  // Fetch last row hash for chain
  const { data: last } = await db
    .from('audit_log')
    .select('row_hash, seq')
    .order('seq', { ascending: false })
    .limit(1)
    .single();

  const prevHash = last?.row_hash ?? '0'.repeat(64);
  const ts = new Date().toISOString();
  const rawChain = `${(last?.seq ?? 0) + 1}|${jobId}|${event}|${ts}|${prevHash}`;
  const rowHash = sha256hash('sha256').update(rawChain).digest('hex');

  const { error } = await db.from('audit_log').insert({
    job_id: jobId,
    application_id: applicationId,
    event,
    actor,
    payload,
    prev_hash: prevHash,
    row_hash: rowHash,
    ts,
  });
  if (error) console.error(`[audit] Failed to write: ${error.message}`);
}

// ── Daily stats ───────────────────────────────────────────────────────────────

export async function getDailyStats() {
  const today = new Date().toISOString().slice(0, 10);
  const { data: scanned } = await db
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .gte('discovered_at', today);
  const { data: submitted } = await db
    .from('applications')
    .select('id', { count: 'exact', head: true })
    .gte('submitted_at', today);
  const { data: pending } = await db
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .in('status', ['PENDING_USER', 'TAILORING', 'READY_FOR_REVIEW', 'PENDING_SUBMIT']);
  return {
    scanned: scanned ?? 0,
    submitted: submitted ?? 0,
    pending: pending ?? 0,
  };
}
