import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  createHandymanArrivalLocationIdentifier,
  deactivateHandymanArrivalLocationIdentifier,
  listHandymanArrivalLocationIdentifiers,
} from '../handyman-arrival-locations';
import type {
  PublicHandymanArrivalLocationIdentifier,
} from '../handyman-arrival-locations';
import {
  getHandymanBuildingGeospatialPolicy,
  listHandymanBuildingGeospatialPolicyHistory,
  saveHandymanBuildingGeospatialPolicy,
  buildingGeospatialPolicyNotFoundError,
} from '../handyman-geospatial-policies';
import type {
  PublicHandymanBuildingGeospatialPolicy,
} from '../handyman-geospatial-policies';
import {
  ensureEmptyQuery,
  parseBuildingIdParam,
  parseGeofencePolicyBody,
  parseIdentifierIdParam,
  parseIdentifierStatusQuery,
  parseRegisterIdentifierBody,
} from './handyman-arrival-configuration.validation';
import type {
  ArrivalLocationIdentifierIssuedView,
  ArrivalLocationIdentifierView,
  BuildingGeofencePolicyView,
} from './handyman-arrival-configuration.types';

/**
 * CR-HM-FIELD-OPERATIONS-01 PART 04 — THIN handlers for the CR Owner
 * approved G-2 (QR registry) and G-3 (per-Building geofence) configuration
 * surfaces (gate §8 → SG-1/SG-2/SG-6; conditions AC-1…AC-4, AC-9, AC-10).
 *
 * Each handler does EXACTLY: auth actor → whitelist parse → the PRE-EXISTING
 * service → bounded serialization. ZERO decision logic lives here: hierarchy
 * validation, BE-02G exact-Building authorization, hash at rest, policy
 * bounds, history-preserving replacement and journalling all remain inside
 * `handyman-arrival-locations` / `handyman-geospatial-policies`, so the HTTP
 * and internal paths cannot drift. No second authority, no duplicated
 * validation.
 */

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function toIdentifierView(
  record: PublicHandymanArrivalLocationIdentifier,
): ArrivalLocationIdentifierView {
  return {
    id: record.id,
    buildingId: record.buildingId,
    floorId: record.floorId,
    areaId: record.areaId,
    roomId: record.roomId,
    spaceId: record.spaceId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toPolicyView(
  record: PublicHandymanBuildingGeospatialPolicy,
): BuildingGeofencePolicyView {
  return {
    id: record.id,
    buildingId: record.buildingId,
    referenceLatitude: record.referenceLatitude,
    referenceLongitude: record.referenceLongitude,
    geofenceRadiusMeters: record.geofenceRadiusMeters,
    maxAccuracyMeters: record.maxAccuracyMeters,
    maxLocationAgeSeconds: record.maxLocationAgeSeconds,
    status: record.status,
    effectiveFrom: record.effectiveFrom,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/* ─────────────────────────── G-2 — QR registry ─────────────────────────── */

export async function postHandymanArrivalLocationIdentifierHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    ensureEmptyQuery(req.query);
    const buildingId = parseBuildingIdParam(req.params.buildingId);
    const chain = parseRegisterIdentifierBody(req.body);
    const created = await createHandymanArrivalLocationIdentifier(
      { buildingId, ...chain },
      actor(req),
    );
    const body: ArrivalLocationIdentifierIssuedView = {
      ...toIdentifierView(created.identifier),
      // Returned exactly once; only its SHA-256 hash is persisted.
      opaqueCode: created.value,
    };
    sendSuccess(res, body, 201);
  } catch (error) {
    next(error);
  }
}

export async function getHandymanArrivalLocationIdentifiersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(req.params.buildingId);
    const status = parseIdentifierStatusQuery(req.query);
    const result = await listHandymanArrivalLocationIdentifiers(
      { buildingId, status },
      actor(req),
    );
    sendSuccess(res, {
      buildingId: result.buildingId,
      identifiers: result.identifiers.map(toIdentifierView),
    });
  } catch (error) {
    next(error);
  }
}

export async function postHandymanArrivalLocationIdentifierDeactivateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    ensureEmptyQuery(req.query);
    const buildingId = parseBuildingIdParam(req.params.buildingId);
    const identifierId = parseIdentifierIdParam(req.params.identifierId);
    // The URL Building is passed as an expectation: the service refuses
    // (non-enumerating 404) when the identifier belongs to another Building.
    const deactivated = await deactivateHandymanArrivalLocationIdentifier(
      identifierId,
      actor(req),
      buildingId,
    );
    sendSuccess(res, toIdentifierView(deactivated));
  } catch (error) {
    next(error);
  }
}

/* ───────────────────── G-3 — Building geofence policy ───────────────────── */

export async function putHandymanBuildingGeofencePolicyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    ensureEmptyQuery(req.query);
    const buildingId = parseBuildingIdParam(req.params.buildingId);
    const policy = parseGeofencePolicyBody(req.body);
    const saved = await saveHandymanBuildingGeospatialPolicy(
      { buildingId, ...policy },
      actor(req),
    );
    sendSuccess(res, toPolicyView(saved));
  } catch (error) {
    next(error);
  }
}

export async function getHandymanBuildingGeofencePolicyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    ensureEmptyQuery(req.query);
    const buildingId = parseBuildingIdParam(req.params.buildingId);
    const policy = await getHandymanBuildingGeospatialPolicy(
      buildingId,
      actor(req),
    );
    // An unconfigured Building is a real operational state: the existing
    // service returns null BEFORE authorization, and the HTTP layer maps it
    // to the documented 404 so existence never leaks across clients.
    if (!policy) throw buildingGeospatialPolicyNotFoundError();
    sendSuccess(res, toPolicyView(policy));
  } catch (error) {
    next(error);
  }
}

export async function getHandymanBuildingGeofencePolicyHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    ensureEmptyQuery(req.query);
    const buildingId = parseBuildingIdParam(req.params.buildingId);
    const history = await listHandymanBuildingGeospatialPolicyHistory(
      buildingId,
      actor(req),
    );
    sendSuccess(res, {
      buildingId: history.buildingId,
      policies: history.policies.map(toPolicyView),
    });
  } catch (error) {
    next(error);
  }
}
