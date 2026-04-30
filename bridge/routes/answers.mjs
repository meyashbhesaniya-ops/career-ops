import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { geminiChat, loadModeFiles } from '../lib/gemini.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const router = Router();

router.post('/draft-answers', async (req, res) => {
  try {
    const { questions, reportPath } = req.body;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'questions array is required' });
    }

    if (questions.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 questions per request' });
    }

    const modes = loadModeFiles();

    // Load report for context
    let reportContent = '';
    if (reportPath) {
      const fullPath = join(ROOT, reportPath);
      if (existsSync(fullPath)) {
        reportContent = readFileSync(fullPath, 'utf-8');
      }
    }

    // Load article digest if available
    let articleDigest = '';
    const digestPath = join(ROOT, 'article-digest.md');
    if (existsSync(digestPath)) {
      articleDigest = readFileSync(digestPath, 'utf-8');
    }

    // Use auto-pipeline Step 4 tone rules
    const systemPrompt = `You are career-ops, an AI job application assistant.
You draft answers for job application free-text questions.

${modes.shared}

${modes.autoPipeline}

CANDIDATE RESUME:
${modes.cv}

${modes.profile ? `PROFILE CUSTOMIZATION:\n${modes.profile}` : ''}

${articleDigest ? `PROOF POINTS:\n${articleDigest}` : ''}

RULES FOR ANSWERS:
- Be specific and authentic — reference real achievements from the CV
- Match the tone expected: professional but human
- Keep answers concise (2-4 sentences for short fields, max 200 words for essays)
- Never fabricate experiences or metrics not in the CV
- Return valid JSON only`;

    const userMessage = `Draft answers for these application questions. Return a JSON array where each element has "question" (original) and "answer" (your draft).

${reportContent ? `CONTEXT FROM EVALUATION:\n${reportContent.slice(0, 1500)}\n\n` : ''}

QUESTIONS:
${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;

    const response = await geminiChat(systemPrompt, userMessage, {
      maxTokens: 4096,
      temperature: 0.4,
    });

    // Parse JSON from response
    let answers;
    try {
      // Extract JSON from possible markdown code block
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
      answers = JSON.parse(jsonMatch[1].trim());
    } catch {
      // Fallback: try to parse the whole response
      try {
        answers = JSON.parse(response);
      } catch {
        // Last resort: return raw text split by question
        answers = questions.map((q, i) => ({
          question: q,
          answer: response.split(/\d+\.\s/)[i + 1]?.trim() || response,
        }));
      }
    }

    res.json({ answers: Array.isArray(answers) ? answers : [answers] });
  } catch (err) {
    console.error('[draft-answers] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
