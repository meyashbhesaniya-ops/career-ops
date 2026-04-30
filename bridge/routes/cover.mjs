import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { geminiChat, loadModeFiles } from '../lib/gemini.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const router = Router();

router.post('/generate-cover-letter', async (req, res) => {
  try {
    const { reportPath, jdText, company } = req.body;

    if (!jdText) {
      return res.status(400).json({ error: 'jdText is required' });
    }

    const modes = loadModeFiles();

    // Load report if provided
    let reportContent = '';
    if (reportPath) {
      const fullPath = join(ROOT, reportPath);
      if (existsSync(fullPath)) {
        reportContent = readFileSync(fullPath, 'utf-8');
      }
    }

    const systemPrompt = `You are career-ops, an AI cover letter generator.
Write a concise, compelling cover letter tailored to the specific job description and company.

${modes.shared}

CANDIDATE RESUME:
${modes.cv}

${modes.profile ? `PROFILE CUSTOMIZATION:\n${modes.profile}` : ''}

RULES:
- Maximum 400 words
- Professional but authentic tone — no generic platitudes
- Reference specific achievements from the CV that match the JD
- Address the company by name and reference something specific about them
- Format as clean Markdown (will be converted to PDF)`;

    const userMessage = `Write a cover letter for:

Company: ${company || 'the company'}
JD:
${jdText}

${reportContent ? `EVALUATION REPORT:\n${reportContent.slice(0, 2000)}` : ''}`;

    const markdown = await geminiChat(systemPrompt, userMessage, {
      maxTokens: 2048,
      temperature: 0.5,
    });

    // Generate slug
    const slug = (company || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const date = new Date().toISOString().split('T')[0];

    // Build simple HTML for PDF conversion
    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; font-size: 11pt; }
  h1 { font-size: 14pt; margin-bottom: 4px; }
  p { margin: 0.8em 0; }
</style>
</head>
<body>
${markdownToHtml(markdown)}
</body>
</html>`;

    const outputDir = join(ROOT, 'output');
    mkdirSync(outputDir, { recursive: true });

    const htmlPath = join(outputDir, `cover-${slug}-${date}.html`);
    writeFileSync(htmlPath, htmlContent, 'utf-8');

    // Generate PDF
    const pdfPath = join(outputDir, `cover-${slug}-${date}.pdf`);
    const { spawnScript } = await import('../lib/spawn.mjs');
    const { code } = await spawnScript('generate-pdf.mjs', [htmlPath, pdfPath]);

    if (code !== 0) {
      // Return markdown even if PDF fails
      return res.json({ markdown, pdfPath: null, htmlPath: `output/cover-${slug}-${date}.html` });
    }

    res.json({
      markdown,
      pdfPath: `output/cover-${slug}-${date}.pdf`,
      htmlPath: `output/cover-${slug}-${date}.html`,
    });
  } catch (err) {
    console.error('[cover-letter] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

/** Minimal markdown → HTML (covers basic cover letter formatting) */
function markdownToHtml(md) {
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^/, '<p>')
    .replace(/$/, '</p>');
}

export default router;
