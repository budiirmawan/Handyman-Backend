import { createHash } from 'node:crypto';
import { AppError } from '../../shared/errors';
import type { AuditRequestContext } from '../audit';
import { recordEvent } from '../audit';
import type { PaginationParams } from '../../shared/pagination';
import { apartmentUnitRepository, endUnitPartyRole, assignUnitPartyRole, unitPartyRoleService } from '../apartment-master';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import {
  tenantCompanyRepository,
  tenantCompanyService,
  type TenantVerificationStatus,
} from '../tenant-companies';
import { tenantPicService } from '../tenant-pics';
import {
  assignSpaceToTenant,
  tenantSpaceRepository,
  tenantSpaceService,
} from '../tenant-spaces';
import {
  tenantImportEmptyError,
  tenantImportIdempotencyConflictError,
  tenantImportNotFoundError,
  tenantImportStateConflictError,
} from './tenant-import.errors';
import { tenantImportRepository, type NewTenantImportRow } from './tenant-import.repository';
import {
  derivedTenantCode,
  maskIdentityDocumentNumber,
  type PublicTenantImportBatch,
  type PublicTenantImportRow,
  type TenantImportBatchRecord,
  type TenantImportPlanStep,
  type TenantImportRelation,
  type TenantImportRowErrorCode,
  type TenantImportRowRecord,
} from './tenant-import.types';
import { parseImportRow, parseUploadBody } from './tenant-import.validation';

