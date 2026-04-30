# career-ops Bridge

Local Express server on `127.0.0.1:8787` that connects the Chrome extension to the career-ops CLI pipeline.

## Setup

```bash
cp .env.example .env
# Fill in GEMINI_API_KEY and GROQ_API_KEY
npm install
npm run bridge
```

On first run, a bearer token is auto-generated and printed. Copy it into the extension's Options page.

After loading the extension, copy its ID from `chrome://extensions` into `ALLOWED_EXTENSION_ID` in `.env` and restart.

## API

All endpoints require `Authorization: Bearer <token>`.

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Status check |
| GET | /profile | Flat field map from profile.yml |
| POST | /evaluate | Run gemini-eval on JD text |
| POST | /generate-cv | Tailor CV and generate PDF |
| POST | /generate-cover-letter | Generate cover letter PDF |
| POST | /draft-answers | Draft answers for free-text questions |
| POST | /detect-fields | Vision-based form field detection |
