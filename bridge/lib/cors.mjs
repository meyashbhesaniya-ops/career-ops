/**
 * CORS middleware for the career-ops bridge.
 *
 * Since this bridge ONLY binds to 127.0.0.1 and requires a bearer token,
 * we allow:
 *   1. Any chrome-extension:// origin (personal unpacked extension)
 *   2. Direct localhost / no-origin requests (curl, Postman, etc.)
 *
 * If ALLOWED_EXTENSION_ID is set, we additionally log a warning when a
 * different extension ID connects (informational only — not blocked).
 */
export function corsMiddleware(allowedExtensionId) {
  return (req, res, next) => {
    const origin = req.headers.origin || '';

    // Allow any chrome-extension origin — the bridge is localhost-only
    // and bearer-token-protected, so CORS is not the security boundary.
    const isChromeExtension = origin.startsWith('chrome-extension://');

    // Allow direct localhost / no-origin requests (curl, testing)
    const isLocalhost = !origin
      || origin.startsWith('http://127.0.0.1')
      || origin.startsWith('http://localhost');

    if (isChromeExtension || isLocalhost) {
      // Informational: warn if a different extension ID connects
      if (isChromeExtension && allowedExtensionId) {
        const extId = origin.replace('chrome-extension://', '');
        if (extId !== allowedExtensionId) {
          console.warn(`[cors] Request from unexpected extension ID: ${extId} (expected ${allowedExtensionId})`);
        }
      }

      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '86400');

      if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
      }
      return next();
    }

    return res.status(403).json({ error: 'Origin not allowed' });
  };
}