function toPublicBatch(record: TenantImportBatchRecord): PublicTenantImportBatch {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    validatedAt: record.validatedAt?.toISOString() ?? null,
    confirmedAt: record.confirmedAt?.toISOString() ?? null,
    committedAt: record.committedAt?.toISOString() ?? null,
    abortedAt: record.abortedAt?.toISOString() ?? null,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicRow(record: TenantImportRowRecord): PublicTenantImportRow {
  const payload = (record.payload ?? {}) as {
    externalRef?: string;
    party?: Record<string, unknown>;
    verificationStatus?: TenantVerificationStatus;
    pics?: unknown[];
    unitLinks?: unknown[];
  };
  const party = payload.party ?? {};
  return {
    id: record.id,
    batchId: record.batchId,
    rowNumber: record.rowNumber,
    // ID-derived keys carry the document number; reads always mask it.
    rowKey: record.rowKey.replace(
      /^(ID:[A-Z0-9_-]+:)(.{4,})$/,
      (_m, prefix: string, rest: string) => `${prefix}•••• ${rest.slice(-4)}`,
    ),
    externalRef: payload.externalRef ?? null,
    status: record.status,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    outcome: record.outcome ?? {},
    tenantCompanyId: record.tenantCompanyId,
    party: {
      ...(typeof party.tenantCode === 'string' ? { tenantCode: party.tenantCode } : {}),
      tenantName: typeof party.tenantName === 'string' ? party.tenantName : '',
      ...(party.partyKind ? { partyKind: party.partyKind as 'INDIVIDUAL' | 'LEGAL_ENTITY' } : {}),
      ...(typeof party.legalName === 'string' ? { legalName: party.legalName } : {}),
      ...(typeof party.identityDocumentType === 'string'
        ? { identityDocumentType: party.identityDocumentType }
        : {}),
      identityDocumentNumber: maskIdentityDocumentNumber(
        typeof party.identityDocumentNumber === 'string' ? party.identityDocumentNumber : null,
      ),
      ...(typeof party.email === 'string' ? { email: party.email } : {}),
      ...(typeof party.phone === 'string' ? { phone: party.phone } : {}),
      ...(typeof party.address === 'string' ? { address: party.address } : {}),
      ...(party.status ? { status: party.status as 'ACTIVE' | 'INACTIVE' } : {}),
    },
    verificationStatus: payload.verificationStatus ?? 'PENDING_VERIFICATION',
    picCount: Array.isArray(payload.pics) ? payload.pics.length : 0,
    unitLinkCount: Array.isArray(payload.unitLinks) ? payload.unitLinks.length : 0,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function assertClientAccess(userId: string, clientId: string): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

async function requireBatch(
  clientId: string,
  batchId: string,
): Promise<TenantImportBatchRecord> {
  const batch = await tenantImportRepository.findBatchById(clientId, batchId);
  if (!batch) throw tenantImportNotFoundError();
  return batch;
}

function auditBase(actorUserId: string, audit: AuditRequestContext) {
  return {
    userId: actorUserId,
    actorUserId: audit.actorUserId ?? actorUserId,
    requestId: audit.requestId ?? null,
    ipAddress: audit.ipAddress ?? null,
    userAgent: audit.userAgent ?? null,
  };
}

type ResolvedParty = {
  action: 'CREATE' | 'REUSE';
  tenantCompanyId?: string;
  tenantCode: string;
};

type SemanticResult =
  | { ok: true; plan: TenantImportPlanStep[]; resolution: ResolvedParty }
  | { ok: false; code: TenantImportRowErrorCode; message: string };

/**
 * Semantic row validation against live master data (the preview authority).
 * Every failure is a per-row error; nothing here touches the masters.
 */
async function validateRowSemantic(
  input: {
    clientId: string;
    actorUserId: string;
    payload: Record<string, unknown>;
    rowKey: string;
  },
  seen: { rowKeys: Set<string>; links: Set<string> },
): Promise<SemanticResult> {
  const payload = input.payload as {
    party?: Record<string, unknown>;
    verificationStatus?: string;
    pics?: Record<string, unknown>[];
    unitLinks?: Record<string, unknown>[];
  };
  const party = (payload.party ?? {}) as {
    tenantCode?: string;
    tenantName: string;
    partyKind?: 'INDIVIDUAL' | 'LEGAL_ENTITY';
    legalName?: string;
    identityDocumentType?: string;
    identityDocumentNumber?: string;
    email?: string;
    phone?: string;
    address?: string;
    status?: 'ACTIVE' | 'INACTIVE';
  };

  if (seen.rowKeys.has(input.rowKey)) {
    return { ok: false, code: 'DUPLICATE_ROW', message: 'A previous row in this batch registers the same party.' };
  }
  seen.rowKeys.add(input.rowKey);

  const tenantCode = party.tenantCode ?? derivedTenantCode(input.rowKey);

  // ---- party resolution against the existing master (dedup) -------------
  let existing = null;
  if (party.identityDocumentType && party.identityDocumentNumber) {
    existing = await tenantCompanyRepository.findByIdentityDocument(
      input.clientId,
      party.identityDocumentType,
      party.identityDocumentNumber,
    );
  }
  const byCode = await tenantCompanyRepository.findByCodeForClient(input.clientId, tenantCode);
  if (existing && party.tenantCode && existing.tenantCode !== party.tenantCode) {
    return {
      ok: false,
      code: 'TENANT_IDENTITY_CONFLICT',
      message: `Identity document already belongs to tenantCode ${existing.tenantCode}; refusing to bind it to ${party.tenantCode}.`,
    };
  }
  if (!existing && byCode) {
    const sameIdentity =
      !party.identityDocumentNumber ||
      (byCode.identityDocumentNumber ?? null) === party.identityDocumentNumber;
    if (!sameIdentity) {
      return {
        ok: false,
        code: 'TENANT_IDENTITY_CONFLICT',
        message: `tenantCode ${tenantCode} already exists with a different identity document.`,
      };
    }
  }
  const match = existing ?? byCode;
  const resolution: ResolvedParty = match
    ? { action: 'REUSE', tenantCompanyId: match.id, tenantCode: match.tenantCode }
    : { action: 'CREATE', tenantCode };

  const plan: TenantImportPlanStep[] = [
    { step: 'PARTY', action: resolution.action, tenantCode: resolution.tenantCode },
  ];

  // ---- PICs -------------------------------------------------------------
  const pics = Array.isArray(payload.pics) ? payload.pics : [];
  const existingPics =
    match && resolution.action === 'REUSE'
      ? await tenantPicService.listTenantPics(match.id, input.actorUserId)
      : [];
  for (let picIndex = 0; picIndex < pics.length; picIndex += 1) {
    const pic = pics[picIndex] as { picName: string; email?: string };
    const identity = (pic.email ?? picNameOf(pic)).trim().toLowerCase();
    const already = existingPics.find(
      (p) => (p.email ?? p.picName).trim().toLowerCase() === identity,
    );
    plan.push(
      already
        ? { step: 'PIC', action: 'SKIP', picIndex, picName: pic.picName, match: already.id }
        : { step: 'PIC', action: 'CREATE', picIndex, picName: pic.picName },
    );
  }

  // ---- Unit relations ---------------------------------------------------
  const links = Array.isArray(payload.unitLinks) ? payload.unitLinks : [];
  const wantsLinks = links.length > 0;
  const wantsPics = pics.length > 0;
  if (match && match.status !== 'ACTIVE' && (wantsLinks || wantsPics)) {
    return { ok: false, code: 'TENANT_COMPANY_INACTIVE', message: 'The matched party is INACTIVE; it cannot gain PICs or Unit relations.' };
  }
  if (party.status === 'INACTIVE' && wantsLinks) {
    return { ok: false, code: 'VALIDATION', message: 'An INACTIVE party cannot take Unit relations.' };
  }

  for (let linkIndex = 0; linkIndex < links.length; linkIndex += 1) {
    const link = links[linkIndex] as {
      buildingId: string;
      unitId?: string;
      unitCode?: string;
      relation: TenantImportRelation;
      effectiveFrom?: string;
      effectiveUntil?: string;
      replaceExisting?: boolean;
    };
    const linkSeenKey = `${link.unitId ?? link.unitCode ?? '?'}|${link.relation}`;
    if (seen.links.has(linkSeenKey)) {
      return { ok: false, code: 'DUPLICATE_ROW', message: `Another row in this batch already carries relation ${link.relation} for this Unit.` };
    }

    if (!(await contextAccessService.canAccessBuilding(input.actorUserId, link.buildingId))) {
      return { ok: false, code: 'BUILDING_ACCESS_DENIED', message: 'The session holds no ACTIVE assignment to this Building.' };
    }

    let unit = null;
    if (link.unitId) {
      unit = await apartmentUnitRepository.findUnit({
        clientId: input.clientId,
        buildingId: link.buildingId,
        unitId: link.unitId,
      });
    } else if (link.unitCode) {
      const found = await apartmentUnitRepository.listUnits({
        clientId: input.clientId,
        buildingId: link.buildingId,
        filters: { search: link.unitCode },
        page: { limit: 50, offset: 0 },
      });
      const wanted = link.unitCode.trim().toLowerCase();
      unit = found.items.find((u) => u.code.trim().toLowerCase() === wanted) ?? null;
    }
    if (!unit) {
      // Unknown, foreign-Client and other-Building Units collapse into the
      // same non-enumerating 404 (IND-01 vocabulary).
      return { ok: false, code: 'APARTMENT_UNIT_NOT_FOUND', message: 'Unit not found in this Building for this Client.' };
    }
    if (unit.status !== 'ACTIVE') {
      return { ok: false, code: 'VALIDATION', message: 'Unit is not ACTIVE.' };
    }

    if (link.relation === 'TENANCY') {
      const active = await tenantSpaceRepository.findActiveBySpace(unit.id);
      if (active) {
        if (match && active.tenantCompanyId === match.id) {
          plan.push({ step: 'LINK', action: 'SKIP', linkIndex, relation: 'TENANCY', buildingId: link.buildingId, unitId: unit.id });
        } else if (!link.replaceExisting) {
          return {
            ok: false,
            code: 'TENANT_SPACE_ALREADY_ASSIGNED',
            message: 'Unit already has an ACTIVE occupancy; set replaceExisting to hand over occupancy with an effective date.',
          };
        } else {
          plan.push({
            step: 'LINK',
            action: 'REPLACE',
            linkIndex,
            relation: 'TENANCY',
            buildingId: link.buildingId,
            unitId: unit.id,
            replaceRelationshipId: active.id,
          });
        }
      } else {
        plan.push({ step: 'LINK', action: 'CREATE', linkIndex, relation: 'TENANCY', buildingId: link.buildingId, unitId: unit.id });
      }
    } else {
      const partyRole = link.relation === 'PIC' ? 'PIC' : link.relation;
      if (match) {
        const holds = await unitPartyRoleService.hasCurrentUnitPartyRole({
          clientId: input.clientId,
          buildingId: link.buildingId,
          unitId: unit.id,
          tenantCompanyId: match.id,
        });
        if (holds) {
          plan.push({ step: 'LINK', action: 'SKIP', linkIndex, relation: link.relation, buildingId: link.buildingId, unitId: unit.id });
          seen.links.add(linkSeenKey);
          continue;
        }
      }
      const current = await unitPartyRoleService.listUnitPartyRoles({
        actorUserId: input.actorUserId,
        buildingId: link.buildingId,
        unitId: unit.id,
        filters: { partyRole, status: 'ACTIVE' },
        page: { limit: 200, offset: 0, page: 1, pageSize: 200 },
      });
      const foreign = current.items.filter(
        (r) => !match || r.tenantCompanyId !== match.id,
      );
      if (foreign.length > 0 && !link.replaceExisting) {
        return {
          ok: false,
          code: 'UNIT_PARTY_ROLE_ALREADY_ACTIVE',
          message: `Unit already has an ACTIVE ${partyRole}; set replaceExisting to transfer the role with an effective date.`,
        };
      }
      plan.push(
        foreign.length > 0
          ? {
              step: 'LINK',
              action: 'REPLACE',
              linkIndex,
              relation: link.relation,
              buildingId: link.buildingId,
              unitId: unit.id,
              replaceRoleIds: foreign.map((r) => r.id),
            }
          : { step: 'LINK', action: 'CREATE', linkIndex, relation: link.relation, buildingId: link.buildingId, unitId: unit.id },
      );
    }
    seen.links.add(linkSeenKey);
  }

  return { ok: true, plan, resolution };
}

function picNameOf(pic: { picName?: unknown }): string {
  return typeof pic.picName === 'string' ? pic.picName : '';
}

/**
 * CR-HM-MASTER-TENANT-BATCH-01 — upload phase.
 *
 * Rows are stored verbatim (raw payload kept for audit; reads mask identity
 * documents) with per-row structural results. `idempotencyKey` makes re-POSTs
 * of the same file replay the original batch instead of staging a second one.
 */
export async function uploadTenantImport(
  input: { clientId: string; body: unknown },
  actorUserId: string,
  audit: AuditRequestContext = {},
): Promise<{
  batch: PublicTenantImportBatch;
  rows: PublicTenantImportRow[];
  replayed: boolean;
}> {
  await assertClientAccess(actorUserId, input.clientId);
  const parsed = parseUploadBody(input.body);
  const sourceChecksum = createHash('sha256')
    .update(JSON.stringify(parsed.rows))
    .digest('hex');

  if (parsed.idempotencyKey) {
    const existing = await tenantImportRepository.findBatchByIdempotencyKey(
      input.clientId,
      parsed.idempotencyKey,
    );
    if (existing) {
      if (existing.sourceChecksum !== sourceChecksum) {
        throw tenantImportIdempotencyConflictError();
      }
      const rows = await tenantImportRepository.listAllRows(existing.id);
      return {
        batch: toPublicBatch(existing),
        rows: rows.map(toPublicRow),
        replayed: true,
      };
    }
  }

  const seenKeys = new Set<string>();
  const rowRecords: NewTenantImportRow[] = parsed.rows.map((raw, index) => {
    const rowNumber = index + 1;
    const result = parseImportRow(raw, rowNumber);
    if (result.ok) {
      if (seenKeys.has(result.rowKey)) {
        const dupKey = `${result.rowKey}::dup::${rowNumber}`;
        seenKeys.add(dupKey);
        return {
          batchId: '',
          clientId: input.clientId,
          rowNumber,
          rowKey: dupKey,
          payload: result.row,
          status: 'INVALID' as const,
          errorCode: 'DUPLICATE_ROW',
          errorMessage: 'A previous row in this batch registers the same party.',
          outcome: { phase: 'upload' },
          tenantCompanyId: null,
        };
      }
      seenKeys.add(result.rowKey);
      return {
        batchId: '',
        clientId: input.clientId,
        rowNumber,
        rowKey: result.rowKey,
        payload: result.row,
        status: 'PENDING' as const,
        errorCode: null,
        errorMessage: null,
        tenantCompanyId: null,
      };
    }
    let rowKey = result.rowKey;
    if (seenKeys.has(rowKey)) rowKey = `${rowKey}::dup::${rowNumber}`;
    seenKeys.add(rowKey);
    return {
      batchId: '',
      clientId: input.clientId,
      rowNumber,
      rowKey,
      payload: raw,
      status: 'INVALID' as const,
      errorCode: result.error.code,
      errorMessage: result.error.message,
      outcome: { phase: 'upload' },
      tenantCompanyId: null,
    };
  });

  const invalidCount = rowRecords.filter((r) => r.status === 'INVALID').length;
  const batch = await tenantImportRepository.createBatch({
    clientId: input.clientId,
    idempotencyKey: parsed.idempotencyKey ?? null,
    sourceName: parsed.sourceName,
    sourceChecksum,
    totalRows: rowRecords.length,
    createdByUserId: actorUserId,
  });
  await tenantImportRepository.insertRows(
    rowRecords.map((row) => ({ ...row, batchId: batch.id })),
  );
  await tenantImportRepository.updateBatch(batch.id, {
    invalidRows: invalidCount,
  });

  await recordEvent({
    eventType: 'TENANT_IMPORT_UPLOADED',
    outcome: 'SUCCESS',
    ...auditBase(actorUserId, audit),
    metadata: {
      batchId: batch.id,
      clientId: input.clientId,
      sourceChecksum,
      totalRows: rowRecords.length,
      invalidRows: invalidCount,
    },
  });

  const rows = await tenantImportRepository.listAllRows(batch.id);
  const updated = await tenantImportRepository.findBatchByIdUnscoped(batch.id);
  return {
    batch: toPublicBatch(updated ?? batch),
    rows: rows.map(toPublicRow),
    replayed: false,
  };
}

/**
 * Validate phase: semantic validation of every non-structural row against the
 * live masters. Per-row errors and the resolved plan (create/reuse/skip/
 * replace) are stored for the preview; the masters are untouched.
 */
export async function validateTenantImport(
  input: { clientId: string; batchId: string },
  actorUserId: string,
  audit: AuditRequestContext = {},
): Promise<{ batch: PublicTenantImportBatch; rows: PublicTenantImportRow[] }> {
  await assertClientAccess(actorUserId, input.clientId);
  const batch = await requireBatch(input.clientId, input.batchId);
  if (batch.status === 'COMMITTED' || batch.status === 'ABORTED') {
    throw tenantImportStateConflictError(
      `A ${batch.status} batch cannot be re-validated.`,
    );
  }
  if (batch.status === 'CONFIRMED') {
    throw tenantImportStateConflictError(
      'A CONFIRMED batch is frozen; abort it to stage a corrected upload.',
    );
  }

  const rows = await tenantImportRepository.listAllRows(batch.id);
  const seen = { rowKeys: new Set<string>(), links: new Set<string>() };
  let valid = 0;
  let invalid = 0;
  for (const row of rows) {
    const outcome = (row.outcome ?? {}) as { phase?: string };
    if (outcome.phase === 'upload') {
      // Structural failure recorded at upload — never re-derived.
      invalid += 1;
      continue;
    }
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const result = await validateRowSemantic(
      {
        clientId: input.clientId,
        actorUserId,
        payload,
        rowKey: row.rowKey.replace(/::dup::\d+$/, ''),
      },
      seen,
    );
    if (result.ok) {
      valid += 1;
      await tenantImportRepository.updateRow(row.id, {
        status: 'VALID',
        errorCode: null,
        errorMessage: null,
        outcome: {
          phase: 'semantic',
          resolution: result.resolution,
          plan: result.plan,
        },
      });
    } else {
      invalid += 1;
      await tenantImportRepository.updateRow(row.id, {
        status: 'INVALID',
        errorCode: result.code,
        errorMessage: result.message,
        outcome: { phase: 'semantic' },
      });
    }
  }

  const updated = await tenantImportRepository.updateBatch(batch.id, {
    status: 'VALIDATED',
    validRows: valid,
    invalidRows: invalid,
    validatedAt: new Date(),
  });
  await recordEvent({
    eventType: 'TENANT_IMPORT_VALIDATED',
    outcome: 'SUCCESS',
    ...auditBase(actorUserId, audit),
    metadata: {
      batchId: batch.id,
      clientId: input.clientId,
      validRows: valid,
      invalidRows: invalid,
    },
  });

  const refreshed = await tenantImportRepository.listAllRows(batch.id);
  return {
    batch: toPublicBatch(updated ?? batch),
    rows: refreshed.map(toPublicRow),
  };
}

/** Preview/status read (upload and validate responses share this shape). */
export async function getTenantImport(
  input: {
    clientId: string;
    batchId: string;
    rowFilters: { status?: PublicTenantImportRow['status'] };
    page: PaginationParams;
  },
  actorUserId: string,
): Promise<{
  batch: PublicTenantImportBatch;
  rows: PublicTenantImportRow[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}> {
  await assertClientAccess(actorUserId, input.clientId);
  const batch = await requireBatch(input.clientId, input.batchId);
  const rows = await tenantImportRepository.listRows(
    batch.id,
    { status: input.rowFilters.status },
    input.page.limit,
    input.page.offset,
  );
  return {
    batch: toPublicBatch(batch),
    rows: rows.items.map(toPublicRow),
    meta: {
      page: input.page.page,
      pageSize: input.page.pageSize,
      total: rows.total,
      totalPages: Math.max(1, Math.ceil(rows.total / input.page.pageSize)),
    },
  };
}

export async function listTenantImports(
  input: { clientId: string; page: PaginationParams },
  actorUserId: string,
): Promise<{
  batches: PublicTenantImportBatch[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}> {
  await assertClientAccess(actorUserId, input.clientId);
  const result = await tenantImportRepository.listBatches(
    input.clientId,
    input.page.limit,
    input.page.offset,
  );
  return {
    batches: result.items.map(toPublicBatch),
    meta: {
      page: input.page.page,
      pageSize: input.page.pageSize,
      total: result.total,
      totalPages: Math.max(1, Math.ceil(result.total / input.page.pageSize)),
    },
  };
}

/** Confirm phase: freeze the validated row set for commit. */
export async function confirmTenantImport(
  input: { clientId: string; batchId: string },
  actorUserId: string,
  audit: AuditRequestContext = {},
): Promise<PublicTenantImportBatch> {
  await assertClientAccess(actorUserId, input.clientId);
  const batch = await requireBatch(input.clientId, input.batchId);
  if (batch.status === 'CONFIRMED') return toPublicBatch(batch);
  if (batch.status !== 'VALIDATED') {
    throw tenantImportStateConflictError(
      'Only a VALIDATED batch can be confirmed.',
    );
  }
  if (batch.validRows < 1) {
    throw tenantImportEmptyError();
  }
  const updated = await tenantImportRepository.updateBatch(batch.id, {
    status: 'CONFIRMED',
    confirmedAt: new Date(),
  });
  await recordEvent({
    eventType: 'TENANT_IMPORT_CONFIRMED',
    outcome: 'SUCCESS',
    ...auditBase(actorUserId, audit),
    metadata: {
      batchId: batch.id,
      clientId: input.clientId,
      validRows: batch.validRows,
    },
  });
  return toPublicBatch(updated ?? batch);
}

async function applyPlanRow(
  input: {
    clientId: string;
    actorUserId: string;
    row: TenantImportRowRecord;
  },
): Promise<{
  status: 'COMMITTED' | 'SKIPPED_EXISTS' | 'FAILED';
  errorCode: string | null;
  errorMessage: string | null;
  outcome: Record<string, unknown>;
  tenantCompanyId: string | null;
}> {
  const payload = (input.row.payload ?? {}) as {
    party: Record<string, unknown>;
    verificationStatus?: TenantVerificationStatus;
    pics?: Record<string, unknown>[];
    unitLinks?: Record<string, unknown>[];
  };
  const outcome = (input.row.outcome ?? {}) as {
    plan?: TenantImportPlanStep[];
    resolution?: ResolvedParty;
  };
  const plan = outcome.plan ?? [];
  const verificationStatus: TenantVerificationStatus =
    payload.verificationStatus ?? 'PENDING_VERIFICATION';
  const applied: Record<string, unknown>[] = [];
  let tenantCompanyId: string | null = null;
  let changed = false;

  try {
    for (const step of plan) {
      if (step.step === 'PARTY') {
        if (step.action === 'REUSE' && outcome.resolution?.tenantCompanyId) {
          tenantCompanyId = outcome.resolution.tenantCompanyId;
          applied.push({ step: 'PARTY', action: 'REUSE', tenantCompanyId });
          continue;
        }
        try {
          const created = await tenantCompanyService.createTenantCompany(
            {
              clientId: input.clientId,
              tenantCode: step.tenantCode,
              tenantName: String(payload.party.tenantName ?? ''),
              ...(payload.party.partyKind ? { partyKind: payload.party.partyKind as 'INDIVIDUAL' | 'LEGAL_ENTITY' } : {}),
              ...(payload.party.legalName ? { legalName: String(payload.party.legalName) } : {}),
              ...(payload.party.identityDocumentType
                ? { identityDocumentType: payload.party.identityDocumentType as never }
                : {}),
              ...(payload.party.identityDocumentNumber
                ? { identityDocumentNumber: String(payload.party.identityDocumentNumber) }
                : {}),
              ...(payload.party.email ? { email: String(payload.party.email) } : {}),
              ...(payload.party.phone ? { phone: String(payload.party.phone) } : {}),
              ...(payload.party.address ? { address: String(payload.party.address) } : {}),
              ...(payload.party.status ? { status: payload.party.status as 'ACTIVE' | 'INACTIVE' } : {}),
              verificationStatus,
            },
            input.actorUserId,
          );
          tenantCompanyId = created.id;
          changed = true;
          applied.push({ step: 'PARTY', action: 'CREATE', tenantCompanyId });
        } catch (error) {
          // Concurrent create of the same party (idempotent convergence): the
          // duplicate guard wins and the row reuses the surviving master row.
          const code = error instanceof AppError ? error.code : '';
          if (
            code === 'TENANT_COMPANY_CODE_ALREADY_EXISTS' ||
            code === 'TENANT_IDENTITY_DOCUMENT_ALREADY_EXISTS'
          ) {
            const party = payload.party as {
              tenantCode?: string;
              identityDocumentType?: string;
              identityDocumentNumber?: string;
            };
            const found =
              (party.identityDocumentType && party.identityDocumentNumber
                ? await tenantCompanyRepository.findByIdentityDocument(
                    input.clientId,
                    party.identityDocumentType,
                    party.identityDocumentNumber,
                  )
                : null) ??
              (await tenantCompanyRepository.findByCodeForClient(
                input.clientId,
                step.tenantCode,
              ));
            if (!found) throw error;
            tenantCompanyId = found.id;
            applied.push({ step: 'PARTY', action: 'REUSE', tenantCompanyId });
            continue;
          }
          throw error;
        }
        continue;
      }

      if (!tenantCompanyId) {
        throw AppError.badRequest('Party must resolve before PICs and Unit relations are applied.');
      }

      if (step.step === 'PIC') {
        if (step.action === 'SKIP') {
          applied.push({ step: 'PIC', action: 'SKIP', picName: step.picName, match: step.match });
          continue;
        }
        const pic = (payload.pics ?? [])[step.picIndex] as
          | { picName: string; email?: string; phone?: string; roleTitle?: string; isPrimary?: boolean; status?: 'ACTIVE' | 'INACTIVE' }
          | undefined;
        if (!pic) continue;
        const createdPic = await tenantPicService.createTenantPic(
          {
            tenantCompanyId,
            picName: pic.picName,
            ...(pic.email ? { email: pic.email } : {}),
            ...(pic.phone ? { phone: pic.phone } : {}),
            ...(pic.roleTitle ? { roleTitle: pic.roleTitle } : {}),
            ...(pic.isPrimary !== undefined ? { isPrimary: pic.isPrimary } : {}),
            ...(pic.status ? { status: pic.status } : {}),
            verificationStatus,
          },
          input.actorUserId,
        );
        changed = true;
        applied.push({ step: 'PIC', action: 'CREATE', tenantPicId: createdPic.id });
        continue;
      }

      // LINK steps
      const link = (payload.unitLinks ?? [])[step.linkIndex] as
        | {
            relation: TenantImportRelation;
            effectiveFrom?: string;
            effectiveUntil?: string;
            replaceExisting?: boolean;
            unitId?: string;
            unitCode?: string;
          }
        | undefined;
      const effectiveFrom = link?.effectiveFrom ? new Date(link.effectiveFrom) : undefined;
      const effectiveUntil = link?.effectiveUntil ? new Date(link.effectiveUntil) : undefined;

      if (step.action === 'SKIP') {
        applied.push({ step: 'LINK', action: 'SKIP', relation: step.relation, unitId: step.unitId });
        continue;
      }
      if (step.action === 'REPLACE') {
        const closeAt = effectiveFrom ?? new Date();
        if (step.relation === 'TENANCY' && step.replaceRelationshipId) {
          await tenantSpaceService.updateTenantSpaceRelationship(
            step.replaceRelationshipId,
            { status: 'INACTIVE', effectiveUntil: closeAt },
            input.actorUserId,
          );
          changed = true;
        }
        for (const roleId of step.replaceRoleIds ?? []) {
          await endUnitPartyRole({
            actorUserId: input.actorUserId,
            unitPartyRoleId: roleId,
            effectiveUntil: closeAt,
          });
          changed = true;
        }
      }
      if (step.relation === 'TENANCY') {
        const assigned = await assignSpaceToTenant(
          {
            tenantCompanyId,
            buildingId: step.buildingId,
            spaceId: step.unitId,
            effectiveFrom: effectiveFrom ?? null,
            effectiveUntil: effectiveUntil ?? null,
          },
          input.actorUserId,
        );
        changed = true;
        applied.push({ step: 'LINK', action: step.action, relation: 'TENANCY', relationshipId: assigned.id });
      } else {
        const role = await assignUnitPartyRole({
          actorUserId: input.actorUserId,
          buildingId: step.buildingId,
          unitId: step.unitId,
          tenantCompanyId,
          partyRole: step.relation === 'PIC' ? 'PIC' : step.relation,
          ...(effectiveFrom ? { effectiveFrom } : {}),
          effectiveUntil: effectiveUntil ?? null,
        });
        changed = true;
        applied.push({ step: 'LINK', action: step.action, relation: step.relation, unitPartyRoleId: role.id });
      }
    }

    return {
      status: changed ? 'COMMITTED' : 'SKIPPED_EXISTS',
      errorCode: null,
      errorMessage: null,
      outcome: { ...(input.row.outcome ?? {}), applied },
      tenantCompanyId,
    };
  } catch (error) {
    return {
      status: 'FAILED',
      errorCode: error instanceof AppError ? error.code : 'COMMIT_FAILED',
      errorMessage: error instanceof Error ? error.message : 'Row commit failed.',
      outcome: { ...(input.row.outcome ?? {}), applied },
      tenantCompanyId,
    };
  }
}

/**
 * Commit phase: applies each VALID row independently (per-row outcomes, per-
 * row errors). Rows already resolved in an interrupted run are skipped, so a
 * retried commit after a crash converges without duplicates. A fully applied
 * row with no creates/replaces is recorded as SKIPPED_EXISTS (dedup).
 */
export async function commitTenantImport(
  input: { clientId: string; batchId: string },
  actorUserId: string,
  audit: AuditRequestContext = {},
): Promise<{
  batch: PublicTenantImportBatch;
  rows: PublicTenantImportRow[];
  replayed: boolean;
}> {
  await assertClientAccess(actorUserId, input.clientId);
  const batch = await requireBatch(input.clientId, input.batchId);
  if (batch.status === 'COMMITTED') {
    const rows = await tenantImportRepository.listAllRows(batch.id);
    return { batch: toPublicBatch(batch), rows: rows.map(toPublicRow), replayed: true };
  }
  if (batch.status !== 'CONFIRMED') {
    throw tenantImportStateConflictError(
      'Only a CONFIRMED batch can be committed.',
    );
  }

  const rows = await tenantImportRepository.listAllRows(batch.id);
  let committed = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.status !== 'VALID') continue;
    const result = await applyPlanRow({ clientId: input.clientId, actorUserId, row });
    await tenantImportRepository.updateRow(row.id, {
      status: result.status,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      outcome: result.outcome,
      tenantCompanyId: result.tenantCompanyId,
    });
    if (result.status === 'COMMITTED') committed += 1;
    if (result.status === 'SKIPPED_EXISTS') skipped += 1;
  }

  const updated = await tenantImportRepository.updateBatch(batch.id, {
    status: 'COMMITTED',
    committedRows: committed,
    skippedRows: skipped,
    committedAt: new Date(),
  });
  await recordEvent({
    eventType: 'TENANT_IMPORT_COMMITTED',
    outcome: 'SUCCESS',
    ...auditBase(actorUserId, audit),
    metadata: {
      batchId: batch.id,
      clientId: input.clientId,
      committedRows: committed,
      skippedRows: skipped,
    },
  });

  const refreshed = await tenantImportRepository.listAllRows(batch.id);
  return {
    batch: toPublicBatch(updated ?? batch),
    rows: refreshed.map(toPublicRow),
    replayed: false,
  };
}

/** Abort = the rollback of a staged batch: nothing was created yet. */
export async function abortTenantImport(
  input: { clientId: string; batchId: string },
  actorUserId: string,
  audit: AuditRequestContext = {},
): Promise<PublicTenantImportBatch> {
  await assertClientAccess(actorUserId, input.clientId);
  const batch = await requireBatch(input.clientId, input.batchId);
  if (batch.status === 'ABORTED') return toPublicBatch(batch);
  if (batch.status === 'COMMITTED') {
    throw tenantImportStateConflictError(
      'A COMMITTED batch cannot be aborted; its rows are real master data.',
    );
  }
  const updated = await tenantImportRepository.updateBatch(batch.id, {
    status: 'ABORTED',
    abortedAt: new Date(),
  });
  await recordEvent({
    eventType: 'TENANT_IMPORT_ABORTED',
    outcome: 'SUCCESS',
    ...auditBase(actorUserId, audit),
    metadata: { batchId: batch.id, clientId: input.clientId },
  });
  return toPublicBatch(updated ?? batch);
}

export const tenantImportService = {
  abortTenantImport,
  commitTenantImport,
  confirmTenantImport,
  getTenantImport,
  listTenantImports,
  uploadTenantImport,
  validateTenantImport,
};
