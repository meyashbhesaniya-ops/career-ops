import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { geminiChat, loadModeFiles } from '../lib/gemini.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const router = Router();

router.post('/generate-cv', async (req, res) => {
  try {
    const { reportPath, jdText } = req.body;

    if (!jdText) {
      return res.status(400).json({ error: 'jdText is required' });
    }

    const modes = loadModeFiles();

    // Load report if provided
    let reportContent = '';
    if (reportPath) {
      const fullReportPath = join(ROOT, reportPath);
      if (existsSync(fullReportPath)) {
        reportContent = readFileSync(fullReportPath, 'utf-8');
      }
    }

    // Load CV template
    const templatePath = join(ROOT, 'templates', 'cv-template.html');
    if (!existsSync(templatePath)) {
      return res.status(500).json({ error: 'CV template not found' });
    }
    const template = readFileSync(templatePath, 'utf-8');

    // Build tailoring prompt using pdf.md mode rules
    const systemPrompt = `You are career-ops, an AI-powered CV tailoring assistant.

${modes.shared}

${modes.pdf}

CANDIDATE RESUME:
${modes.cv}

${modes.profile ? `PROFILE CUSTOMIZATION:\n${modes.profile}` : ''}`;

    const userMessage = `Tailor the CV for this job description. Return ONLY the HTML content that should replace the body of the CV template. Use the same HTML structure and CSS classes as the template.

JD:
${jdText}

${reportContent ? `EVALUATION REPORT:\n${reportContent}` : ''}

CV TEMPLATE STRUCTURE (use these CSS classes):
${template.slice(0, 3000)}`;

    const tailoredHtml = await geminiChat(systemPrompt, userMessage, {
      maxTokens: 8192,
      temperature: 0.3,
    });

    // Inject tailored content into template
    // Replace body content between the markers or use the full HTML if returned
    let finalHtml;
    if (tailoredHtml.includes('<!DOCTYPE') || tailoredHtml.includes('<html')) {
      finalHtml = tailoredHtml;
    } else {
      // Wrap in template
      finalHtml = template.replace(
        /(<body[^>]*>)([\s\S]*?)(<\/body>)/i,
        `$1\n${tailoredHtml}\n$3`
      );
    }

    // Generate slug for filename
    const companyMatch = reportContent.match(/# Evaluation:\s*(.+?)\s*[—-]/);
    const company = companyMatch ? companyMatch[1].trim() : 'company';
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const date = new Date().toISOString().split('T')[0];

    // Write HTML
    const outputDir = join(ROOT, 'output');
    mkdirSync(outputDir, { recursive: true });
    const htmlPath = join(outputDir, `cv-${slug}-${date}.html`);
    writeFileSync(htmlPath, finalHtml, 'utf-8');

    // Generate PDF via generate-pdf.mjs
    const pdfPath = join(outputDir, `cv-${slug}-${date}.pdf`);

    const { spawnScript } = await import('../lib/spawn.mjs');
    const { code, stderr } = await spawnScript('generate-pdf.mjs', [htmlPath, pdfPath], {
      timeout: 60_000,
    });

    if (code !== 0) {
      console.error('[generate-cv] PDF generation failed:', stderr);
      return res.status(500).json({ error: 'PDF generation failed', htmlPath: `output/cv-${slug}-${date}.html` });
    }

    res.json({
      pdfPath: `output/cv-${slug}-${date}.pdf`,
      htmlPath: `output/cv-${slug}-${date}.html`,
      company,
      slug,
    });
  } catch (err) {
    console.error('[generate-cv] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
