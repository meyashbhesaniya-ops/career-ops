# AutoApply Deployment Checklist

Follow these steps **in order**. Each depends on the previous.

---

## ⚠️ CRITICAL — Security First

### 1. Revoke exposed Telegram bot token
The token `8613997537:AAFD...` was exposed in our conversation. **Revoke immediately:**

1. Open Telegram → @BotFather
2. `/mybots` → select your bot → API Token → **Revoke current token**
3. Copy the new token — you'll need it in Step 4

### 2. Get your Telegram Chat ID
1. Open Telegram → search for `@userinfobot`
2. Send `/start`
3. Copy the numeric **Id** (e.g., `123456789`)

---

## 🗄️ Step 3 — Run DB Migration

1. Go to [Supabase SQL Editor](https://supabase.com/dashboard/project/lqrdynownccyjyfpuejc/sql)
2. Paste the entire contents of `db/migrations/001_schema.sql`
3. Click **Run** — should show "Success. No rows returned."
4. Verify in Table Editor: you should see 7 new tables (jobs, applications, qa_answers, credentials, selector_cache, audit_log, system_state)

---

## 🔑 Step 4 — Create .env Files

### Pre-generated secrets (save these now):

```
VAULT_KEY=6c76e3f369b2b96d4f280471cab544ac66fd7798f9fa00a263d5eb448be7effa
GH_WEBHOOK_SECRET=QU9wiwl8zdQ4HVV9IxfQtavxlVq98QAe
ORCHESTRATOR_TOKEN=eUWNkbv8-rChQi6qDltuXEUOCJT-GCiY
TAILOR_TOKEN=vgtYGURdN2G2B-s6mp23MzvBDPU9oxN9
```

### .env for Micro #0 (89.168.115.96)

Create file `~/career-ops/.env`:
```env
# Supabase
SUPABASE_URL=https://lqrdynownccyjyfpuejc.supabase.co
SUPABASE_SERVICE_KEY=<paste from Supabase Settings → API → service_role key>

# Telegram
TELEGRAM_BOT_TOKEN=<your NEW token from Step 1>
TELEGRAM_CHAT_ID=<your chat ID from Step 2>

# Vault
VAULT_KEY=6c76e3f369b2b96d4f280471cab544ac66fd7798f9fa00a263d5eb448be7effa

# LLM APIs
GROQ_API_KEY=<your Groq key>
NVIDIA_API_KEY=<your NVIDIA NIM key>
GEMINI_API_KEY=<your Gemini key>

# GitHub (for triggering filler workflow)
GITHUB_PAT=<GitHub PAT with repo + actions:write>
GITHUB_REPO=santifer/career-ops
GH_WEBHOOK_SECRET=QU9wiwl8zdQ4HVV9IxfQtavxlVq98QAe

# Inter-agent auth
ORCHESTRATOR_URL=http://89.168.115.96:9000
ORCHESTRATOR_PORT=9000
ORCHESTRATOR_TOKEN=eUWNkbv8-rChQi6qDltuXEUOCJT-GCiY
TAILOR_URL=http://130.162.209.192:9001
TAILOR_TOKEN=vgtYGURdN2G2B-s6mp23MzvBDPU9oxN9

# Evaluator (local)
EVALUATOR_URL=http://localhost:9002
EVALUATOR_PORT=9002

# OCI (optional — for A1 capacity watcher)
OCI_TENANCY_OCID=ocid1.tenancy.oc1..aaaaaaaapla6jzhzygcbngduihbqml6emmntcptlrscsiucarclteh6z2wbq
OCI_USER_OCID=<your OCI user OCID>
OCI_FINGERPRINT=<your OCI API key fingerprint>
OCI_PRIVATE_KEY_PATH=/home/ubuntu/.oci/oci_api_key.pem
OCI_REGION=eu-frankfurt-1
```

### .env for Micro #1 (130.162.209.192)

Create file `~/career-ops/.env`:
```env
# Supabase
SUPABASE_URL=https://lqrdynownccyjyfpuejc.supabase.co
SUPABASE_SERVICE_KEY=<same service_role key>

# Vault
VAULT_KEY=6c76e3f369b2b96d4f280471cab544ac66fd7798f9fa00a263d5eb448be7effa

# LLM APIs
GROQ_API_KEY=<your Groq key>
NVIDIA_API_KEY=<your NVIDIA NIM key>
GEMINI_API_KEY=<your Gemini key>

# GitHub
GITHUB_PAT=<same PAT>
GITHUB_REPO=santifer/career-ops
GH_WEBHOOK_SECRET=QU9wiwl8zdQ4HVV9IxfQtavxlVq98QAe

# Tailor config
TAILOR_PORT=9001
TAILOR_TOKEN=vgtYGURdN2G2B-s6mp23MzvBDPU9oxN9

# Orchestrator (for callbacks)
ORCHESTRATOR_URL=http://89.168.115.96:9000
ORCHESTRATOR_TOKEN=eUWNkbv8-rChQi6qDltuXEUOCJT-GCiY
```

---

## 🖥️ Step 5 — Bootstrap VMs

From your local machine:

```bash
# Micro #0
ssh ubuntu@89.168.115.96 'bash -s' < deploy/bootstrap-vm.sh

# Micro #1
ssh ubuntu@130.162.209.192 'bash -s' < deploy/bootstrap-vm.sh
```

This installs Node 20, pm2, clones repo, runs `npm ci`.

---

## 📦 Step 6 — Deploy .env to VMs

```bash
# Copy .env files (create them locally first as micro0.env and micro1.env)
scp micro0.env ubuntu@89.168.115.96:~/career-ops/.env
scp micro1.env ubuntu@130.162.209.192:~/career-ops/.env
```

---

## 🚀 Step 7 — Start Services

```bash
# On Micro #0
ssh ubuntu@89.168.115.96 "cd ~/career-ops && mkdir -p logs && pm2 start ecosystem.config.cjs --only orchestrator,telegram-bot,scout,evaluator,oci-watch && pm2 save"

# On Micro #1
ssh ubuntu@130.162.209.192 "cd ~/career-ops && mkdir -p logs && pm2 start ecosystem.config.cjs --only tailor && pm2 save"
```

---

## 🔐 Step 8 — GitHub Actions Secrets

Go to: https://github.com/santifer/career-ops/settings/secrets/actions

Add these repository secrets:

| Secret | Value |
|--------|-------|
| `SUPABASE_URL` | `https://lqrdynownccyjyfpuejc.supabase.co` |
| `SUPABASE_SERVICE_KEY` | (same service_role key) |
| `VAULT_KEY` | `6c76e3f369b2b96d4f280471cab544ac66fd7798f9fa00a263d5eb448be7effa` |
| `ORCHESTRATOR_URL` | `http://89.168.115.96:9000` |
| `ORCHESTRATOR_TOKEN` | `eUWNkbv8-rChQi6qDltuXEUOCJT-GCiY` |
| `GH_WEBHOOK_SECRET` | `QU9wiwl8zdQ4HVV9IxfQtavxlVq98QAe` |
| `GROQ_API_KEY` | (your key) |
| `NVIDIA_API_KEY` | (your key) |
| `GEMINI_API_KEY` | (your key) |

---

## ✅ Step 9 — Test

1. Open Telegram → your bot → send `/start`
   - Expected: bot responds with welcome + status

2. Send `/status`
   - Expected: shows "System: ACTIVE" + daily stats

3. Send `/scan`
   - Expected: triggers scout, finds jobs within 1-2 min, sends match cards for any ≥ threshold

4. Wait for a match card → tap **👁️ JD** to view the description

5. If you like it → tap **✅ Approve** → bot responds with tailored CV preview

6. When ready → tap **🚀 Submit** → filler runs on GitHub Actions (dry-run first)

---

## 📋 Troubleshooting

```bash
# Check logs on Micro #0
ssh ubuntu@89.168.115.96 "cd ~/career-ops && pm2 logs --lines 50"

# Restart all
ssh ubuntu@89.168.115.96 "cd ~/career-ops && pm2 restart all"

# Check health
curl http://89.168.115.96:9000/healthz
curl http://130.162.209.192:9001/healthz
```

---

## 🔄 Updating Code

```bash
# On each VM
ssh ubuntu@<ip> "cd ~/career-ops && git pull && npm ci && pm2 restart all"
```
