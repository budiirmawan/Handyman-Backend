import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { permitEquipmentService } from './permit-equipment.service';
import {
  parseAddPermitEquipmentBody,
  parsePermitEquipmentFilters,
  parsePermitEquipmentIdParam,
  parsePermitEquipmentPermitIdParam,
  parseUpdatePermitEquipmentBody,
} from './permit-equipment.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function addPermitEquipmentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await permitEquipmentService.addPermitEquipment(
      parsePermitEquipmentPermitIdParam(param(req.params.permitId)),
      parseAddPermitEquipmentBody(req.body), actor(req),
    ), 201);
  } catch (error) { next(error); }
}
export async function getPermitEquipmentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await permitEquipmentService.getPermitEquipment(
      parsePermitEquipmentIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function listPermitEquipmentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await permitEquipmentService.listPermitEquipment(
      parsePermitEquipmentFilters(req.query), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function listPermitEquipmentForPermitHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await permitEquipmentService.listPermitEquipmentForPermit(
      parsePermitEquipmentPermitIdParam(param(req.params.permitId)), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function updatePermitEquipmentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await permitEquipmentService.updatePermitEquipment(
      parsePermitEquipmentIdParam(param(req.params.id)),
      parseUpdatePermitEquipmentBody(req.body), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function deactivatePermitEquipmentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await permitEquipmentService.deactivatePermitEquipment(
      parsePermitEquipmentIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function resolveActivePermitEquipmentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await permitEquipmentService.resolveActivePermitEquipment(
      parsePermitEquipmentPermitIdParam(param(req.params.permitId)), actor(req),
    ));
  } catch (error) { next(error); }
}
