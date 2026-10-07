import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { configurationAuditService } from './configuration-audit.service';
import {
  parseConfigurationAuditFilters,
  parseConfigurationAuditId,
} from './configuration-audit.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
function userId(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function listConfigurationAuditHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await configurationAuditService.listConfigurationAuditEvents(
        parseConfigurationAuditFilters(req.query),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getConfigurationAuditHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await configurationAuditService.getConfigurationAuditEvent(
        parseConfigurationAuditId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
