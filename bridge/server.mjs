#!/usr/bin/env node

/**
 * career-ops Bridge Server
 *
 * Local Express server on 127.0.0.1:8787 connecting the Chrome extension
 * to the career-ops CLI pipeline. Never binds to 0.0.0.0.
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load bridge .env first, then parent .env as fallback
import dotenv from 'dotenv';
dotenv.config({ path: join(__dirname, '.env') });
dotenv.config({ path: join(__dirname, '..', '.env') });

import express from 'express';
import { ensureToken, authMiddleware } from './lib/auth.mjs';
import { corsMiddleware } from './lib/cors.mjs';

// Route modules
import healthRouter from './routes/health.mjs';
import profileRouter from './routes/profile.mjs';
import evaluateRouter from './routes/evaluate.mjs';
import cvRouter from './routes/cv.mjs';
import coverRouter from './routes/cover.mjs';
import answersRouter from './routes/answers.mjs';
import detectRouter from './routes/detect.mjs';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = '127.0.0.1'; // NEVER bind to 0.0.0.0

const token = ensureToken();
const extensionId = process.env.ALLOWED_EXTENSION_ID || '';

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(corsMiddleware(extensionId));
app.use(authMiddleware(token));
app.use(express.json({ limit: '10mb' })); // screenshots can be large

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use(healthRouter);
app.use(profileRouter);
app.use(evaluateRouter);
app.use(cvRouter);
app.use(coverRouter);
app.use(answersRouter);
app.use(detectRouter);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[bridge] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║             career-ops Bridge — v1.0.0                         ║
╚══════════════════════════════════════════════════════════════════╝

  🌐  http://${HOST}:${PORT}
  🔑  Bearer token: ${token}
  🔒  Extension ID: ${extensionId || '(not set — add ALLOWED_EXTENSION_ID to .env)'}

  Copy the bearer token into the extension's Options page.
  After loading the extension, add its ID to ALLOWED_EXTENSION_ID in .env.

  Endpoints:
    GET  /health               — Status check (no auth required)
    GET  /profile              — Autofill field map
    POST /evaluate             — Evaluate JD via gemini-eval
    POST /generate-cv          — Tailor CV + generate PDF
    POST /generate-cover-letter — Generate cover letter PDF
    POST /draft-answers        — Draft application answers
    POST /detect-fields        — Vision-based field detection
`);
});
