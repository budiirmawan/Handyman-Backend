import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import {
  activateConfigurationVersionHandler,
  createConfigurationDraftHandler,
  getConfigurationVersionHandler,
  listConfigurationValidationsHandler,
  listConfigurationVersionsHandler,
  publishConfigurationVersionHandler,
  validateConfigurationVersionHandler,
} from './configuration-version.controller';

/**
 * BE-27N history plus BE-27O controlled lifecycle actions. Source-specific
 * read/manage permission and Client/Building Data Scope are enforced in service.
 */
export function createConfigurationVersionRouter(): Router {
  const router = Router();
  router.get(
    '/configuration-sources/:sourceType/:sourceConfigurationId/versions',
    authenticationMiddleware,
    listConfigurationVersionsHandler,
  );
  router.get(
    '/configuration-versions/:id',
    authenticationMiddleware,
    getConfigurationVersionHandler,
  );
  router.get(
    '/configuration-versions/:id/validations',
    authenticationMiddleware,
    listConfigurationValidationsHandler,
  );
  router.post(
    '/configuration-versions/:id/draft',
    authenticationMiddleware,
    createConfigurationDraftHandler,
  );
  router.post(
    '/configuration-versions/:id/validate',
    authenticationMiddleware,
    validateConfigurationVersionHandler,
  );
  router.post(
    '/configuration-versions/:id/publish',
    authenticationMiddleware,
    publishConfigurationVersionHandler,
  );
  router.post(
    '/configuration-versions/:id/activate',
    authenticationMiddleware,
    activateConfigurationVersionHandler,
  );
  return router;
}
