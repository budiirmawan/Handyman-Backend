import { Router } from 'express';
import { getAppVersionMetadataHandler } from './app-version.controller';

/**
 * BE-25M — App Version Metadata.
 *
 *   GET /mobile/app-version/:platform?appVersion=1.2.3
 *
 * Read-only metadata contract (public): platform, current supported version,
 * minimum supported version, update-required / update-available flags, and
 * release metadata where applicable. No app distribution/update delivery and
 * no Flutter UI behavior is built here.
 */
export function createAppVersionRouter(): Router {
  const router = Router();

  router.get('/mobile/app-version/:platform', getAppVersionMetadataHandler);

  return router;
}
