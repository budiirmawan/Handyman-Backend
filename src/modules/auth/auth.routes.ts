import { Router } from 'express';
import {
  loginHandler,
  logoutHandler,
  meHandler,
} from './auth.controller';
import { authenticationMiddleware } from './authentication.middleware';

export function createAuthRouter(): Router {
  const router = Router();

  router.post('/auth/login', loginHandler);
  router.get('/auth/me', authenticationMiddleware, meHandler);
  router.post('/auth/logout', authenticationMiddleware, logoutHandler);

  return router;
}
