-- career-ops AutoApply System — Database Schema
-- Run against Supabase project: lqrdynownccyjyfpuejc
-- Execute via: Supabase SQL editor or psql

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. JOBS — discovered roles from Scout
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portal          TEXT NOT NULL,          -- 'greenhouse' | 'lever' | 'ashby' | 'stepstone' | 'indeed_de' | 'xing' | 'arbeitnow'
  external_id     TEXT,                   -- portal-specific job ID
  url             TEXT NOT NULL,
  title           TEXT NOT NULL,
  company         TEXT NOT NULL,
  location        TEXT,
  salary_raw      TEXT,                   -- raw salary string from portal
  language        TEXT DEFAULT 'en',      -- 'de' | 'en'
  jd_text         TEXT,                   -- full job description text
  score           NUMERIC(3,1),           -- A-G evaluation 0.0–5.0
  evaluation_json JSONB,                  -- full evaluation block from Evaluator
  status          TEXT NOT NULL DEFAULT 'DISCOVERED',
                  -- DISCOVERED | SCORED | PENDING_USER | TAILORING | READY_FOR_REVIEW
                  -- | PENDING_SUBMIT | SUBMITTED | CONFIRMED | FAILED | SKIPPED | DEAD
  telegram_msg_id BIGINT,                 -- Telegram message ID for match card (for editing)
  discovered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (portal, external_id),
  UNIQUE (url)
);

CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);
CREATE INDEX IF NOT EXISTS jobs_score_idx ON jobs (score DESC);
CREATE INDEX IF NOT EXISTS jobs_discovered_idx ON jobs (discovered_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. APPLICATIONS — one row per submitted application
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS applications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID NOT NULL REFERENCES jobs(id),
  cv_url            TEXT,                 -- Supabase Storage URL
  cover_url         TEXT,                 -- Supabase Storage URL (null if not required)
  cv_page_count     NUMERIC(3,1),         -- 1.0 or 1.5
  fields_filled     JSONB,               -- { field_name: value } map sent to portal
  custom_qa         JSONB,               -- [ { question, answer } ]
  portal_response   TEXT,               -- confirmation number / text from portal
  submitted_at      TIMESTAMPTZ,
  confirmed_at      TIMESTAMPTZ,
  approved_by_user  BOOLEAN DEFAULT FALSE,
  approval_ts       TIMESTAMPTZ,
  gsheet_row        INT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. QA_ANSWERS — cached custom question → answer pairs (reused across portals)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qa_answers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_hash   TEXT NOT NULL UNIQUE,   -- SHA256 of normalised question text
  question_text   TEXT NOT NULL,
  answer_text     TEXT NOT NULL,
  language        TEXT DEFAULT 'en',
  used_count      INT DEFAULT 1,
  last_used_at    TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. CREDENTIALS — encrypted portal login data (vault)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain          TEXT NOT NULL UNIQUE,   -- e.g. 'linkedin.com', 'xing.com'
  email_enc       TEXT NOT NULL,          -- AES-256-GCM encrypted
  password_enc    TEXT NOT NULL,          -- AES-256-GCM encrypted
  otp_seed_enc    TEXT,                   -- TOTP seed encrypted (nullable)
  cookies_enc     TEXT,                   -- serialised cookies JSON encrypted
  cookies_expiry  TIMESTAMPTZ,
  last_login      TIMESTAMPTZ,
  login_ok        BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. SELECTOR_CACHE — learned CSS selectors per portal/form (Filler Tier 2)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS selector_cache (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain          TEXT NOT NULL,
  form_hash       TEXT NOT NULL,          -- hash of form structure fingerprint
  field_name      TEXT NOT NULL,
  selector        TEXT NOT NULL,          -- winning CSS selector
  success_count   INT DEFAULT 1,
  last_used_at    TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (domain, form_hash, field_name)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. AUDIT_LOG — append-only, hash-chained event log
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  seq             BIGSERIAL PRIMARY KEY,
  job_id          UUID REFERENCES jobs(id),
  application_id  UUID REFERENCES applications(id),
  event           TEXT NOT NULL,          -- e.g. 'JOB_DISCOVERED', 'USER_APPROVED', 'SUBMITTED'
  actor           TEXT NOT NULL DEFAULT 'system', -- 'system' | 'user'
  payload         JSONB,
  prev_hash       TEXT,                   -- SHA256 of previous row's hash
  row_hash        TEXT,                   -- SHA256(seq||job_id||event||ts||prev_hash)
  ts              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prevent deletion/update on audit_log
CREATE OR REPLACE RULE audit_log_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;
CREATE OR REPLACE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. SYSTEM_STATE — single-row config (pause/resume, thresholds, counters)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_state (
  id                    INT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- enforce single row
  paused                BOOLEAN NOT NULL DEFAULT FALSE,
  score_threshold       NUMERIC(3,1) NOT NULL DEFAULT 4.0,
  max_applies_per_day   INT NOT NULL DEFAULT 30,
  max_per_company_day   INT NOT NULL DEFAULT 5,
  applies_today         INT NOT NULL DEFAULT 0,
  applies_today_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  last_scout_at         TIMESTAMPTZ,
  last_digest_at        TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO system_state DEFAULT VALUES ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Helper: auto-update updated_at timestamps
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER credentials_updated_at BEFORE UPDATE ON credentials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER system_state_updated_at BEFORE UPDATE ON system_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
