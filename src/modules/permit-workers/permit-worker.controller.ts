import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { permitWorkerService } from './permit-worker.service';
import {
  parseAddPermitWorkerBody,
  parsePermitWorkerFilters,
  parsePermitWorkerIdParam,
  parsePermitWorkerPermitIdParam,
  parseUpdatePermitWorkerBody,
} from './permit-worker.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function addPermitWorkerHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitWorkerService.addPermitWorker(
        parsePermitWorkerPermitIdParam(param(req.params.permitId)),
        parseAddPermitWorkerBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getPermitWorkerHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitWorkerService.getPermitWorker(
        parsePermitWorkerIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listPermitWorkersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitWorkerService.listPermitWorkers(
        parsePermitWorkerFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listPermitWorkersForPermitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitWorkerService.listPermitWorkersForPermit(
        parsePermitWorkerPermitIdParam(param(req.params.permitId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updatePermitWorkerHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitWorkerService.updatePermitWorker(
        parsePermitWorkerIdParam(param(req.params.id)),
        parseUpdatePermitWorkerBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function deactivatePermitWorkerHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitWorkerService.deactivatePermitWorker(
        parsePermitWorkerIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function resolveActivePermitWorkersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitWorkerService.resolveActivePermitWorkers(
        parsePermitWorkerPermitIdParam(param(req.params.permitId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
