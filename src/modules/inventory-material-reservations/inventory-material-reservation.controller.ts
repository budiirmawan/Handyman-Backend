import type { NextFunction, Request, Response } from 'express';
import { authenticationRequiredError } from '../auth';
import { sendSuccess } from '../../shared/api-response';
import { inventoryMaterialReservationService } from './inventory-material-reservation.service';
import {
  parseCreateMaterialReservationBody,
  parseMaterialRequestIdParam,
  parseMaterialReservationFilters,
  parseMaterialReservationIdParam,
} from './inventory-material-reservation.validation';

function paramString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function actorUserId(req: Request): string {
  if (!req.auth) {
    throw authenticationRequiredError();
  }
  return req.auth.userId;
}

export async function createMaterialReservationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const materialRequestId = parseMaterialRequestIdParam(
      paramString(req.params.materialRequestId),
    );
    const body = parseCreateMaterialReservationBody(req.body);
    const reservation =
      await inventoryMaterialReservationService.createMaterialReservation({
        ...body,
        materialRequestId,
        createdByUserId: actorUserId(req),
      });
    sendSuccess(res, reservation, 201);
  } catch (error) {
    next(error);
  }
}

export async function listMaterialReservationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const materialRequestId = parseMaterialRequestIdParam(
      paramString(req.params.materialRequestId),
    );
    const filters = parseMaterialReservationFilters(req.query);
    const reservations =
      await inventoryMaterialReservationService.listMaterialReservationsByMaterialRequest(
        materialRequestId,
        filters,
        actorUserId(req),
      );
    sendSuccess(res, reservations);
  } catch (error) {
    next(error);
  }
}

export async function getMaterialReservationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseMaterialReservationIdParam(paramString(req.params.id));
    const reservation =
      await inventoryMaterialReservationService.getMaterialReservationById(
        id,
        actorUserId(req),
      );
    sendSuccess(res, reservation);
  } catch (error) {
    next(error);
  }
}

export async function releaseMaterialReservationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseMaterialReservationIdParam(paramString(req.params.id));
    const reservation =
      await inventoryMaterialReservationService.releaseMaterialReservation(
        id,
        actorUserId(req),
      );
    sendSuccess(res, reservation);
  } catch (error) {
    next(error);
  }
}

export async function cancelMaterialReservationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseMaterialReservationIdParam(paramString(req.params.id));
    const reservation =
      await inventoryMaterialReservationService.cancelMaterialReservation(
        id,
        actorUserId(req),
      );
    sendSuccess(res, reservation);
  } catch (error) {
    next(error);
  }
}
