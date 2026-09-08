import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  ESG_CALCULATION_METHODS,
  ESG_DATA_QUALITIES,
  ESG_PERIOD_TYPES,
  ESG_SOURCE_TYPES,
  ESG_VERIFICATION_STATUSES,
  isEsgCalculationMethod,
  isEsgDataQuality,
  isEsgPeriodType,
  isEsgSourceType,
  isEsgVerificationStatus,
  type CreateEsgMetricValueInput,
  type EsgMetricValueFilters,
  type UpdateEsgMetricValueInput,
} from './esg-metric-value.types';

type Detail = { field: string; message: string };

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SEARCH = 200;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function first(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

function readRequiredUuid(v: unknown, field: string, details: Detail[]): string | undefined {
  if (typeof v !== 'string' || !isValidUuid(v.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return v.trim().toLowerCase();
}

function readOptionalUuid(v: unknown, field: string, details: Detail[]): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string' || !isValidUuid(v.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return v.trim().toLowerCase();
}

function readOptionalText(v: unknown, field: string, max: number, details: Detail[]): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = v.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return trimmed;
}

function parseIsoDateTime(v: unknown, field: string, details: Detail[]): Date | undefined {
  if (typeof v !== 'string') {
    details.push({ field, message: `${field} must be ISO-8601 date-time.` });
    return undefined;
  }
  const trimmed = v.trim();
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) {
    details.push({ field, message: `${field} must be ISO-8601 date-time.` });
    return undefined;
  }
  return d;
}

function readValue(v: unknown, field: string, details: Detail[]): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const num = typeof v === 'string' ? Number(v) : v;
  if (typeof num !== 'number' || Number.isNaN(num) || !Number.isFinite(num)) {
    details.push({ field, message: `${field} must be a number or null.` });
    return undefined;
  }
  return num;
}

function readRequiredValue(v: unknown, field: string, details: Detail[]): number | null | undefined {
  if (v === undefined || v === null) {
    details.push({ field, message: `${field} is required unless data_quality is MISSING.` });
    return undefined;
  }
  return readValue(v, field, details);
}

function parseSourceRefs(v: unknown, details: Detail[]): string[] | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!Array.isArray(v)) {
    details.push({ field: 'sourceRefs', message: 'sourceRefs must be an array of UUIDs or null.' });
    return undefined;
  }
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (typeof item !== 'string' || !UUID_REGEX.test(item.trim())) {
      details.push({ field: `sourceRefs[${i}]`, message: 'sourceRefs must contain valid UUIDs.' });
      return undefined;
    }
    out.push(item.trim().toLowerCase());
  }
  // Deduplicate but preserve order
  return [...new Set(out)];
}

