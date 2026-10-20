import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  buildPaginationMeta,
  parsePagination,
} from '../../shared/pagination';
import { authenticationRequiredError } from '../auth';
import {
  getApartmentUnit,
  listApartmentUnitOccupancies,
  listApartmentUnits,
  updateApartmentUnit,
} from './apartment-unit.service';
import {
  parseApartmentUnitListQuery,
  parseApartmentUnitOccupancyQuery,
  parseApartmentUnitUpdateBody,
  parseAssignUnitPartyRoleBody,
  parseBuildingIdParam,
  parseEndUnitPartyRoleBody,
  parseUnitIdParam,
  parseUnitPartyRoleIdParam,
  parseUnitPartyRoleListQuery,
} from './apartment-master.validation';
import {
  assignUnitPartyRole,
  endUnitPartyRole,
  listUnitPartyRoles,
} from './unit-party-role.service';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function paginated<T>(
  res: Response,
  items: T[],
  total: number,
  page: { page: number; pageSize: number },
): void {
  sendSuccess(res, items, 200, {
    ...buildPaginationMeta(page.page, page.pageSize, total),
  });
}

export async function listApartmentUnitsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const page = parsePagination(req.query as Record<string, unknown>);
    const result = await listApartmentUnits({
      actorUserId: actor(req),
      buildingId: parseBuildingIdParam(param(req.params.buildingId)),
      filters: parseApartmentUnitListQuery(req.query as Record<string, unknown>),
      page,
    });
    paginated(res, result.items, result.total, page);
  } catch (error) {
    next(error);
  }
}

export async function getApartmentUnitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await getApartmentUnit({
        actorUserId: actor(req),
        buildingId: parseBuildingIdParam(param(req.params.buildingId)),
        unitId: parseUnitIdParam(param(req.params.unitId)),
      }),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateApartmentUnitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await updateApartmentUnit({
        actorUserId: actor(req),
        buildingId: parseBuildingIdParam(param(req.params.buildingId)),
        unitId: parseUnitIdParam(param(req.params.unitId)),
        ...parseApartmentUnitUpdateBody(req.body),
      }),
    );
  } catch (error) {
    next(error);
  }
}

export async function listApartmentUnitOccupanciesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const page = parsePagination(req.query as Record<string, unknown>);
    const result = await listApartmentUnitOccupancies({
      actorUserId: actor(req),
      buildingId: parseBuildingIdParam(param(req.params.buildingId)),
      unitId: parseUnitIdParam(param(req.params.unitId)),
      filters: parseApartmentUnitOccupancyQuery(
        req.query as Record<string, unknown>,
      ),
      page,
    });
    paginated(res, result.items, result.total, page);
  } catch (error) {
    next(error);
  }
}

export async function listUnitPartyRolesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const page = parsePagination(req.query as Record<string, unknown>);
    const result = await listUnitPartyRoles({
      actorUserId: actor(req),
      buildingId: parseBuildingIdParam(param(req.params.buildingId)),
      unitId: parseUnitIdParam(param(req.params.unitId)),
      filters: parseUnitPartyRoleListQuery(
        req.query as Record<string, unknown>,
      ),
      page,
    });
    paginated(res, result.items, result.total, page);
  } catch (error) {
    next(error);
  }
}

export async function assignUnitPartyRoleHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await assignUnitPartyRole({
        actorUserId: actor(req),
        buildingId: parseBuildingIdParam(param(req.params.buildingId)),
        unitId: parseUnitIdParam(param(req.params.unitId)),
        ...parseAssignUnitPartyRoleBody(req.body),
      }),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function endUnitPartyRoleHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await endUnitPartyRole({
        actorUserId: actor(req),
        unitPartyRoleId: parseUnitPartyRoleIdParam(param(req.params.id)),
        ...parseEndUnitPartyRoleBody(req.body),
      }),
    );
  } catch (error) {
    next(error);
  }
}
