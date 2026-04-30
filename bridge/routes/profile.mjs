import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const router = Router();

/**
 * Flatten profile.yml + local/profile-extras.yml into a flat key-value map
 * suitable for form autofill.
 */
function flattenProfile() {
  const profilePath = join(ROOT, 'config', 'profile.yml');
  const extrasPath = join(ROOT, 'local', 'profile-extras.yml');

  if (!existsSync(profilePath)) {
    throw new Error('config/profile.yml not found');
  }

  const profile = yaml.load(readFileSync(profilePath, 'utf-8'));
  let extras = {};
  if (existsSync(extrasPath)) {
    extras = yaml.load(readFileSync(extrasPath, 'utf-8')) || {};
  }

  const candidate = profile.candidate || {};
  const comp = profile.compensation || {};
  const loc = profile.location || {};

  // Build flat autofill map
  const flat = {
    // Core identity
    full_name: candidate.full_name || '',
    first_name: (candidate.full_name || '').split(' ')[0] || '',
    last_name: (candidate.full_name || '').split(' ').slice(1).join(' ') || '',
    email: candidate.email || '',
    phone: candidate.phone || '',

    // Links
    linkedin: candidate.linkedin || '',
    github: candidate.github || '',
    portfolio_url: candidate.portfolio_url || candidate.website || '',

    // Location
    location: candidate.location || `${loc.city}, ${loc.country}`,
    city: loc.city || '',
    country: loc.country || '',
    timezone: loc.timezone || '',

    // Compensation
    salary_expectation: comp.target_range || '',
    salary_minimum: comp.minimum || '',
    salary_currency: comp.currency || '',

    // Target roles (for context)
    target_roles: (profile.target_roles?.primary || []).join(', '),
    headline: profile.narrative?.headline || '',

    // Extras (work authorization, etc.)
    ...extras,
  };

  // Remove empty values
  return Object.fromEntries(
    Object.entries(flat).filter(([, v]) => v !== '' && v != null)
  );
}

router.get('/profile', (_req, res) => {
  try {
    const profile = flattenProfile();
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
