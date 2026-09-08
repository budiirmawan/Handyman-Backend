import { Router, Request, Response, NextFunction } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { sendSuccess } from '../../shared/api-response';
import {
  executeTaskAction,
  getTaskPublic,
} from './task-execution.service';

const p = (value: string | string[]): string =>
  Array.isArray(value) ? value[0] : value;

async function runAction(
  req: Request,
  res: Response,
  next: NextFunction,
  action: 'start' | 'complete' | 'cancel',
): Promise<void> {
  try {
    const completionNotes =
      action === 'complete' ? req.body?.completionNotes : undefined;
    const task = await executeTaskAction(
      p(req.params.taskId),
      action,
      req.auth.userId,
      completionNotes,
    );
    sendSuccess(res, task);
  } catch (error) {
    next(error);
  }
}

export function createTaskExecutionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('task.manage');
  const read = requirePermission('task.read');

  router.post('/tasks/:taskId/start', auth, manage, (req, res, next) =>
    runAction(req, res, next, 'start'),
  );
  router.post('/tasks/:taskId/complete', auth, manage, (req, res, next) =>
    runAction(req, res, next, 'complete'),
  );
  router.post('/tasks/:taskId/cancel', auth, manage, (req, res, next) =>
    runAction(req, res, next, 'cancel'),
  );
  router.get('/tasks/:taskId', auth, read, async (req, res, next) => {
    try {
      sendSuccess(res, await getTaskPublic(p(req.params.taskId)));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
