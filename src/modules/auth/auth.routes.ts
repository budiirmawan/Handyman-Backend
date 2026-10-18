import { Router } from 'express';
import {
  changePasswordHandler,
  loginHandler,
  logoutHandler,
  meHandler,
  passwordStatusHandler,
} from './auth.controller';
import { authenticationMiddleware } from './authentication.middleware';

export function createAuthRouter(): Router {
  const router = Router();

  router.post('/auth/login', loginHandler);
  router.get('/auth/me', authenticationMiddleware, meHandler);
  router.get(
    '/auth/password/status',
    authenticationMiddleware,
    passwordStatusHandler,
  );
  router.post(
    '/auth/password',
    authenticationMiddleware,
    changePasswordHandler,
  );
  router.post('/auth/logout', authenticationMiddleware, logoutHandler);

  return router;
}
