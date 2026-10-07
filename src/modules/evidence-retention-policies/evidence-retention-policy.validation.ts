import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  EVIDENCE_RETENTION_POLICY_STATUSES,
  RETENTION_EVIDENCE_TYPES,
  RETENTION_EXECUTION_TYPES,
  type CreateEvidenceRetentionPolicyInput,
  type EvidenceRetentionPolicyFilters,
  type EvidenceRetentionPolicyStatus,
  type RetentionEvidenceType,
  type RetentionExecutionType,
  type UpdateEvidenceRetentionPolicyInput,
} from './evidence-retention-policy.types';

/** CR-BE-DOC-CONTROL-01 PART 03 — request validation (SLA-definition style). */

type R = Record<string, unknown>;
const obj = (v: unknown): v is R => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (field: string, message: string): never => {
  throw AppError.validation('Request validation failed.', [{ field, message }]);
};

export function parseUuid(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isValidUuid(normalized)) fail(field, `${field} must be a valid UUID.`);
  return normalized;
}

const text = (v: unknown, f: string, max = 200): string => {
  if (typeof v !== 'string') fail(f, `${f} is required.`);
  const n = (v as string).trim();
  if (!n) fail(f, `${f} is required.`);
  if (n.length > max) fail(f, `${f} must be at most ${max} characters.`);
  return n;
};

const date = (v: unknown, f: string, required = false): string | undefined => {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
    fail(f, `${f} must be a valid ISO-8601 date-time.`);
  }
  return new Date(v as string).toISOString();
};

const evidenceType = (v: unknown): RetentionEvidenceType => {
  if (!RETENTION_EVIDENCE_TYPES.includes(v as RetentionEvidenceType)) {
    fail('evidenceType', `evidenceType must be one of: ${RETENTION_EVIDENCE_TYPES.join(', ')}.`);
  }
  return v as RetentionEvidenceType;
};

const executionType = (v: unknown): RetentionExecutionType => {
  if (!RETENTION_EXECUTION_TYPES.includes(v as RetentionExecutionType)) {
    fail('executionType', `executionType must be one of: ${RETENTION_EXECUTION_TYPES.join(', ')}.`);
  }
  return v as RetentionExecutionType;
};

const retentionDays = (v: unknown): number => {
  if (!Number.isInteger(v) || (v as number) <= 0) {
    fail('retentionDays', 'retentionDays must be a positive integer.');
  }
  return v as number;
};

const status = (v: unknown): EvidenceRetentionPolicyStatus => {
  if (!EVIDENCE_RETENTION_POLICY_STATUSES.includes(v as EvidenceRetentionPolicyStatus)) {
    fail('status', `status must be one of: ${EVIDENCE_RETENTION_POLICY_STATUSES.join(', ')}.`);
  }
  return v as EvidenceRetentionPolicyStatus;
};

export function parseCreateBody(
  value: unknown,
): Omit<CreateEvidenceRetentionPolicyInput, 'clientId'> {
  if (!obj(value)) fail('body', 'Request body must be a JSON object.');
  const body = value as R;
  const allowed = [
    'buildingId', 'code', 'name', 'evidenceType', 'executionType',
    'retentionDays', 'status', 'effectiveFrom', 'effectiveTo',
  ];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) fail(key, `${key} is not allowed.`);
  }

  const out: Omit<CreateEvidenceRetentionPolicyInput, 'clientId'> = {
    code: text(body.code, 'code', 100).toUpperCase(),
    name: text(body.name, 'name'),
    retentionDays: retentionDays(body.retentionDays),
    effectiveFrom: date(body.effectiveFrom, 'effectiveFrom', true)!,
  };
  if (!/^[A-Z][A-Z0-9_.-]*$/.test(out.code)) fail('code', 'code has an invalid format.');
  if (body.buildingId !== undefined) {
    out.buildingId = parseUuid(String(body.buildingId), 'buildingId');
  }
  if (body.evidenceType !== undefined) out.evidenceType = evidenceType(body.evidenceType);
  if (body.executionType !== undefined) out.executionType = executionType(body.executionType);
  if (body.status !== undefined) out.status = status(body.status);
  const to = date(body.effectiveTo, 'effectiveTo');
  if (to !== undefined) {
    if (new Date(to) <= new Date(out.effectiveFrom)) {
      fail('effectiveTo', 'effectiveTo must be later than effectiveFrom.');
    }
    out.effectiveTo = to;
  }
  return out;
}

export function parseUpdateBody(value: unknown): UpdateEvidenceRetentionPolicyInput {
  if (!obj(value)) fail('body', 'Request body must be a JSON object.');
  const body = value as R;
  const allowed = [
    'name', 'evidenceType', 'executionType', 'retentionDays', 'status',
    'effectiveFrom', 'effectiveTo',
  ];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) fail(key, `${key} is not allowed.`);
  }

  const out: UpdateEvidenceRetentionPolicyInput = {};
  if (body.name !== undefined) out.name = text(body.name, 'name');
  if (Object.prototype.hasOwnProperty.call(body, 'evidenceType')) {
    out.evidenceType = body.evidenceType === null ? null : evidenceType(body.evidenceType);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'executionType')) {
    out.executionType = body.executionType === null ? null : executionType(body.executionType);
  }
  if (body.retentionDays !== undefined) out.retentionDays = retentionDays(body.retentionDays);
  if (body.status !== undefined) out.status = status(body.status);
  const from = date(body.effectiveFrom, 'effectiveFrom');
  if (from !== undefined) out.effectiveFrom = from;
  if (Object.prototype.hasOwnProperty.call(body, 'effectiveTo')) {
    out.effectiveTo = body.effectiveTo === null ? null : date(body.effectiveTo, 'effectiveTo')!;
  }
  if (Object.keys(out).length === 0) fail('body', 'At least one field is required.');
  return out;
}

export function parseFilters(query: R): EvidenceRetentionPolicyFilters {
  const out: EvidenceRetentionPolicyFilters = {};
  if (query.buildingId !== undefined) {
    out.buildingId = parseUuid(String(query.buildingId), 'buildingId');
  }
  if (query.status !== undefined) {
    out.status = status(String(query.status).toUpperCase());
  }
  return out;
}
