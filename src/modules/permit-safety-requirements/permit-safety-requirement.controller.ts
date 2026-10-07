import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { permitSafetyRequirementService } from './permit-safety-requirement.service';
import {
  parseCreatePermitSafetyRequirementBody,
  parsePermitSafetyApplicationIdParam,
  parsePermitSafetyPermitIdParam,
  parsePermitSafetyRequirementFilters,
  parsePermitSafetyRequirementIdParam,
  parseUpdatePermitSafetyReadinessBody,
} from './permit-safety-requirement.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createApplicationSafetyRequirementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitSafetyRequirementService.createPermitSafetyRequirement(
        parsePermitSafetyApplicationIdParam(param(req.params.applicationId)),
        parseCreatePermitSafetyRequirementBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function createPermitSafetyRequirementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitSafetyRequirementService.createPermitSafetyRequirementForPermit(
        parsePermitSafetyPermitIdParam(param(req.params.permitId)),
        parseCreatePermitSafetyRequirementBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getPermitSafetyRequirementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitSafetyRequirementService.getPermitSafetyRequirement(
        parsePermitSafetyRequirementIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listSafetyRequirementsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitSafetyRequirementService.listPermitSafetyRequirements(
        parsePermitSafetyRequirementFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listPermitSafetyRequirementsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitSafetyRequirementService.listPermitSafetyRequirementsForPermit(
        parsePermitSafetyPermitIdParam(param(req.params.permitId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listApplicationSafetyRequirementsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitSafetyRequirementService.listPermitSafetyRequirementsForApplication(
        parsePermitSafetyApplicationIdParam(param(req.params.applicationId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updatePermitSafetyReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitSafetyRequirementService.updatePermitSafetyReadiness(
        parsePermitSafetyRequirementIdParam(param(req.params.id)),
        parseUpdatePermitSafetyReadinessBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function resolvePermitSafetyReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitSafetyRequirementService.resolvePermitSafetyReadiness(
        parsePermitSafetyPermitIdParam(param(req.params.permitId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
