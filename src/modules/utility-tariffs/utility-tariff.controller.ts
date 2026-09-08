import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { utilityTariffService } from './utility-tariff.service';
import { isUtilityTariffStatus, isUtilityTariffType } from './utility-tariff.types';
import { parseCreateUtilityTariffBody, parseTariffBuildingId } from './utility-tariff.validation';

const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';

export async function createUtilityTariffHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const buildingId = parseTariffBuildingId(param(req.params.buildingId));
    const body = parseCreateUtilityTariffBody(buildingId, req.body);
    sendSuccess(res, await utilityTariffService.createUtilityTariff(body, req.auth!.userId), 201);
  } catch (error) { next(error); }
}

export async function listUtilityTariffsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const buildingId = parseTariffBuildingId(param(req.params.buildingId));
    const utilityType = isUtilityTariffType(req.query.utilityType) ? req.query.utilityType : undefined;
    const status = isUtilityTariffStatus(req.query.status) ? req.query.status : undefined;
    sendSuccess(res, await utilityTariffService.listUtilityTariffs(
      buildingId, { ...(utilityType ? { utilityType } : {}), ...(status ? { status } : {}) }, req.auth!.userId,
    ));
  } catch (error) { next(error); }
}
