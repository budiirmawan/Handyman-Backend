import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isUtilityTariffStatus,
  isUtilityTariffType,
  type CreateUtilityTariffInput,
} from './utility-tariff.types';

const decimalPattern = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$/;

export function parseTariffBuildingId(raw: string): string {
  if (!isValidUuid(raw)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return raw.toLowerCase();
}

export function parseCreateUtilityTariffBody(
  buildingId: string,
  body: unknown,
): CreateUtilityTariffInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const source = body as Record<string, unknown>;
  const details: { field: string; message: string }[] = [];

  const utilityType = isUtilityTariffType(source.utilityType)
    ? source.utilityType
    : undefined;
  if (!utilityType) details.push({ field: 'utilityType', message: 'utilityType must be ELECTRICITY or WATER.' });

  const currency = typeof source.currency === 'string'
    ? source.currency.trim().toUpperCase()
    : '';
  if (!/^[A-Z]{3}$/.test(currency)) details.push({ field: 'currency', message: 'currency must be a three-letter uppercase code.' });

  const uomId = typeof source.uomId === 'string' && isValidUuid(source.uomId)
    ? source.uomId.toLowerCase()
    : undefined;
  if (!uomId) details.push({ field: 'uomId', message: 'uomId must be a valid UUID.' });

  const rawRate = typeof source.ratePerUom === 'number'
    ? String(source.ratePerUom)
    : typeof source.ratePerUom === 'string' ? source.ratePerUom.trim() : '';
  if (!decimalPattern.test(rawRate)) details.push({ field: 'ratePerUom', message: 'ratePerUom must be a non-negative decimal with at most 8 decimal places.' });

  const effectiveFrom = typeof source.effectiveFrom === 'string'
    ? new Date(source.effectiveFrom)
    : null;
  if (!effectiveFrom || Number.isNaN(effectiveFrom.getTime())) details.push({ field: 'effectiveFrom', message: 'effectiveFrom must be a valid ISO-8601 timestamp.' });

  let effectiveUntil: Date | null = null;
  if (source.effectiveUntil !== undefined && source.effectiveUntil !== null) {
    effectiveUntil = typeof source.effectiveUntil === 'string'
      ? new Date(source.effectiveUntil) : new Date(NaN);
    if (Number.isNaN(effectiveUntil.getTime())) details.push({ field: 'effectiveUntil', message: 'effectiveUntil must be a valid ISO-8601 timestamp or null.' });
  }
  if (effectiveFrom && effectiveUntil && effectiveUntil <= effectiveFrom) {
    details.push({ field: 'effectiveUntil', message: 'effectiveUntil must be later than effectiveFrom.' });
  }

  const status = source.status === undefined ? 'ACTIVE'
    : isUtilityTariffStatus(source.status) ? source.status : undefined;
  if (!status) details.push({ field: 'status', message: 'status must be ACTIVE or INACTIVE.' });

  if (!utilityType || !uomId || !effectiveFrom || !status || details.length) {
    throw AppError.validation('Request validation failed.', details);
  }
  return { buildingId, utilityType, currency, uomId, ratePerUom: rawRate,
    effectiveFrom, effectiveUntil, status };
}
