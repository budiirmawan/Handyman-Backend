import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { utilityMeterTenantService } from './utility-meter-tenant.service';
import type { UtilityMeterTenantAssignmentFilters } from './utility-meter-tenant.types';
import {
  parseAssignMeterToTenantBody,
  parseEndUtilityMeterTenantAssignmentBody,
  parseTenantAssignmentMeterIdParam,
  parseTenantAssignmentSpaceIdParam,
  parseTenantAssignmentTenantIdParam,
  parseUpdateUtilityMeterTenantAssignmentBody,
  parseUtilityMeterTenantAssignmentIdParam,
  parseUtilityMeterTenantAssignmentStatusQuery,
} from './utility-meter-tenant.validation';

/** BE-18D — Tenant Meter HTTP handlers. */

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return undefined;
}

function parseFilters(req: Request): UtilityMeterTenantAssignmentFilters {
  const query = req.query as Record<string, unknown>;
  const filters: UtilityMeterTenantAssignmentFilters = {};

  const status = parseUtilityMeterTenantAssignmentStatusQuery(
    queryString(query.status),
  );
  if (status !== undefined) {
    filters.status = status;
  }
  return filters;
}

export async function assignMeterToTenantHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterId = parseTenantAssignmentMeterIdParam(paramString(req.params.id));
    const body = parseAssignMeterToTenantBody(req.body);

    const assignment = await utilityMeterTenantService.assignMeterToTenant(
      { ...body, meterId },
      req.auth?.userId,
    );
    sendSuccess(res, assignment, 201);
  } catch (error) {
    next(error);
  }
}

export async function listMeterTenantAssignmentsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterId = parseTenantAssignmentMeterIdParam(paramString(req.params.id));
    const assignments = await utilityMeterTenantService.listAssignmentsByMeter(
      meterId,
      parseFilters(req),
      req.auth?.userId,
    );
    sendSuccess(res, assignments);
  } catch (error) {
    next(error);
  }
}

export async function resolveCurrentTenantAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterId = parseTenantAssignmentMeterIdParam(paramString(req.params.id));
    const assignment =
      await utilityMeterTenantService.resolveCurrentTenantAssignment(
        meterId,
        req.auth?.userId,
      );
    sendSuccess(res, assignment);
  } catch (error) {
    next(error);
  }
}

export async function listTenantCompanyMetersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tenantCompanyId = parseTenantAssignmentTenantIdParam(
      paramString(req.params.tenantCompanyId),
    );
    const assignments =
      await utilityMeterTenantService.listAssignmentsByTenantCompany(
        tenantCompanyId,
        parseFilters(req),
        req.auth?.userId,
      );
    sendSuccess(res, assignments);
  } catch (error) {
    next(error);
  }
}

export async function listSpaceMetersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const spaceId = parseTenantAssignmentSpaceIdParam(
      paramString(req.params.spaceId),
    );
    const assignments = await utilityMeterTenantService.listAssignmentsBySpace(
      spaceId,
      parseFilters(req),
      req.auth?.userId,
    );
    sendSuccess(res, assignments);
  } catch (error) {
    next(error);
  }
}

export async function getUtilityMeterTenantAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUtilityMeterTenantAssignmentIdParam(
      paramString(req.params.id),
    );
    const assignment =
      await utilityMeterTenantService.getUtilityMeterTenantAssignmentById(
        id,
        req.auth?.userId,
      );
    sendSuccess(res, assignment);
  } catch (error) {
    next(error);
  }
}

export async function updateUtilityMeterTenantAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUtilityMeterTenantAssignmentIdParam(
      paramString(req.params.id),
    );
    const body = parseUpdateUtilityMeterTenantAssignmentBody(req.body);

    const assignment =
      await utilityMeterTenantService.updateUtilityMeterTenantAssignment(
        id,
        body,
        req.auth?.userId,
      );
    sendSuccess(res, assignment);
  } catch (error) {
    next(error);
  }
}

export async function endUtilityMeterTenantAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUtilityMeterTenantAssignmentIdParam(
      paramString(req.params.id),
    );
    const body = parseEndUtilityMeterTenantAssignmentBody(req.body);

    const assignment =
      await utilityMeterTenantService.endUtilityMeterTenantAssignment(
        id,
        body,
        req.auth?.userId,
      );
    sendSuccess(res, assignment);
  } catch (error) {
    next(error);
  }
}
