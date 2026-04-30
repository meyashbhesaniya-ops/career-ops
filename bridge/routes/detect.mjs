import { Router } from 'express';
import { detectFields } from '../lib/groq-vision.mjs';
import { getCache, setCache } from '../lib/cache.mjs';

const router = Router();

router.post('/detect-fields', async (req, res) => {
  try {
    const { screenshotB64, domOutline, url } = req.body;

    if (!screenshotB64 || !domOutline) {
      return res.status(400).json({ error: 'screenshotB64 and domOutline are required' });
    }

    // Extract domain for caching
    let domain;
    try {
      domain = new URL(url || 'http://unknown').hostname;
    } catch {
      domain = 'unknown';
    }

    // Create a hash of the form structure (DOM outline) for cache key
    const { createHash } = await import('crypto');
    const formHash = createHash('sha256').update(domOutline).digest('hex').slice(0, 16);

    // Check cache first
    const cached = getCache(domain, formHash);
    if (cached) {
      console.log(`[detect-fields] Cache hit for ${domain} (${formHash})`);
      return res.json({ fields: cached, cached: true });
    }

    console.log(`[detect-fields] Cache miss for ${domain} (${formHash}), calling Groq Vision...`);

    // Call Groq Vision
    const fields = await detectFields(screenshotB64, domOutline, url);

    // Cache result
    setCache(domain, formHash, fields);

    res.json({ fields, cached: false });
  } catch (err) {
    console.error('[detect-fields] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