export function parseEsgMetricValueIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'ESG metric value id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateEsgMetricValueBody(body: unknown): CreateEsgMetricValueInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: Detail[] = [];

  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);
  const metricDefinitionId = readRequiredUuid(body.metricDefinitionId, 'metricDefinitionId', details);
  const uomId = readRequiredUuid(body.uomId, 'uomId', details);

  let periodType: CreateEsgMetricValueInput['periodType'] | undefined;
  if (typeof body.periodType !== 'string' || !isEsgPeriodType(body.periodType)) {
    details.push({ field: 'periodType', message: `periodType must be one of: ${ESG_PERIOD_TYPES.join(', ')}.` });
  } else {
    periodType = body.periodType;
  }

  const periodStartRaw = body.periodStart;
  const periodEndRaw = body.periodEnd;
  const periodStartDate = parseIsoDateTime(periodStartRaw, 'periodStart', details);
  const periodEndDate = parseIsoDateTime(periodEndRaw, 'periodEnd', details);

  if (periodStartDate && periodEndDate && periodEndDate <= periodStartDate) {
    details.push({ field: 'periodEnd', message: 'period_end must be after period_start.' });
  }

  let calculationMethod: CreateEsgMetricValueInput['calculationMethod'] | undefined;
  if (typeof body.calculationMethod !== 'string' || !isEsgCalculationMethod(body.calculationMethod)) {
    details.push({ field: 'calculationMethod', message: `calculationMethod must be one of: ${ESG_CALCULATION_METHODS.join(', ')}.` });
  } else {
    calculationMethod = body.calculationMethod;
  }

  let sourceType: CreateEsgMetricValueInput['sourceType'] | undefined;
  if (typeof body.sourceType !== 'string' || !isEsgSourceType(body.sourceType)) {
    details.push({ field: 'sourceType', message: `sourceType must be one of: ${ESG_SOURCE_TYPES.join(', ')}.` });
  } else {
    sourceType = body.sourceType;
  }

  let dataQuality: CreateEsgMetricValueInput['dataQuality'] | undefined;
  if (body.dataQuality !== undefined) {
    if (typeof body.dataQuality !== 'string' || !isEsgDataQuality(body.dataQuality)) {
      details.push({ field: 'dataQuality', message: `dataQuality must be one of: ${ESG_DATA_QUALITIES.join(', ')}.` });
    } else {
      dataQuality = body.dataQuality;
    }
  }

  let verificationStatus: CreateEsgMetricValueInput['verificationStatus'] | undefined;
  if (body.verificationStatus !== undefined) {
    if (typeof body.verificationStatus !== 'string' || !isEsgVerificationStatus(body.verificationStatus)) {
      details.push({ field: 'verificationStatus', message: `verificationStatus must be one of: ${ESG_VERIFICATION_STATUSES.join(', ')}.` });
    } else {
      verificationStatus = body.verificationStatus;
    }
  }

  // Value handling: if dataQuality is MISSING, value may be null/undefined; otherwise required
  const effectiveDataQuality = dataQuality ?? 'ACTUAL';
  let value: number | null | undefined;
  if (effectiveDataQuality === 'MISSING') {
    value = readValue(body.value, 'value', details);
    if (value === undefined) value = null; // allow absent as null when MISSING
  } else {
    // When not MISSING, value is required
    if (body.value === undefined || body.value === null) {
      details.push({ field: 'value', message: 'value is required unless data_quality is MISSING.' });
    } else {
      value = readValue(body.value, 'value', details);
    }
  }

  const sourceRefs = parseSourceRefs(body.sourceRefs, details);

  if (!buildingId || !metricDefinitionId || !periodType || !periodStartDate || !periodEndDate || !uomId || !calculationMethod || !sourceType || details.length > 0) {
    fail(details);
  }

  // Preserve raw ISO strings for service to re-parse, but also pass parsed value
  return {
    buildingId: buildingId!,
    metricDefinitionId: metricDefinitionId!,
    periodType: periodType!,
    periodStart: (periodStartRaw as string).trim(),
    periodEnd: (periodEndRaw as string).trim(),
    uomId: uomId!,
    calculationMethod: calculationMethod!,
    sourceType: sourceType!,
    ...(value === undefined ? {} : { value }),
    ...(sourceRefs === undefined ? {} : { sourceRefs }),
    ...(dataQuality === undefined ? {} : { dataQuality }),
    ...(verificationStatus === undefined ? {} : { verificationStatus }),
  };
}

export function parseUpdateEsgMetricValueBody(body: unknown): UpdateEsgMetricValueInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: Detail[] = [];

  if (body.buildingId !== undefined) details.push({ field: 'buildingId', message: 'buildingId is immutable.' });
  if (body.metricDefinitionId !== undefined) details.push({ field: 'metricDefinitionId', message: 'metricDefinitionId is immutable.' });
  if (body.periodType !== undefined) details.push({ field: 'periodType', message: 'periodType is immutable.' });
  if (body.periodStart !== undefined) details.push({ field: 'periodStart', message: 'periodStart is immutable.' });
  if (body.periodEnd !== undefined) details.push({ field: 'periodEnd', message: 'periodEnd is immutable.' });

  let dataQuality: UpdateEsgMetricValueInput['dataQuality'] | undefined;
  if (body.dataQuality !== undefined) {
    if (typeof body.dataQuality !== 'string' || !isEsgDataQuality(body.dataQuality)) {
      details.push({ field: 'dataQuality', message: `dataQuality must be one of: ${ESG_DATA_QUALITIES.join(', ')}.` });
    } else {
      dataQuality = body.dataQuality;
    }
  }

  const value = readValue(body.value, 'value', details);
  const uomId = body.uomId === undefined ? undefined : readRequiredUuid(body.uomId, 'uomId', details);

  let calculationMethod: UpdateEsgMetricValueInput['calculationMethod'] | undefined;
  if (body.calculationMethod !== undefined) {
    if (typeof body.calculationMethod !== 'string' || !isEsgCalculationMethod(body.calculationMethod)) {
      details.push({ field: 'calculationMethod', message: `calculationMethod must be one of: ${ESG_CALCULATION_METHODS.join(', ')}.` });
    } else {
      calculationMethod = body.calculationMethod;
    }
  }

  let sourceType: UpdateEsgMetricValueInput['sourceType'] | undefined;
  if (body.sourceType !== undefined) {
    if (typeof body.sourceType !== 'string' || !isEsgSourceType(body.sourceType)) {
      details.push({ field: 'sourceType', message: `sourceType must be one of: ${ESG_SOURCE_TYPES.join(', ')}.` });
    } else {
      sourceType = body.sourceType;
    }
  }

  let verificationStatus: UpdateEsgMetricValueInput['verificationStatus'] | undefined;
  if (body.verificationStatus !== undefined) {
    if (typeof body.verificationStatus !== 'string' || !isEsgVerificationStatus(body.verificationStatus)) {
      details.push({ field: 'verificationStatus', message: `verificationStatus must be one of: ${ESG_VERIFICATION_STATUSES.join(', ')}.` });
    } else {
      verificationStatus = body.verificationStatus;
    }
  }

  const sourceRefs = parseSourceRefs(body.sourceRefs, details);

  if (details.length > 0) fail(details);

  return {
    ...(value === undefined ? {} : { value }),
    ...(uomId === undefined ? {} : { uomId }),
    ...(calculationMethod === undefined ? {} : { calculationMethod }),
    ...(sourceType === undefined ? {} : { sourceType }),
    ...(sourceRefs === undefined ? {} : { sourceRefs }),
    ...(dataQuality === undefined ? {} : { dataQuality }),
    ...(verificationStatus === undefined ? {} : { verificationStatus }),
  };
}

