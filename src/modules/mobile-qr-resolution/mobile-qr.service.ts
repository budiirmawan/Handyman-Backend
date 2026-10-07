import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { contextAccessService } from '../context-access';
import { assetIdentifierService } from '../asset-identifiers/asset-identifier.service';
import { assetIdentifierNotResolvableError } from '../asset-identifiers/asset-identifier.errors';
import { equipmentProfileRepository } from '../equipment-profiles/equipment-profile.repository';
import { functionalLocationRepository } from '../functional-locations/functional-location.repository';
import type {
  MobileQrAssetContext,
  MobileQrAvailableActions,
  MobileQrBuilding,
  MobileQrFunctionalLocation,
  MobileQrResolution,
} from './mobile-qr.types';

/**
 * BE-25F — Mobile QR resolution service.
 *
 * Resolves an opaque identifier through the existing BE-05H authority
 * (`assetIdentifierService.resolveAssetByIdentifier` — no separate QR
 * engine) and enriches it with Building / Functional-Location context and
 * Asset / Equipment context where applicable. Access is restricted to the
 * BE-02G accessible set: an identifier whose Asset's Building is not
 * accessible yields the SAME 404 as an unknown value (hides existence,
 * exactly like the existing resolve endpoint).
 */

async function loadBuilding(buildingId: string): Promise<MobileQrBuilding | null> {
  const result = await getPool().query<{ id: string; code: string; name: string }>(
    'SELECT id, code, name FROM buildings WHERE id = $1',
    [buildingId],
  );
  return result.rows[0] ?? null;
}

async function loadFunctionalLocation(
  functionalLocationId: string | null,
): Promise<MobileQrFunctionalLocation | null> {
  if (!functionalLocationId) {
    return null;
  }
  const record = await functionalLocationRepository.findById(functionalLocationId);
  if (!record) {
    return null;
  }
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
  };
}

async function loadAssetContext(
  assetId: string,
): Promise<{ asset: MobileQrAssetContext; clientId: string }> {
  const result = await getPool().query<{
    id: string;
    client_id: string;
    asset_code: string;
    asset_name: string;
    description: string | null;
    manufacturer: string | null;
    model: string | null;
    serial_number: string | null;
    status: string;
  }>(
    `SELECT id, client_id, asset_code, asset_name, description, manufacturer,
            model, serial_number, status
       FROM assets WHERE id = $1`,
    [assetId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError({
      code: ERROR_CODES.ASSET_NOT_FOUND,
      message: 'Asset not found.',
      statusCode: 404,
    });
  }

  const equipmentRecord = await equipmentProfileRepository.findByAssetId(assetId);
  return {
    asset: {
      id: row.id,
      assetCode: row.asset_code,
      assetName: row.asset_name,
      description: row.description,
      manufacturer: row.manufacturer,
      model: row.model,
      serialNumber: row.serial_number,
      status: row.status,
      equipment: equipmentRecord
        ? {
            id: equipmentRecord.id,
            equipmentCode: equipmentRecord.equipmentCode,
            equipmentName: equipmentRecord.equipmentName,
            manufacturer: equipmentRecord.manufacturer,
            model: equipmentRecord.model,
            serialNumber: equipmentRecord.serialNumber,
            status: equipmentRecord.status,
          }
        : null,
    },
    clientId: row.client_id,
  };
}

function availableActionsForAsset(assetStatus: string): MobileQrAvailableActions {
  const actions: string[] = [];
  if (assetStatus === 'ACTIVE') {
    actions.push('VIEW_DETAILS');
    actions.push('START_FINDING');
  }
  return { actions };
}

export async function resolveMobileQr(
  identifierValue: string,
  userId: string,
): Promise<MobileQrResolution> {
  const resolved = await assetIdentifierService.resolveAssetByIdentifier(
    identifierValue,
  );

  const canAccess = await contextAccessService.canAccessBuilding(
    userId,
    resolved.asset.buildingId,
  );
  if (!canAccess) {
    throw assetIdentifierNotResolvableError();
  }

  const [building, functionalLocation, assetContext] = await Promise.all([
    loadBuilding(resolved.asset.buildingId),
    loadFunctionalLocation(resolved.asset.functionalLocationId),
    loadAssetContext(resolved.asset.id),
  ]);

  return {
    identifier: {
      id: resolved.identifier.id,
      identifierType: resolved.identifier.identifierType,
      identifierValue: resolved.identifier.identifierValue,
    },
    targetType: 'ASSET',
    targetId: resolved.asset.id,
    clientId: assetContext.clientId,
    location: {
      building,
      functionalLocation,
    },
    asset: assetContext.asset,
    available: availableActionsForAsset(assetContext.asset.status),
  };
}
