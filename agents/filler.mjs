#!/usr/bin/env node
/**
 * agents/filler.mjs — Headless Playwright form filler
 *
 * Runs inside GitHub Actions (7GB RAM Ubuntu runner).
 * Triggered by repository_dispatch event from orchestrator.
 *
 * Modes:
 *   SUBMIT_MODE=false  → dry-run: fill all fields, screenshot, report to orchestrator
 *   SUBMIT_MODE=true   → submit: re-fill (or restore session), click submit, capture confirmation
 *
 * Port mapping for 3-tier strategy:
 *   Tier 1: Static selectors from extension/content/portal-selectors.js (ported to Node)
 *   Tier 2: DB selector cache (domain + form hash)
 *   Tier 3: LLM text inference (Groq/NVIDIA) from field labels + profile
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import { createHash } from 'crypto';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import {
  getJob, getApplicationForJob, updateApplication, updateJobStatus,
  getCachedSelector, cacheSelector, audit,
} from '../bridge/lib/db.mjs';
import { Vault } from '../bridge/lib/vault.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCREENSHOTS_DIR = join(ROOT, 'output/screenshots');
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const JOB_ID = process.env.JOB_ID;
const APP_ID = process.env.APP_ID;
const SUBMIT_MODE = process.env.SUBMIT_MODE === 'true';
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL;
const ORCHESTRATOR_TOKEN = process.env.ORCHESTRATOR_TOKEN || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

const vault = new Vault();

if (!JOB_ID || !APP_ID) {
  console.error('[filler] JOB_ID and APP_ID required');
  process.exit(1);
}

// ── Profile data ──────────────────────────────────────────────────────────────

function loadProfile() {
  const profileYml = readFileSync(join(ROOT, 'config/profile.yml'), 'utf-8');
  const profile = yaml.load(profileYml);
  const c = profile.candidate || {};
  return {
    first_name: c.full_name?.split(' ')[0] ?? '',
    last_name: c.full_name?.split(' ').slice(1).join(' ') ?? '',
    full_name: c.full_name ?? '',
    email: c.email ?? '',
    phone: c.phone ?? '',
    location: c.location ?? '',
    linkedin: c.linkedin ?? '',
    github: c.github ?? '',
    portfolio_url: c.portfolio_url ?? '',
    salary_expectation: profile.compensation?.target_range ?? '',
    notice_period: profile.notice_period ?? '',
    visa_status: profile.location?.visa_status ?? '',
    headline: profile.narrative?.headline ?? '',
  };
}

// ── Tier 1: Static selectors (ported from extension/content/portal-selectors.js) ──

const PORTAL_SELECTORS = {
  greenhouse: {
    match: (url) => /greenhouse\.io/i.test(url),
    fields: {
      first_name: ['#first_name', 'input[name="job_application[first_name]"]', 'input[autocomplete="given-name"]'],
      last_name: ['#last_name', 'input[name="job_application[last_name]"]', 'input[autocomplete="family-name"]'],
      email: ['#email', 'input[name="job_application[email]"]', 'input[autocomplete="email"]'],
      phone: ['#phone', 'input[name="job_application[phone]"]', 'input[autocomplete="tel"]'],
      linkedin: ['input[name*="linkedin" i]', 'input[id*="linkedin" i]'],
      github: ['input[name*="github" i]', 'input[id*="github" i]'],
      location: ['input[name*="location" i]', 'input[autocomplete="address-level2"]'],
      resume_upload: ['input[type="file"][name*="resume" i]', 'input[type="file"][id*="resume" i]'],
    },
  },
  lever: {
    match: (url) => /jobs\.lever\.co/i.test(url),
    fields: {
      full_name: ['input[name="name"]', '#name'],
      email: ['input[name="email"]', '#email', 'input[autocomplete="email"]'],
      phone: ['input[name="phone"]', '#phone'],
      org: ['input[name="org"]', 'input[placeholder*="company" i]'],
      linkedin: ['input[name="urls[LinkedIn]"]', 'input[id*="linkedin" i]'],
      github: ['input[name="urls[GitHub]"]', 'input[id*="github" i]'],
      resume_upload: ['input[type="file"]'],
    },
  },
  ashby: {
    match: (url) => /jobs\.ashbyhq\.com/i.test(url),
    fields: {
      first_name: ['input[name="firstName"]', 'input[id*="firstName" i]', 'input[autocomplete="given-name"]'],
      last_name: ['input[name="lastName"]', 'input[id*="lastName" i]', 'input[autocomplete="family-name"]'],
      email: ['input[name="email"]', 'input[type="email"]'],
      phone: ['input[name="phone"]', 'input[type="tel"]'],
      linkedin: ['input[name*="linkedin" i]'],
      resume_upload: ['input[type="file"]'],
    },
  },
  workday: {
    match: (url) => /myworkdayjobs\.com|wd\d+\.myworkday\.com/i.test(url),
    fields: {
      first_name: ['input[data-automation-id="legalNameSection_firstName"]', 'input[aria-label*="First Name" i]'],
      last_name: ['input[data-automation-id="legalNameSection_lastName"]', 'input[aria-label*="Last Name" i]'],
      email: ['input[data-automation-id="email"]', 'input[type="email"]'],
      phone: ['input[data-automation-id="phone-number"]', 'input[type="tel"]'],
      address: ['input[data-automation-id="addressSection_addressLine1"]'],
      resume_upload: ['input[type="file"]', 'div[data-automation-id="file-upload-drop-zone"]'],
    },
  },
  personio: {
    match: (url) => /personio\.(de|com)\/job-listings/i.test(url),
    fields: {
      first_name: ['input[name="first_name"]', 'input[placeholder*="Vorname" i]'],
      last_name: ['input[name="last_name"]', 'input[placeholder*="Nachname" i]'],
      email: ['input[name="email"]', 'input[type="email"]'],
      phone: ['input[name="phone"]', 'input[placeholder*="Telefon" i]'],
      resume_upload: ['input[type="file"]'],
    },
  },
  smartrecruiters: {
    match: (url) => /jobs\.smartrecruiters\.com/i.test(url),
    fields: {
      first_name: ['input[id="firstName"]', 'input[name="firstName"]'],
      last_name: ['input[id="lastName"]', 'input[name="lastName"]'],
      email: ['input[id="email"]', 'input[type="email"]'],
      phone: ['input[id="phoneNumber"]', 'input[type="tel"]'],
      resume_upload: ['input[type="file"]'],
    },
  },
};

// Generic field pattern matching (for unknown portals)
const GENERIC_PATTERNS = [
  { kind: 'first_name', patterns: [/first.?name/i, /vorname/i, /given.?name/i] },
  { kind: 'last_name', patterns: [/last.?name/i, /nachname/i, /family.?name/i, /surname/i] },
  { kind: 'full_name', patterns: [/full.?name/i, /your.?name/i, /^name$/i] },
  { kind: 'email', patterns: [/e.?mail/i] },
  { kind: 'phone', patterns: [/phone/i, /telefon/i, /mobile/i, /handy/i, /tel\b/i] },
  { kind: 'linkedin', patterns: [/linkedin/i] },
  { kind: 'github', patterns: [/github/i] },
  { kind: 'location', patterns: [/location/i, /city/i, /stadt/i, /wohnort/i] },
  { kind: 'salary_expectation', patterns: [/salary/i, /gehalt/i, /compensation/i, /vergütung/i] },
  { kind: 'notice_period', patterns: [/notice.?period/i, /kündigungsfrist/i, /available/i, /availability/i] },
  { kind: 'visa_status', patterns: [/visa/i, /work.?permit/i, /authorization/i, /aufenthaltstitel/i] },
];

// ── Main filler logic ──────────────────────────────────────────────────────────

async function run() {
  const job = await getJob(JOB_ID);
  if (!job) throw new Error(`Job ${JOB_ID} not found`);
  const app_ = await getApplicationForJob(JOB_ID);
  if (!app_) throw new Error(`Application ${APP_ID} not found`);

  const profile = loadProfile();
  const domain = new URL(job.url).hostname;

  // ── Launch browser ──────────────────────────────────────────────────────────
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  try {
    // ── Try cookie login first ─────────────────────────────────────────────────
    const creds = await vault.get(domain).catch(() => null);
    if (creds?.cookies) {
      await context.addCookies(creds.cookies);
      console.log(`[filler] Loaded cached cookies for ${domain}`);
    }

    const page = await context.newPage();

    // ── Captcha detection hook ─────────────────────────────────────────────────
    page.on('response', async (resp) => {
      if (resp.url().includes('captcha') || resp.url().includes('challenge')) {
        const screenshot = await page.screenshot();
        await reportCaptcha(JOB_ID, screenshot, job.url);
        await browser.close();
        process.exit(0); // handled
      }
    });

    await page.goto(job.url, { waitUntil: 'networkidle', timeout: 30_000 });

    // Check for captcha in page content
    const bodyText = await page.textContent('body').catch(() => '');
    if (/captcha|robot|challenge|human verification/i.test(bodyText)) {
      const screenshot = await page.screenshot();
      await reportCaptcha(JOB_ID, screenshot, job.url);
      await browser.close();
      return;
    }

    await page.waitForTimeout(2000); // let dynamic forms settle

    // ── Identify portal ────────────────────────────────────────────────────────
    const url = page.url();
    const portal = Object.entries(PORTAL_SELECTORS).find(([, p]) => p.match(url));
    const portalName = portal?.[0] ?? 'generic';
    const portalFields = portal?.[1]?.fields ?? {};
    console.log(`[filler] Portal detected: ${portalName}`);

    // ── Collect all form inputs ─────────────────────────────────────────────────
    const inputs = await page.$$('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');

    const filled = {};
    const unfilled = [];
    const cvUploadDone = { done: false };
    const questions = []; // custom questions found

    // ── Fill each field ────────────────────────────────────────────────────────
    for (const input of inputs) {
      const inputType = await input.getAttribute('type') ?? 'text';
      const inputName = (await input.getAttribute('name') ?? '').toLowerCase();
      const inputId = (await input.getAttribute('id') ?? '').toLowerCase();
      const placeholder = (await input.getAttribute('placeholder') ?? '').toLowerCase();
      const label = await getLabel(page, input);

      // File upload — CV
      if (inputType === 'file' && !cvUploadDone.done && app_.cv_url) {
        try {
          const cvPath = join(ROOT, `output/${JOB_ID}-cv.pdf`);
          if (existsSync(cvPath)) {
            await input.setInputFiles(cvPath);
            cvUploadDone.done = true;
            filled['resume_upload'] = cvPath;
            console.log('[filler] CV uploaded');
          }
        } catch (err) {
          console.warn('[filler] CV upload failed:', err.message);
        }
        continue;
      }

      if (inputType === 'file') continue; // skip other file inputs

      // Identify field kind
      const kind = identifyFieldKind(inputName, inputId, placeholder, label, portalFields, domain, url);
      if (!kind) {
        // Collect as potential custom question
        if (label && label.length > 5 && label.length < 500) {
          questions.push(label);
        }
        unfilled.push({ input, label });
        continue;
      }

      const value = profile[kind];
      if (value) {
        try {
          await fillInput(page, input, inputType, value);
          filled[kind] = value;
          // Cache selector for Tier 2
          const formHash = createHash('md5').update(url).digest('hex').slice(0, 8);
          const winningSelector = inputId ? `#${inputId}` : inputName ? `[name="${inputName}"]` : null;
          if (winningSelector) await cacheSelector(domain, formHash, kind, winningSelector).catch(() => {});
        } catch (err) {
          console.warn(`[filler] Could not fill ${kind}: ${err.message}`);
        }
      }
    }

    // ── Tier 3: Vision fallback for unfilled required fields ───────────────────
    const requiredUnfilled = [];
    for (const { input, label } of unfilled) {
      const isRequired = await input.getAttribute('required') !== null
        || await input.getAttribute('aria-required') === 'true';
      if (isRequired) requiredUnfilled.push({ input, label });
    }

    if (requiredUnfilled.length > 0 && (GROQ_API_KEY || NVIDIA_API_KEY)) {
      console.log(`[filler] Tier 3 LLM fallback for ${requiredUnfilled.length} required fields`);
      const suggestions = await llmFillSuggestions(requiredUnfilled.map(f => f.label), profile, job);
      for (const { field, value } of suggestions) {
        const match = requiredUnfilled.find(f => f.label?.toLowerCase() === field?.toLowerCase());
        if (match && value) {
          try {
            const inputType = await match.input.getAttribute('type') ?? 'text';
            await fillInput(page, match.input, inputType, value);
            filled[field] = value;
          } catch {}
        }
      }
    }

    // ── Q&A: answer custom questions ───────────────────────────────────────────
    const qa = app_.custom_qa || [];
    // Answer any questions that have textareas or long text fields near them
    for (const { input, label } of unfilled) {
      const tag = await input.evaluate(el => el.tagName.toLowerCase());
      if (tag !== 'textarea' && (await input.getAttribute('type')) !== 'text') continue;
      const cachedQ = qa.find(q => q.question?.toLowerCase() === label?.toLowerCase());
      if (cachedQ) {
        try {
          await fillInput(page, input, 'textarea', cachedQ.answer);
          filled[`qa:${label?.slice(0, 30)}`] = cachedQ.answer;
        } catch {}
      }
    }

    // ── Take screenshots ───────────────────────────────────────────────────────
    const screenshots = [];
    const screenshotPath = join(SCREENSHOTS_DIR, `${JOB_ID}-preview.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    screenshots.push(screenshotPath);

    // Scroll down and capture more if page is long
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(500);
    const screenshotPath2 = join(SCREENSHOTS_DIR, `${JOB_ID}-preview-2.png`);
    await page.screenshot({ path: screenshotPath2, fullPage: false });
    screenshots.push(screenshotPath2);

    const screenshotBase64s = screenshots.map(p => readFileSync(p).toString('base64'));

    if (!SUBMIT_MODE) {
      // ── DRY RUN: report back to orchestrator ────────────────────────────────
      await reportPreview({
        jobId: JOB_ID,
        appId: APP_ID,
        fieldsCount: Object.keys(filled).length,
        fieldsList: filled,
        qaCount: qa.length,
        screenshotBase64s,
        cvUrl: app_.cv_url,
        coverUrl: app_.cover_url,
        qa,
      });
      console.log('[filler] Dry-run complete. Preview sent to orchestrator.');
    } else {
      // ── SUBMIT MODE ──────────────────────────────────────────────────────────
      console.log('[filler] Submit mode: clicking submit button...');

      // Pre-submit invariant: check fields
      const hasEmail = filled.email || filled.full_name;
      if (!hasEmail) {
        throw new Error('Pre-submit invariant failed: email/name not filled');
      }

      // Find and click submit button
      const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Apply"), button:has-text("Submit"), button:has-text("Bewerben")');
      if (!submitBtn) throw new Error('Submit button not found');

      await submitBtn.click();
      await page.waitForTimeout(3000);

      const confirmText = await page.textContent('body').catch(() => '');
      const confirmationMatch = confirmText.match(/(?:application|bewerbung|ref|confirmation|#)\s*[:#]?\s*([A-Z0-9\-]{4,30})/i);
      const confirmationId = confirmationMatch?.[1] ?? null;

      const confirmScreenshot = join(SCREENSHOTS_DIR, `${JOB_ID}-confirmation.png`);
      await page.screenshot({ path: confirmScreenshot });

      await reportDone({
        jobId: JOB_ID,
        appId: APP_ID,
        success: true,
        confirmationId,
      });
      console.log('[filler] Submitted. Confirmation:', confirmationId);
    }
  } catch (err) {
    console.error('[filler] Error:', err.message);
    await reportDone({ jobId: JOB_ID, appId: APP_ID, success: false, error: err.message });
    throw err;
  } finally {
    await browser.close();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getLabel(page, input) {
  return page.evaluate((el) => {
    const id = el.id;
    if (id) {
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) return label.textContent.trim();
    }
    const closest = el.closest('label');
    if (closest) return closest.textContent.trim();
    const prev = el.previousElementSibling;
    if (prev?.tagName === 'LABEL' || prev?.tagName === 'SPAN') return prev.textContent.trim();
    return el.placeholder || el.name || '';
  }, input).catch(() => '');
}

function identifyFieldKind(name, id, placeholder, label, portalFields, domain, url) {
  // Try portal-specific selectors first
  for (const [kind, selectors] of Object.entries(portalFields)) {
    for (const sel of selectors) {
      if (sel.startsWith('#') && `#${id}` === sel) return kind;
      if (sel.includes('[name') && sel.includes(name)) return kind;
    }
  }
  // Generic pattern matching
  const combined = `${name} ${id} ${placeholder} ${label}`.toLowerCase();
  for (const { kind, patterns } of GENERIC_PATTERNS) {
    if (patterns.some(p => p.test(combined))) return kind;
  }
  return null;
}

async function fillInput(page, input, type, value) {
  if (type === 'select' || (await input.evaluate(el => el.tagName)) === 'SELECT') {
    await input.selectOption({ label: value }).catch(() =>
      input.selectOption({ value }).catch(() => {}));
    return;
  }
  await input.click();
  await input.fill('');
  await input.type(String(value), { delay: 20 });
  await input.dispatchEvent('change');
  await input.dispatchEvent('input');
}

async function llmFillSuggestions(fieldLabels, profile, job) {
  const prompt = `You are a job application form filling assistant.
Given a list of field labels from a form, determine what value from the candidate profile should go in each field.

Candidate profile:
${JSON.stringify(profile, null, 2)}

Job: ${job.title} at ${job.company}

Field labels that need values: ${JSON.stringify(fieldLabels)}

Respond with a JSON array: [{ "field": "<label>", "value": "<answer>" }]
Only include fields you are confident about. If unsure, omit.`;

  const providers = [
    { key: GROQ_API_KEY, url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile' },
    { key: NVIDIA_API_KEY, url: 'https://integrate.api.nvidia.com/v1/chat/completions', model: 'meta/llama-3.3-70b-instruct' },
  ];

  for (const { key, url, model } of providers) {
    if (!key) continue;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, messages: [{ role: 'user', content: prompt }],
          temperature: 0.1, max_tokens: 1000,
        }),
      });
      if (!resp.ok) continue;
      const text = (await resp.json()).choices[0].message.content;
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      return JSON.parse(jsonMatch?.[0] ?? '[]');
    } catch { continue; }
  }
  return [];
}

async function postToOrchestrator(path, body) {
  if (!ORCHESTRATOR_URL) {
    console.warn('[filler] ORCHESTRATOR_URL not set — skipping callback');
    return;
  }
  const resp = await fetch(`${ORCHESTRATOR_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ORCHESTRATOR_TOKEN ? { 'X-Hub-Signature-256': ORCHESTRATOR_TOKEN } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) console.error(`[filler] Orchestrator ${path} returned ${resp.status}`);
}

async function reportPreview(payload) {
  await postToOrchestrator('/filler/preview', payload);
}

async function reportDone(payload) {
  await postToOrchestrator('/filler/done', payload);
}

async function reportCaptcha(jobId, screenshotBuffer, url) {
  await postToOrchestrator('/filler/captcha', {
    jobId,
    screenshotBase64: Buffer.from(screenshotBuffer).toString('base64'),
    manualUrl: url,
  });
}

// ── Run ───────────────────────────────────────────────────────────────────────

run().catch(err => {
  console.error('[filler] Fatal:', err);
  process.exit(1);
});
