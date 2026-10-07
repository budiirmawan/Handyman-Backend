import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { featureEntitlementConfigurationService } from './feature-entitlement-configuration.service';
import {
  parseCreateFeatureEntitlementConfigurationBody,
  parseFeatureEntitlementBuildingIdParam,
  parseFeatureEntitlementClientIdParam,
  parseFeatureEntitlementConfigurationIdParam,
  parseUpdateFeatureEntitlementConfigurationBody,
} from './feature-entitlement-configuration.validation';

const param = (value: string | string[] | undefined) =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
function userId(req: Request) {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createClientFeatureEntitlementHandler(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await featureEntitlementConfigurationService.createClientFeatureEntitlementConfiguration(
      parseFeatureEntitlementClientIdParam(param(req.params.clientId)),
      parseCreateFeatureEntitlementConfigurationBody(req.body), userId(req)), 201);
  } catch (error) { next(error); }
}
export async function listClientFeatureEntitlementsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await featureEntitlementConfigurationService.listClientFeatureEntitlementConfigurations(
      parseFeatureEntitlementClientIdParam(param(req.params.clientId)), userId(req)));
  } catch (error) { next(error); }
}
export async function effectiveClientFeatureEntitlementsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await featureEntitlementConfigurationService.getEffectiveClientFeatureEntitlements(
      parseFeatureEntitlementClientIdParam(param(req.params.clientId)), userId(req)));
  } catch (error) { next(error); }
}
export async function createBuildingFeatureEntitlementHandler(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await featureEntitlementConfigurationService.createBuildingFeatureEntitlementConfiguration(
      parseFeatureEntitlementBuildingIdParam(param(req.params.buildingId)),
      parseCreateFeatureEntitlementConfigurationBody(req.body), userId(req)), 201);
  } catch (error) { next(error); }
}
export async function listBuildingFeatureEntitlementsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await featureEntitlementConfigurationService.listBuildingFeatureEntitlementConfigurations(
      parseFeatureEntitlementBuildingIdParam(param(req.params.buildingId)), userId(req)));
  } catch (error) { next(error); }
}
export async function effectiveBuildingFeatureEntitlementsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await featureEntitlementConfigurationService.getEffectiveBuildingFeatureEntitlements(
      parseFeatureEntitlementBuildingIdParam(param(req.params.buildingId)), userId(req)));
  } catch (error) { next(error); }
}
export async function getFeatureEntitlementHandler(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await featureEntitlementConfigurationService.getFeatureEntitlementConfigurationById(
      parseFeatureEntitlementConfigurationIdParam(param(req.params.id)), userId(req)));
  } catch (error) { next(error); }
}
export async function updateFeatureEntitlementHandler(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await featureEntitlementConfigurationService.updateFeatureEntitlementConfiguration(
      parseFeatureEntitlementConfigurationIdParam(param(req.params.id)),
      parseUpdateFeatureEntitlementConfigurationBody(req.body), userId(req)));
  } catch (error) { next(error); }
}
