import { Router } from 'express';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnScript } from '../lib/spawn.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const router = Router();

router.post('/evaluate', async (req, res) => {
  try {
    const { jdText, url, company } = req.body;

    if (!jdText || jdText.trim().length < 50) {
      return res.status(400).json({ error: 'jdText is required (minimum 50 characters)' });
    }

    // Get list of existing reports before evaluation
    const reportsBefore = new Set(
      readdirSync(join(ROOT, 'reports')).filter(f => f.endsWith('.md'))
    );

    // Spawn groq-eval.mjs (Groq Cloud / NVIDIA NIM — no Gemini key needed)
    const { stdout, stderr, code } = await spawnScript('groq-eval.mjs', [jdText], {
      timeout: 180_000, // 3 minutes for Gemini
    });

    if (code !== 0) {
      console.error('[evaluate] groq-eval failed:', stderr);
      return res.status(500).json({ error: 'Evaluation failed', details: stderr.slice(0, 500) });
    }

    // Find the newly created report
    const reportsAfter = readdirSync(join(ROOT, 'reports')).filter(f => f.endsWith('.md'));
    const newReport = reportsAfter.find(f => !reportsBefore.has(f));

    // Parse score from stdout
    const scoreMatch = stdout.match(/SCORE:\s*([\d.]+)/);
    const companyMatch = stdout.match(/COMPANY:\s*(.+)/);
    const roleMatch = stdout.match(/ROLE:\s*(.+)/);
    const legitimacyMatch = stdout.match(/LEGITIMACY:\s*(.+)/);

    const result = {
      score: scoreMatch ? parseFloat(scoreMatch[1]) : null,
      company: companyMatch ? companyMatch[1].trim() : (company || 'Unknown'),
      role: roleMatch ? roleMatch[1].trim() : 'Unknown',
      legitimacy: legitimacyMatch ? legitimacyMatch[1].trim() : 'Unknown',
      reportPath: newReport ? `reports/${newReport}` : null,
      summary: extractSummary(stdout),
      url: url || null,
    };

    res.json(result);
  } catch (err) {
    console.error('[evaluate] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Extract a brief summary from the evaluation output.
 */
function extractSummary(stdout) {
  // Try to find recommendation section
  const lines = stdout.split('\n');
  const recIdx = lines.findIndex(l => /recommendation|verdict|overall/i.test(l));
  if (recIdx > -1) {
    return lines.slice(recIdx, recIdx + 5).join('\n').trim().slice(0, 500);
  }
  // Fallback: last meaningful paragraph
  const scoreIdx = stdout.indexOf('---SCORE_SUMMARY---');
  if (scoreIdx > -1) {
    const before = stdout.slice(Math.max(0, scoreIdx - 600), scoreIdx).trim();
    const lastPara = before.split('\n\n').pop();
    return (lastPara || '').trim().slice(0, 500);
  }
  return '';
}

export default router;
