import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { buildingUtilityReconciliationService as service } from './building-utility-reconciliation.service';
import { parseCreateBuildingUtilityReconciliation, parseReconciliationId } from './building-utility-reconciliation.validation';
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
export async function createBuildingUtilityReconciliationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const buildingId = parseReconciliationId(param(req.params.buildingId), 'buildingId');
    sendSuccess(res, await service.createBuildingUtilityReconciliation(
      parseCreateBuildingUtilityReconciliation(buildingId, req.body), req.auth!.userId,
    ), 201);
  } catch (error) { next(error); }
}
export async function getBuildingUtilityReconciliationHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await service.getBuildingUtilityReconciliation(
    parseReconciliationId(param(req.params.id)), req.auth!.userId,
  )); } catch (error) { next(error); }
}
export async function listBuildingUtilityReconciliationsHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await service.listBuildingUtilityReconciliations(
    parseReconciliationId(param(req.params.buildingId), 'buildingId'), req.auth!.userId,
  )); } catch (error) { next(error); }
}
