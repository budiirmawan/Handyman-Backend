import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { utilityTypeConfigurationService } from './utility-type-configuration.service';
import type { UtilityTypeConfigurationFilters } from './utility-type-configuration.types';
import {
  parseAddUtilityTypeUomBody,
  parseCreateUtilityTypeConfigurationBody,
  parseUpdateUtilityTypeConfigurationBody,
  parseUpdateUtilityTypeConfigurationStatusBody,
  parseUpdateUtilityTypeUomBody,
  parseUtilityTypeConfigurationClientIdParam,
  parseUtilityTypeConfigurationIdParam,
  parseUtilityTypeConfigurationStatusQuery,
  parseUtilityTypeQuery,
  parseUtilityTypeUomIdParam,
} from './utility-type-configuration.validation';

/** BE-18B — utility type configuration HTTP handlers. */

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

export async function createUtilityTypeConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseUtilityTypeConfigurationClientIdParam(
      paramString(req.params.clientId),
    );
    const body = parseCreateUtilityTypeConfigurationBody(req.body);

    const configuration =
      await utilityTypeConfigurationService.createUtilityTypeConfiguration(
        { ...body, clientId },
        req.auth?.userId,
      );
    sendSuccess(res, configuration, 201);
  } catch (error) {
    next(error);
  }
}

export async function listUtilityTypeConfigurationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseUtilityTypeConfigurationClientIdParam(
      paramString(req.params.clientId),
    );
    const query = req.query as Record<string, unknown>;

    const filters: UtilityTypeConfigurationFilters = {};
    const utilityType = parseUtilityTypeQuery(queryString(query.utilityType));
    if (utilityType !== undefined) {
      filters.utilityType = utilityType;
    }
    const status = parseUtilityTypeConfigurationStatusQuery(
      queryString(query.status),
    );
    if (status !== undefined) {
      filters.status = status;
    }

    const configurations =
      await utilityTypeConfigurationService.listUtilityTypeConfigurations(
        clientId,
        filters,
        req.auth?.userId,
      );
    sendSuccess(res, configurations);
  } catch (error) {
    next(error);
  }
}

export async function getUtilityTypeConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUtilityTypeConfigurationIdParam(paramString(req.params.id));
    const configuration =
      await utilityTypeConfigurationService.getUtilityTypeConfigurationById(
        id,
        req.auth?.userId,
      );
    sendSuccess(res, configuration);
  } catch (error) {
    next(error);
  }
}

export async function updateUtilityTypeConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUtilityTypeConfigurationIdParam(paramString(req.params.id));
    const body = parseUpdateUtilityTypeConfigurationBody(req.body);

    const configuration =
      await utilityTypeConfigurationService.updateUtilityTypeConfiguration(
        id,
        body,
        req.auth?.userId,
      );
    sendSuccess(res, configuration);
  } catch (error) {
    next(error);
  }
}

export async function updateUtilityTypeConfigurationStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUtilityTypeConfigurationIdParam(paramString(req.params.id));
    const body = parseUpdateUtilityTypeConfigurationStatusBody(req.body);

    const configuration =
      await utilityTypeConfigurationService.updateUtilityTypeConfigurationStatus(
        id,
        body,
        req.auth?.userId,
      );
    sendSuccess(res, configuration);
  } catch (error) {
    next(error);
  }
}

export async function addUtilityTypeUomHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUtilityTypeConfigurationIdParam(paramString(req.params.id));
    const body = parseAddUtilityTypeUomBody(req.body);

    const configuration = await utilityTypeConfigurationService.addUtilityTypeUom(
      id,
      body,
      req.auth?.userId,
    );
    sendSuccess(res, configuration, 201);
  } catch (error) {
    next(error);
  }
}

export async function updateUtilityTypeUomHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUtilityTypeConfigurationIdParam(paramString(req.params.id));
    const uomId = parseUtilityTypeUomIdParam(paramString(req.params.uomId));
    const body = parseUpdateUtilityTypeUomBody(req.body);

    const configuration = await utilityTypeConfigurationService.updateUtilityTypeUom(
      id,
      uomId,
      body,
      req.auth?.userId,
    );
    sendSuccess(res, configuration);
  } catch (error) {
    next(error);
  }
}