export function parseEsgMetricValueFilters(query: unknown): EsgMetricValueFilters {
  if (typeof query !== 'object' || query === null) return {};
  const q = query as Record<string, unknown>;
  const details: Detail[] = [];
  const filters: EsgMetricValueFilters = {};

  const readFilterUuid = (key: string) => {
    const raw = first(q[key]);
    if (raw === undefined || raw === '') return undefined;
    return readRequiredUuid(raw, key, details);
  };

  const clientId = readFilterUuid('clientId');
  if (clientId) filters.clientId = clientId;
  const buildingId = readFilterUuid('buildingId');
  if (buildingId) filters.buildingId = buildingId;
  const metricDefinitionId = readFilterUuid('metricDefinitionId');
  if (metricDefinitionId) filters.metricDefinitionId = metricDefinitionId;
  const uomId = readFilterUuid('uomId');
  if (uomId) filters.uomId = uomId;

  const periodTypeRaw = first(q.periodType);
  if (periodTypeRaw !== undefined && periodTypeRaw !== '') {
    if (isEsgPeriodType(periodTypeRaw)) filters.periodType = periodTypeRaw;
    else details.push({ field: 'periodType', message: `periodType must be one of: ${ESG_PERIOD_TYPES.join(', ')}.` });
  }

  const calcRaw = first(q.calculationMethod);
  if (calcRaw !== undefined && calcRaw !== '') {
    if (isEsgCalculationMethod(calcRaw)) filters.calculationMethod = calcRaw;
    else details.push({ field: 'calculationMethod', message: `calculationMethod must be one of: ${ESG_CALCULATION_METHODS.join(', ')}.` });
  }

  const sourceRaw = first(q.sourceType);
  if (sourceRaw !== undefined && sourceRaw !== '') {
    if (isEsgSourceType(sourceRaw)) filters.sourceType = sourceRaw;
    else details.push({ field: 'sourceType', message: `sourceType must be one of: ${ESG_SOURCE_TYPES.join(', ')}.` });
  }

  const dqRaw = first(q.dataQuality);
  if (dqRaw !== undefined && dqRaw !== '') {
    if (isEsgDataQuality(dqRaw)) filters.dataQuality = dqRaw;
    else details.push({ field: 'dataQuality', message: `dataQuality must be one of: ${ESG_DATA_QUALITIES.join(', ')}.` });
  }

  const vsRaw = first(q.verificationStatus);
  if (vsRaw !== undefined && vsRaw !== '') {
    if (isEsgVerificationStatus(vsRaw)) filters.verificationStatus = vsRaw;
    else details.push({ field: 'verificationStatus', message: `verificationStatus must be one of: ${ESG_VERIFICATION_STATUSES.join(', ')}.` });
  }

  const dateFromRaw = first(q.dateFrom);
  if (dateFromRaw !== undefined && dateFromRaw !== '') {
    if (typeof dateFromRaw !== 'string') details.push({ field: 'dateFrom', message: 'dateFrom must be ISO-8601.' });
    else {
      const d = new Date(dateFromRaw);
      if (Number.isNaN(d.getTime())) details.push({ field: 'dateFrom', message: 'dateFrom must be ISO-8601.' });
      else filters.dateFrom = dateFromRaw;
    }
  }

  const dateToRaw = first(q.dateTo);
  if (dateToRaw !== undefined && dateToRaw !== '') {
    if (typeof dateToRaw !== 'string') details.push({ field: 'dateTo', message: 'dateTo must be ISO-8601.' });
    else {
      const d = new Date(dateToRaw);
      if (Number.isNaN(d.getTime())) details.push({ field: 'dateTo', message: 'dateTo must be ISO-8601.' });
      else filters.dateTo = dateToRaw;
    }
  }

  const searchRaw = first(q.search);
  if (searchRaw !== undefined && searchRaw !== '') {
    const s = readOptionalText(searchRaw, 'search', MAX_SEARCH, details);
    if (s) filters.search = s;
  }

  if (details.length > 0) fail(details);
  return filters;
}
