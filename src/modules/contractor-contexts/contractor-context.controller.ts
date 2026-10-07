import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contractorContextService } from './contractor-context.service';
import {
  parseContractorContextFilters,
  parseContractorContextReference,
  parseResolveContractorContextBody,
} from './contractor-context.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function resolveContractorContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await contractorContextService.resolveContractorContext(
        parseResolveContractorContextBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function validateContractorEligibilityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await contractorContextService.validateContractorEligibilityForPermit(
        parseResolveContractorContextBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getContractorContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await contractorContextService.getContractorContext(
        parseContractorContextReference(
          param(req.params.contractorContextType),
          param(req.params.contractorContextId),
          req.query,
        ),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listContractorContextsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await contractorContextService.listContractorContexts(
        parseContractorContextFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
