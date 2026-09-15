import helmet from 'helmet';

/**
 * Baseline HTTP security headers for a JSON API.
 * CSP is disabled because this service does not serve a browser UI.
 * CORP is cross-origin so configured web/mobile consumers can read responses.
 */
export function createSecurityHeaders() {
  return helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
}
