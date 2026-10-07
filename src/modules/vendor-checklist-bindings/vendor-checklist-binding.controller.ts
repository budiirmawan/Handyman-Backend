import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { vendorChecklistBindingService } from './vendor-checklist-binding.service';
import {
  parseCreateVendorChecklistBindingBody,
  parseVendorChecklistBindingFilters,
  parseVendorChecklistBindingIdParam,
  parseVendorChecklistExecutionIdParam,
} from './vendor-checklist-binding.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** POST /vendor-checklist-bindings */
export async function createVendorChecklistBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseCreateVendorChecklistBindingBody(req.body);
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const binding =
      await vendorChecklistBindingService.createVendorChecklistBinding(
        {
          vendorWorkId: body.vendorWorkId,
          checklistTemplateId: body.checklistTemplateId,
          createdByUserId: req.auth.userId,
        },
        req.auth.userId,
      );
    sendSuccess(res, binding, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /vendor-checklist-bindings/:bindingId */
export async function getVendorChecklistBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bindingId = parseVendorChecklistBindingIdParam(
      paramString(req.params.bindingId),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await vendorChecklistBindingService.getVendorChecklistBinding(
        bindingId,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /vendor-checklist-bindings?vendorWorkId= & vendorId= & buildingId= */
export async function listVendorChecklistBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseVendorChecklistBindingFilters(
      req.query as Record<string, unknown>,
    );

    if (filters.buildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        filters.buildingId,
      );
    }
    const accessibleBuildingIds =
      await contextAccessService.getAccessibleBuildingIds(req.auth.userId);

    const bindings =
      await vendorChecklistBindingService.listVendorChecklistBindings(
        filters,
        req.auth.userId,
        accessibleBuildingIds,
      );
    sendSuccess(res, bindings);
  } catch (error) {
    next(error);
  }
}

/** POST /vendor-checklist-bindings/:bindingId/start */
export async function startVendorChecklistExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bindingId = parseVendorChecklistBindingIdParam(
      paramString(req.params.bindingId),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const { execution, created } =
      await vendorChecklistBindingService.startVendorChecklistExecution(
        bindingId,
        req.auth.userId,
      );
    sendSuccess(res, execution, created ? 201 : 200);
  } catch (error) {
    next(error);
  }
}

/** GET /vendor-checklist-executions/:executionId */
export async function getVendorChecklistExecutionContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionId = parseVendorChecklistExecutionIdParam(
      paramString(req.params.executionId),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await vendorChecklistBindingService.resolveVendorChecklistExecutionContext(
        executionId,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
