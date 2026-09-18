import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import {
  inventoryItemInactiveError,
  inventoryItemNotFoundError,
  inventoryItemUomClientMismatchError,
  inventoryItemUomInactiveError,
  inventoryItemUomNotFoundError,
} from '../inventory-items';
import { handymanJobNotFoundError } from '../handyman-jobs/handyman-job.errors';
import { handymanJobRepository } from '../handyman-jobs/handyman-job.repository';
import { handymanServiceVisitRepository } from '../handyman-jobs/handyman-service-visit.repository';
import { resolveFieldActorActiveBindingIds } from '../handyman-jobs/handyman-visit-lead-chain';
import { handymanWorkCrewRepository } from '../handyman-work-crews';
import { inventoryMaterialReservationRepository } from '../inventory-material-reservations/inventory-material-reservation.repository';
import {
  handymanRequestNotFoundError,
  handymanRequestRepository,
} from '../handyman-requests';
import { recordOperationalEvent } from '../operational-events';
import {
  priceCatalogLookupService,
  type PriceCatalogCurrency,
} from '../price-catalog-entries';
import { tenantCompanyRepository } from '../tenant-companies';
import { tenantPicRepository } from '../tenant-pics';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import { handymanQuotationApprovalRepository } from '../handyman-quotations/handyman-quotation-approval.repository';
import { handymanQuotationLineRepository } from '../handyman-quotations/handyman-quotation-line.repository';
import { handymanQuotationRepository } from '../handyman-quotations/handyman-quotation.repository';
import { handymanQuotationRevisionRepository } from '../handyman-quotations/handyman-quotation-revision.repository';
import type {
  HandymanQuotationLineRecord,
  HandymanQuotationRecord,
} from '../handyman-quotations/handyman-quotation.types';
import type { HandymanJobRecord } from '../handyman-jobs/handyman-job.types';
import type { HandymanRequestRecord } from '../handyman-requests/handyman-request.types';
import {
  handymanMaterialAddendumIdempotencyConflictError,
  handymanMaterialAddendumNotFoundError,
  handymanMaterialAddendumPriceUnresolvedError,
  handymanMaterialAddendumStateInvalidError,
  handymanMaterialApprovalForInvalidError,
  handymanMaterialApprovalIdempotencyConflictError,
  handymanMaterialApprovalNotAuthorizedError,
  handymanMaterialApprovalNotFoundError,
  handymanMaterialApprovalNotPendingError,
  handymanMaterialApprovalNotesRequiredError,
  handymanMaterialDemandContextInvalidError,
  handymanMaterialDemandIdempotencyConflictError,
  handymanMaterialDemandNotFoundError,
  handymanMaterialDemandStateInvalidError,
} from './handyman-material-demand.errors';
import {
  handymanMaterialDemandRepository,
  type NewHandymanMaterialCommercialAddendum,
  type NewHandymanMaterialDemand,
} from './handyman-material-demand.repository';
import type {
  CancelHandymanMaterialCommercialAddendumInput,
  CancelHandymanMaterialDemandInput,
  CreateCustomerSuppliedMaterialDemandInput,
  CreateHandymanMaterialCommercialAddendumInput,
  CreateNonChargeableMaterialDemandInput,
  CreateQuotationIncludedMaterialDemandInput,
  DecideHandymanMaterialApprovalInAppInput,
  HandymanMaterialAddendumCancellationResult,
  HandymanMaterialAddendumCreationResult,
  HandymanMaterialApprovalDecision,
  HandymanMaterialApprovalDecisionResult,
  HandymanMaterialApprovalMethod,
  HandymanMaterialApprovalRecord,
  HandymanMaterialCancellationReason,
  HandymanMaterialCommercialAddendumRecord,
  HandymanMaterialDemandCancellationResult,
  HandymanMaterialDemandCreationResult,
  HandymanMaterialDemandRecord,
  HandymanMaterialDemandSource,
  HandymanMaterialSupplySource,
  PublicHandymanMaterialApproval,
  PublicHandymanMaterialCommercialAddendum,
  PublicHandymanMaterialDemand,
  RecordHandymanMaterialApprovalAssistedInput,
} from './handyman-material-demand.types';

/**
 * CR-HM-BE-07 RUN 1 — service authority for material demand facts only.
 *
 * This module intentionally never writes inventory balances/movements,
 * reservations, requests, quotations, jobs, work orders, invoices, payments,
 * fees, ledgers, or documents. It derives immutable material scope from the
 * existing job/request/quotation context and leaves later fulfilment and HTTP
 * exposure to later runs.
 */

type Executor = Pick<PoolClient, 'query'>;

type MaterialJobContext = {
  job: HandymanJobRecord;
  request: HandymanRequestRecord;
  quotation: HandymanQuotationRecord;
};

type ResolvedMaterialSubject = {
  inventoryItemId: string | null;
  uomId: string;
  description: string;
};

type ApprovedForSnapshot = {
  approvedForType: 'TENANT_COMPANY' | 'TENANT_PIC' | 'CUSTOMER';
  approvedForTenantCompanyId: string | null;
  approvedForTenantPicId: string | null;
  approvedForName: string;
};

function isEffectiveNow(record: {
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
}): boolean {
  const now = Date.now();
  return (
    (record.effectiveFrom === null || record.effectiveFrom.getTime() <= now) &&
    (record.effectiveUntil === null || record.effectiveUntil.getTime() >= now)
  );
}

function fingerprint(command: string, facts: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify({ command, ...facts }))
    .digest('hex');
}

function assertFingerprint(
  storedFingerprint: string | null,
  expectedFingerprint: string,
  conflict: () => Error,
): void {
  if (storedFingerprint !== expectedFingerprint) throw conflict();
}

function parseRequiredIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field: 'idempotencyKey', message: 'Idempotency key is required.' },
    ]);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'idempotencyKey',
        message: 'Idempotency key must contain 1 to 200 characters.',
      },
    ]);
  }
  return trimmed;
}

function parsePositiveQuantity(value: unknown): string {
  const raw =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? value.toString()
        : ''
      : typeof value === 'string'
        ? value.trim()
        : '';
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(raw);
  if (!match) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'quantity',
        message: 'Quantity must be a positive decimal with at most 4 fraction digits.',
      },
    ]);
  }
  const integer = match[1].replace(/^0+(?=\d)/, '');
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  const canonical = fraction ? `${integer}.${fraction}` : integer;
  if (canonical === '0' || integer.length > 14) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'quantity',
        message: 'Quantity must be greater than zero and fit the material quantity precision.',
      },
    ]);
  }
  return canonical;
}

function parseOptionalDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field: 'description', message: 'Description must be a string.' },
    ]);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 1000) {
    throw AppError.validation('Request validation failed.', [
      { field: 'description', message: 'Description must be at most 1000 characters.' },
    ]);
  }
  return trimmed;
}

function parseOptionalDecisionNotes(
  value: unknown,
  options: { required: boolean },
): string | null {
  if (value === undefined || value === null) {
    if (options.required) throw handymanMaterialApprovalNotesRequiredError();
    return null;
  }
  if (typeof value !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field: 'notes', message: 'Notes must be a string.' },
    ]);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (options.required) throw handymanMaterialApprovalNotesRequiredError();
    return null;
  }
  if (trimmed.length > 2000) {
    throw AppError.validation('Request validation failed.', [
      { field: 'notes', message: 'Notes must be at most 2000 characters.' },
    ]);
  }
  return trimmed;
}

function parseSupplySource(value: unknown): HandymanMaterialSupplySource {
  if (value === 'PROVIDER_STOCK' || value === 'CUSTOMER_SUPPLIED') return value;
  throw AppError.validation('Request validation failed.', [
    {
      field: 'supplySource',
      message: 'Supply source must be PROVIDER_STOCK or CUSTOMER_SUPPLIED.',
    },
  ]);
}

function parseOperationalSource(value: unknown): HandymanMaterialDemandSource {
  if (value === undefined || value === null) return 'INTERNAL_OPERATION';
  if (value === 'INTERNAL_OPERATION' || value === 'FIELD_DISCOVERED') return value;
  throw AppError.validation('Request validation failed.', [
    {
      field: 'sourceContext',
      message: 'Source context must be INTERNAL_OPERATION or FIELD_DISCOVERED.',
    },
  ]);
}

function parseCancellationReason(value: unknown): HandymanMaterialCancellationReason {
  if (
    value === 'CUSTOMER_WITHDREW' ||
    value === 'SCOPE_NO_LONGER_REQUIRED' ||
    value === 'OTHER_OPERATIONAL'
  ) {
    return value;
  }
  throw AppError.validation('Request validation failed.', [
    {
      field: 'reason',
      message:
        'Reason must be CUSTOMER_WITHDREW, SCOPE_NO_LONGER_REQUIRED, or OTHER_OPERATIONAL.',
    },
  ]);
}

function parseDecision(value: unknown): HandymanMaterialApprovalDecision {
  if (value === 'APPROVED' || value === 'REJECTED') return value;
  throw AppError.validation('Request validation failed.', [
    { field: 'decision', message: 'Decision must be APPROVED or REJECTED.' },
  ]);
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a UUID.` },
    ]);
  }
  return value;
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requireUuid(value, field);
}

function quantityToNumber(value: string): number {
  return Number(value);
}

function amountToNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/** Privacy-safe projection: no idempotency facts, customer name/contact, or notes. */
export function toPublicHandymanMaterialDemand(
  record: HandymanMaterialDemandRecord,
): PublicHandymanMaterialDemand {
  return {
    id: record.id,
    clientId: record.clientId,
    handymanJobId: record.handymanJobId,
    handymanRequestId: record.handymanRequestId,
    buildingId: record.buildingId,
    supplySource: record.supplySource,
    commercialBasis: record.commercialBasis,
    sourceContext: record.sourceContext,
    inventoryItemId: record.inventoryItemId,
    uomId: record.uomId,
    description: record.description,
    quantity: quantityToNumber(record.quantity),
    handymanServiceVisitId: record.handymanServiceVisitId,
    quotationRevisionId: record.quotationRevisionId,
    handymanQuotationLineId: record.handymanQuotationLineId,
    commercialAddendumId: record.commercialAddendumId,
    handymanMaterialApprovalId: record.handymanMaterialApprovalId,
    status: record.status,
    supersedesDemandId: record.supersedesDemandId,
    supersededAt: record.supersededAt ? record.supersededAt.toISOString() : null,
    supersededByUserId: record.supersededByUserId,
    cancelledAt: record.cancelledAt ? record.cancelledAt.toISOString() : null,
    cancelledByUserId: record.cancelledByUserId,
    cancellationReason: record.cancellationReason,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toPublicHandymanMaterialCommercialAddendum(
  record: HandymanMaterialCommercialAddendumRecord,
): PublicHandymanMaterialCommercialAddendum {
  return {
    id: record.id,
    clientId: record.clientId,
    handymanJobId: record.handymanJobId,
    handymanRequestId: record.handymanRequestId,
    buildingId: record.buildingId,
    supplySource: record.supplySource,
    commercialBasis: record.commercialBasis,
    inventoryItemId: record.inventoryItemId,
    uomId: record.uomId,
    description: record.description,
    quantity: quantityToNumber(record.quantity),
    currency: record.currency,
    unitCommercialAmount: amountToNumber(record.unitCommercialAmount),
    totalCommercialAmount: amountToNumber(record.totalCommercialAmount),
    referencePriceCatalogEntryId: record.referencePriceCatalogEntryId,
    referenceScopeTier: record.referenceScopeTier,
    referenceAsOf: record.referenceAsOf ? record.referenceAsOf.toISOString() : null,
    status: record.status,
    supersedesAddendumId: record.supersedesAddendumId,
    supersededAt: record.supersededAt ? record.supersededAt.toISOString() : null,
    supersededByUserId: record.supersededByUserId,
    cancelledAt: record.cancelledAt ? record.cancelledAt.toISOString() : null,
    cancelledByUserId: record.cancelledByUserId,
    cancellationReason: record.cancellationReason,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toPublicHandymanMaterialApproval(
  record: HandymanMaterialApprovalRecord,
): PublicHandymanMaterialApproval {
  return {
    id: record.id,
    clientId: record.clientId,
    handymanJobId: record.handymanJobId,
    handymanRequestId: record.handymanRequestId,
    buildingId: record.buildingId,
    commercialAddendumId: record.commercialAddendumId,
    status: record.status,
    method: record.method,
    approvedForType: record.approvedForType,
    approvedForTenantCompanyId: record.approvedForTenantCompanyId,
    approvedForTenantPicId: record.approvedForTenantPicId,
    recordedByUserId: record.recordedByUserId,
    decidedAt: record.decidedAt ? record.decidedAt.toISOString() : null,
    cancelledAt: record.cancelledAt ? record.cancelledAt.toISOString() : null,
    cancelledByUserId: record.cancelledByUserId,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function loadMaterialJobContext(
  handymanJobId: string,
  executor: Executor,
  options: { forUpdate?: boolean } = {},
): Promise<MaterialJobContext> {
  if (!isValidUuid(handymanJobId)) throw handymanJobNotFoundError();
  const job = options.forUpdate
    ? await handymanJobRepository.lockById(handymanJobId, executor)
    : await handymanJobRepository.findById(handymanJobId, executor);
  if (!job) throw handymanJobNotFoundError();

  const request = await handymanRequestRepository.findById(
    job.handymanRequestId,
    executor,
  );
  if (!request) throw handymanRequestNotFoundError();
  const quotation = await handymanQuotationRepository.findById(
    job.handymanQuotationId,
    executor,
  );
  if (!quotation) {
    throw handymanMaterialDemandContextInvalidError(
      'The job no longer resolves to its authoritative quotation.',
    );
  }
  if (
    request.clientId !== job.clientId ||
    quotation.clientId !== job.clientId ||
    quotation.buildingId !== request.buildingId ||
    quotation.requestId !== request.id ||
    quotation.sentRevisionId !== job.handymanQuotationRevisionId
  ) {
    throw handymanMaterialDemandContextInvalidError(
      'The job/request/quotation authority chain is inconsistent.',
    );
  }
  return { job, request, quotation };
}

async function lockIdempotencyKey(
  tx: Executor,
  namespace: string,
  clientId: string,
  key: string,
): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
    `${namespace}:${clientId}`,
    key,
  ]);
}

async function assertStaffBuildingAccess(
  context: MaterialJobContext,
  actorUserId: string,
): Promise<void> {
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    context.request.buildingId,
  );
}

/**
 * Field-discovered scope must prove the existing chain rather than trusting a
 * submitted crew/member identity: user -> active workforce binding -> active
 * job composition -> active crew lead, plus a visit for this exact job.
 */
async function assertFieldDiscoveryLead(
  context: MaterialJobContext,
  handymanServiceVisitId: string,
  actorUserId: string,
  executor?: Executor,
): Promise<void> {
  if (!isValidUuid(handymanServiceVisitId)) {
    throw handymanMaterialDemandContextInvalidError(
      'A field-discovered material demand requires a valid service visit.',
    );
  }
  const visit = await handymanServiceVisitRepository.findVisitById(
    handymanServiceVisitId,
    executor,
  );
  if (
    !visit ||
    visit.handymanJobId !== context.job.id ||
    visit.clientId !== context.job.clientId
  ) {
    throw handymanMaterialDemandContextInvalidError(
      'The field-discovered material visit does not belong to this job.',
    );
  }
  const bindingIds = await resolveFieldActorActiveBindingIds(actorUserId);
  if (bindingIds.length === 0) throw buildingAccessDeniedError();
  const composition = await handymanJobRepository.findActiveByJobId(
    context.job.id,
    executor,
  );
  if (!composition) throw buildingAccessDeniedError();
  const lead = await handymanWorkCrewRepository.findActiveLead(
    composition.handymanWorkCrewId,
    executor,
  );
  if (!lead || !bindingIds.includes(lead.vendorWorkforceBindingId)) {
    throw buildingAccessDeniedError();
  }
}

async function validateMaterialSubject(
  input: {
    supplySource: HandymanMaterialSupplySource;
    inventoryItemId: string | null;
    uomId: string;
    description: string | null;
  },
  clientId: string,
  executor: Executor,
): Promise<ResolvedMaterialSubject> {
  const uomResult = await executor.query<{
    id: string;
    clientId: string;
    status: string;
  }>(
    `SELECT id, client_id AS "clientId", status
     FROM units_of_measure
     WHERE id = $1`,
    [input.uomId],
  );
  const uom = uomResult.rows[0];
  if (!uom) throw inventoryItemUomNotFoundError();
  if (uom.clientId !== clientId) throw inventoryItemUomClientMismatchError();
  if (uom.status !== 'ACTIVE') throw inventoryItemUomInactiveError();

  if (input.supplySource === 'PROVIDER_STOCK' && !input.inventoryItemId) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'inventoryItemId',
        message: 'PROVIDER_STOCK material requires an inventoryItemId.',
      },
    ]);
  }

  if (!input.inventoryItemId) {
    if (!input.description) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'description',
          message: 'Customer-supplied material without an item master requires a description.',
        },
      ]);
    }
    return {
      inventoryItemId: null,
      uomId: uom.id,
      description: input.description,
    };
  }

  const itemResult = await executor.query<{
    id: string;
    clientId: string;
    name: string;
    status: string;
  }>(
    `SELECT id, client_id AS "clientId", name, status
     FROM inventory_items
     WHERE id = $1`,
    [input.inventoryItemId],
  );
  const item = itemResult.rows[0];
  // Cross-client material masters are deliberately indistinguishable from an
  // unknown item at this job-scoped boundary.
  if (!item || item.clientId !== clientId) throw inventoryItemNotFoundError();
  if (item.status !== 'ACTIVE') throw inventoryItemInactiveError();
  return {
    inventoryItemId: item.id,
    uomId: uom.id,
    description: input.description ?? item.name,
  };
}

async function resolveProviderStockAddendumPrice(
  context: MaterialJobContext,
  subject: ResolvedMaterialSubject,
  actorUserId: string,
): Promise<{
  currency: PriceCatalogCurrency;
  unitCommercialAmount: string;
  referencePriceCatalogEntryId: string;
  referenceScopeTier: string;
  referenceAsOf: Date;
} | null> {
  if (!subject.inventoryItemId) {
    throw handymanMaterialAddendumPriceUnresolvedError();
  }
  const result = await priceCatalogLookupService.lookupPriceCatalogEntry(
    {
      buildingId: context.request.buildingId,
      vendorId: null,
      currency: context.quotation.currency,
      asOf: new Date().toISOString(),
      sourceMode: 'MATERIAL',
      itemId: subject.inventoryItemId,
      uomId: subject.uomId,
    },
    actorUserId,
  );
  if (
    result.resolution !== 'MATCHED' ||
    !result.entry ||
    !result.scopeTier ||
    result.clientId !== context.job.clientId ||
    result.entry.clientId !== context.job.clientId ||
    result.entry.sourceMode !== 'MATERIAL' ||
    result.entry.itemId !== subject.inventoryItemId ||
    result.entry.uomId !== subject.uomId ||
    result.entry.currency !== context.quotation.currency
  ) {
    throw handymanMaterialAddendumPriceUnresolvedError();
  }
  const amount = Number(result.entry.unitPrice);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw handymanMaterialAddendumPriceUnresolvedError();
  }
  return {
    currency: result.entry.currency,
    // Price-catalog monetary precision is two decimal places; this stores its
    // exact resolved snapshot rather than accepting a caller-authored amount.
    unitCommercialAmount: amount.toFixed(2),
    referencePriceCatalogEntryId: result.entry.id,
    referenceScopeTier: result.scopeTier,
    referenceAsOf: new Date(result.asOf),
  };
}

async function resolveAuthorizedTenantPic(
  request: HandymanRequestRecord,
  actorUserId: string,
): Promise<{ picId: string; picName: string; companyId: string }> {
  if (!request.tenantPicId || !request.tenantCompanyId) {
    throw handymanMaterialApprovalNotAuthorizedError(
      'This request has no authorized tenant PIC for an in-app material decision.',
    );
  }
  const pic = await tenantPicRepository.findById(request.tenantPicId);
  if (!pic || pic.status !== 'ACTIVE' || pic.userId !== actorUserId) {
    throw handymanMaterialApprovalNotAuthorizedError();
  }
  if (pic.tenantCompanyId !== request.tenantCompanyId) {
    throw handymanMaterialApprovalNotAuthorizedError(
      'The tenant PIC is not linked to the request tenant company.',
    );
  }
  const company = await tenantCompanyRepository.findById(pic.tenantCompanyId);
  if (!company || company.status !== 'ACTIVE' || company.clientId !== request.clientId) {
    throw handymanMaterialApprovalNotAuthorizedError(
      'The request tenant company is not active in this client.',
    );
  }
  const buildingContext = await tenantBuildingContextRepository.findActive(
    company.id,
    request.buildingId,
  );
  if (!buildingContext || !isEffectiveNow(buildingContext)) {
    throw handymanMaterialApprovalNotAuthorizedError(
      'The request tenant company has no active effective building context.',
    );
  }
  return { picId: pic.id, picName: pic.picName, companyId: company.id };
}

async function resolveAssistedApprovedFor(
  input: RecordHandymanMaterialApprovalAssistedInput['approvedFor'],
  request: HandymanRequestRecord,
): Promise<ApprovedForSnapshot> {
  if (!input || typeof input !== 'object') {
    throw handymanMaterialApprovalForInvalidError();
  }
  if (input.type === 'CUSTOMER') {
    return {
      approvedForType: 'CUSTOMER',
      approvedForTenantCompanyId: null,
      approvedForTenantPicId: null,
      // Server-derived snapshot only; it never appears in public read models
      // or operational-event payloads.
      approvedForName: request.customerName,
    };
  }
  if (input.type === 'TENANT_COMPANY') {
    // The caller selects only the party kind; request lineage supplies the
    // actual company identity so a staff recorder cannot nominate a customer.
    if (!request.tenantCompanyId) {
      throw handymanMaterialApprovalForInvalidError(
        'The request has no approved-for tenant company context.',
      );
    }
    const company = await tenantCompanyRepository.findById(request.tenantCompanyId);
    if (!company || company.status !== 'ACTIVE' || company.clientId !== request.clientId) {
      throw handymanMaterialApprovalForInvalidError(
        'The approved-for tenant company is not active in this client.',
      );
    }
    const buildingContext = await tenantBuildingContextRepository.findActive(
      company.id,
      request.buildingId,
    );
    if (!buildingContext || !isEffectiveNow(buildingContext)) {
      throw handymanMaterialApprovalForInvalidError(
        'The approved-for tenant company has no active effective building context.',
      );
    }
    return {
      approvedForType: 'TENANT_COMPANY',
      approvedForTenantCompanyId: company.id,
      approvedForTenantPicId: null,
      approvedForName: company.tenantName,
    };
  }
  if (input.type === 'TENANT_PIC') {
    if (!request.tenantPicId || !request.tenantCompanyId) {
      throw handymanMaterialApprovalForInvalidError(
        'The request has no approved-for tenant PIC context.',
      );
    }
    const pic = await tenantPicRepository.findById(request.tenantPicId);
    if (!pic || pic.status !== 'ACTIVE') {
      throw handymanMaterialApprovalForInvalidError(
        'The approved-for tenant PIC is not active.',
      );
    }
    if (pic.tenantCompanyId !== request.tenantCompanyId) {
      throw handymanMaterialApprovalForInvalidError(
        'The approved-for tenant PIC is not linked to the request tenant company.',
      );
    }
    const company = await tenantCompanyRepository.findById(pic.tenantCompanyId);
    if (!company || company.status !== 'ACTIVE' || company.clientId !== request.clientId) {
      throw handymanMaterialApprovalForInvalidError(
        'The approved-for tenant PIC company is not active in this client.',
      );
    }
    const buildingContext = await tenantBuildingContextRepository.findActive(
      company.id,
      request.buildingId,
    );
    if (!buildingContext || !isEffectiveNow(buildingContext)) {
      throw handymanMaterialApprovalForInvalidError(
        'The approved-for tenant PIC company has no active effective building context.',
      );
    }
    return {
      approvedForType: 'TENANT_PIC',
      approvedForTenantCompanyId: company.id,
      approvedForTenantPicId: pic.id,
      approvedForName: pic.picName,
    };
  }
  throw handymanMaterialApprovalForInvalidError(
    'approvedFor must identify a TENANT_COMPANY, TENANT_PIC, or CUSTOMER.',
  );
}

function assertAddendumContext(
  addendum: HandymanMaterialCommercialAddendumRecord,
  context: MaterialJobContext,
): void {
  if (
    addendum.clientId !== context.job.clientId ||
    addendum.handymanJobId !== context.job.id ||
    addendum.handymanRequestId !== context.request.id ||
    addendum.buildingId !== context.request.buildingId
  ) {
    throw handymanMaterialDemandContextInvalidError(
      'The commercial addendum does not belong to its job/request context.',
    );
  }
}

function assertApprovalContext(
  approval: HandymanMaterialApprovalRecord,
  addendum: HandymanMaterialCommercialAddendumRecord,
  context: MaterialJobContext,
): void {
  if (
    approval.clientId !== context.job.clientId ||
    approval.handymanJobId !== context.job.id ||
    approval.handymanRequestId !== context.request.id ||
    approval.buildingId !== context.request.buildingId ||
    approval.commercialAddendumId !== addendum.id
  ) {
    throw handymanMaterialDemandContextInvalidError(
      'The material approval does not belong to its addendum/job context.',
    );
  }
}

async function addendumCreationResult(
  addendum: HandymanMaterialCommercialAddendumRecord,
  replayed: boolean,
  executor?: Executor,
): Promise<HandymanMaterialAddendumCreationResult> {
  const approval = await handymanMaterialDemandRepository.findApprovalByAddendumId(
    addendum.id,
    executor,
  );
  if (!approval) {
    throw handymanMaterialDemandContextInvalidError(
      'A commercial addendum is missing its dedicated approval fact.',
    );
  }
  return {
    addendum: toPublicHandymanMaterialCommercialAddendum(addendum),
    approval: toPublicHandymanMaterialApproval(approval),
    replayed,
  };
}

async function approvalDecisionResult(
  approval: HandymanMaterialApprovalRecord,
  replayed: boolean,
  executor?: Executor,
): Promise<HandymanMaterialApprovalDecisionResult> {
  const addendum = await handymanMaterialDemandRepository.findAddendumById(
    approval.commercialAddendumId,
    executor,
  );
  if (!addendum) throw handymanMaterialAddendumNotFoundError();
  const demand = await handymanMaterialDemandRepository.findDemandByApprovalId(
    approval.id,
    executor,
  );
  return {
    approval: toPublicHandymanMaterialApproval(approval),
    addendum: toPublicHandymanMaterialCommercialAddendum(addendum),
    demand: demand ? toPublicHandymanMaterialDemand(demand) : null,
    replayed,
  };
}

async function recordMaterialEvent(
  context: MaterialJobContext,
  input: {
    eventType: string;
    entityType: string;
    entityId: string;
    actorUserId: string;
    summary: string;
    metadata: Record<string, unknown>;
  },
  tx: Executor,
): Promise<void> {
  await recordOperationalEvent(
    {
      clientId: context.job.clientId,
      buildingId: context.request.buildingId,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      actorUserId: input.actorUserId,
      summary: input.summary,
      // Callers pass only identifiers/statuses/enums — never descriptions,
      // customer identities, raw notes, pricing, payment, URLs, or tokens.
      metadata: input.metadata,
    },
    tx,
  );
}

/**
 * Creates exactly one active demand for an exact approved job-bound quotation
 * MATERIAL line. No caller can submit source, price, quantity, description,
 * item/UOM, client, request, customer, or revision facts.
 */
export async function createQuotationIncludedMaterialDemand(
  input: CreateQuotationIncludedMaterialDemandInput,
  actorUserId: string,
): Promise<HandymanMaterialDemandCreationResult> {
  const handymanJobId =
    typeof input.handymanJobId === 'string' && isValidUuid(input.handymanJobId)
      ? input.handymanJobId
      : (() => {
          throw handymanJobNotFoundError();
        })();
  const handymanQuotationLineId = requireUuid(
    input.handymanQuotationLineId,
    'handymanQuotationLineId',
  );
  const idempotencyKey = parseRequiredIdempotencyKey(input.idempotencyKey);
  const idempotencyFingerprint = fingerprint('CREATE_QUOTATION_INCLUDED_DEMAND', {
    handymanJobId,
    handymanQuotationLineId,
  });

  const preview = await loadMaterialJobContext(
    handymanJobId,
    // This lightweight executor is only used for the pre-access context read.
    // Revalidation happens under the job lock below.
    getPool(),
  );
  await assertStaffBuildingAccess(preview, actorUserId);
  const replay = await handymanMaterialDemandRepository.findDemandByIdempotencyKey(
    preview.job.clientId,
    idempotencyKey,
  );
  if (replay) {
    assertFingerprint(
      replay.idempotencyFingerprint,
      idempotencyFingerprint,
      handymanMaterialDemandIdempotencyConflictError,
    );
    return { demand: toPublicHandymanMaterialDemand(replay), replayed: true };
  }

  return withTransaction(async (tx) => {
    const context = await loadMaterialJobContext(handymanJobId, tx, {
      forUpdate: true,
    });
    await assertStaffBuildingAccess(context, actorUserId);
    await lockIdempotencyKey(
      tx,
      'handyman_material_demands',
      context.job.clientId,
      idempotencyKey,
    );
    const existing = await handymanMaterialDemandRepository.findDemandByIdempotencyKey(
      context.job.clientId,
      idempotencyKey,
      tx,
    );
    if (existing) {
      assertFingerprint(
        existing.idempotencyFingerprint,
        idempotencyFingerprint,
        handymanMaterialDemandIdempotencyConflictError,
      );
      return { demand: toPublicHandymanMaterialDemand(existing), replayed: true };
    }

    if (context.quotation.status !== 'APPROVED') {
      throw handymanMaterialDemandContextInvalidError(
        'Quotation-included material demands require an approved quotation.',
      );
    }
    const revision = await handymanQuotationRevisionRepository.findById(
      context.job.handymanQuotationRevisionId,
      tx,
    );
    const line = await handymanQuotationLineRepository.findById(
      handymanQuotationLineId,
      tx,
    );
    const approved = await handymanQuotationApprovalRepository.listByRevision(
      context.job.handymanQuotationRevisionId,
      tx,
    );
    if (
      !revision ||
      revision.quotationId !== context.quotation.id ||
      revision.status !== 'SUBMITTED' ||
      !line ||
      line.quotationRevisionId !== revision.id ||
      line.quotationId !== context.quotation.id ||
      line.clientId !== context.job.clientId ||
      line.buildingId !== context.request.buildingId ||
      line.lineType !== 'MATERIAL' ||
      !line.inventoryItemId ||
      !line.uomId ||
      !line.quantity ||
      !approved.some((approval) => approval.status === 'APPROVED')
    ) {
      throw handymanMaterialDemandContextInvalidError(
        'The demand must derive from one exact approved MATERIAL quotation line.',
      );
    }
    const lineDescription = line.description ?? line.subjectName;
    if (!lineDescription) {
      throw handymanMaterialDemandContextInvalidError(
        'The approved MATERIAL quotation line has no executable description snapshot.',
      );
    }
    // Current master validation is read-only and makes inactive Provider stock
    // fail closed; it never writes stock/reservation/movement state.
    await validateMaterialSubject(
      {
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: line.inventoryItemId,
        uomId: line.uomId,
        description: lineDescription,
      },
      context.job.clientId,
      tx,
    );

    const priorDemand =
      await handymanMaterialDemandRepository.findDemandByQuotationLine(
        context.job.id,
        line.id,
        tx,
      );
    if (priorDemand) {
      // This is not a key replay: a different command key must not silently
      // acquire a prior demand's identity and then be reusable for changed
      // facts. A closed included fact also remains immutable history rather
      // than becoming an unlinked replacement for the same quote line.
      throw handymanMaterialDemandStateInvalidError(
        'A quotation-included material demand already exists for this exact job quotation line.',
      );
    }

    const created = await handymanMaterialDemandRepository.createDemand(
      {
        clientId: context.job.clientId,
        handymanJobId: context.job.id,
        handymanRequestId: context.request.id,
        buildingId: context.request.buildingId,
        supplySource: 'PROVIDER_STOCK',
        commercialBasis: 'QUOTATION_INCLUDED',
        sourceContext: 'QUOTATION_INCLUDED',
        inventoryItemId: line.inventoryItemId,
        uomId: line.uomId,
        description: lineDescription,
        quantity: line.quantity,
        handymanServiceVisitId: null,
        quotationRevisionId: revision.id,
        handymanQuotationLineId: line.id,
        commercialAddendumId: null,
        handymanMaterialApprovalId: null,
        supersedesDemandId: null,
        idempotencyKey,
        idempotencyFingerprint,
        createdByUserId: actorUserId,
      },
      tx,
    );
    if (!created) {
      const winner = await handymanMaterialDemandRepository.findDemandByIdempotencyKey(
        context.job.clientId,
        idempotencyKey,
        tx,
      );
      if (!winner) throw new Error('Material demand idempotency winner could not be loaded.');
      assertFingerprint(
        winner.idempotencyFingerprint,
        idempotencyFingerprint,
        handymanMaterialDemandIdempotencyConflictError,
      );
      return { demand: toPublicHandymanMaterialDemand(winner), replayed: true };
    }
    await recordMaterialEvent(
      context,
      {
        eventType: 'HANDYMAN_MATERIAL_DEMAND_CREATED',
        entityType: 'HANDYMAN_MATERIAL_DEMAND',
        entityId: created.id,
        actorUserId,
        summary: 'Handyman material demand created.',
        metadata: {
          demandId: created.id,
          commercialBasis: created.commercialBasis,
          sourceContext: created.sourceContext,
          status: created.status,
          quotationRevisionId: created.quotationRevisionId,
          quotationLineId: created.handymanQuotationLineId,
        },
      },
      tx,
    );
    return { demand: toPublicHandymanMaterialDemand(created), replayed: false };
  });
}

/**
 * Creates a non-chargeable operational demand. Customer-supplied and
 * Provider-stock remain explicit source choices, and neither lane writes or
 * reserves inventory in Run 1. Changed scope can only be represented as a
 * successor of another active non-chargeable demand.
 */
export async function createNonChargeableMaterialDemand(
  input: CreateNonChargeableMaterialDemandInput,
  actorUserId: string,
): Promise<HandymanMaterialDemandCreationResult> {
  const handymanJobId =
    typeof input.handymanJobId === 'string' && isValidUuid(input.handymanJobId)
      ? input.handymanJobId
      : (() => {
          throw handymanJobNotFoundError();
        })();
  const supplySource = parseSupplySource(input.supplySource);
  const inventoryItemId = optionalUuid(input.inventoryItemId, 'inventoryItemId');
  const uomId = requireUuid(input.uomId, 'uomId');
  const description = parseOptionalDescription(input.description);
  const quantity = parsePositiveQuantity(input.quantity);
  const sourceContext = parseOperationalSource(input.sourceContext);
  const handymanServiceVisitId = optionalUuid(
    input.handymanServiceVisitId,
    'handymanServiceVisitId',
  );
  const supersedesDemandId = optionalUuid(
    input.supersedesDemandId,
    'supersedesDemandId',
  );
  const idempotencyKey = parseRequiredIdempotencyKey(input.idempotencyKey);
  if (sourceContext === 'FIELD_DISCOVERED' && !handymanServiceVisitId) {
    throw handymanMaterialDemandContextInvalidError(
      'FIELD_DISCOVERED material requires a service visit.',
    );
  }
  if (sourceContext === 'INTERNAL_OPERATION' && handymanServiceVisitId) {
    throw handymanMaterialDemandContextInvalidError(
      'INTERNAL_OPERATION material must not carry a field visit provenance.',
    );
  }
  const idempotencyFingerprint = fingerprint('CREATE_NON_CHARGEABLE_DEMAND', {
    handymanJobId,
    supplySource,
    inventoryItemId,
    uomId,
    description,
    quantity,
    sourceContext,
    handymanServiceVisitId,
    supersedesDemandId,
  });

  const preview = await loadMaterialJobContext(
    handymanJobId,
    getPool(),
  );
  if (sourceContext === 'FIELD_DISCOVERED') {
    await assertFieldDiscoveryLead(
      preview,
      handymanServiceVisitId as string,
      actorUserId,
    );
  } else {
    await assertStaffBuildingAccess(preview, actorUserId);
  }
  const replay = await handymanMaterialDemandRepository.findDemandByIdempotencyKey(
    preview.job.clientId,
    idempotencyKey,
  );
  if (replay) {
    assertFingerprint(
      replay.idempotencyFingerprint,
      idempotencyFingerprint,
      handymanMaterialDemandIdempotencyConflictError,
    );
    return { demand: toPublicHandymanMaterialDemand(replay), replayed: true };
  }

  return withTransaction(async (tx) => {
    const context = await loadMaterialJobContext(handymanJobId, tx, {
      forUpdate: true,
    });
    if (sourceContext === 'FIELD_DISCOVERED') {
      await assertFieldDiscoveryLead(
        context,
        handymanServiceVisitId as string,
        actorUserId,
        tx,
      );
    } else {
      await assertStaffBuildingAccess(context, actorUserId);
    }
    await lockIdempotencyKey(
      tx,
      'handyman_material_demands',
      context.job.clientId,
      idempotencyKey,
    );
    const existing = await handymanMaterialDemandRepository.findDemandByIdempotencyKey(
      context.job.clientId,
      idempotencyKey,
      tx,
    );
    if (existing) {
      assertFingerprint(
        existing.idempotencyFingerprint,
        idempotencyFingerprint,
        handymanMaterialDemandIdempotencyConflictError,
      );
      return { demand: toPublicHandymanMaterialDemand(existing), replayed: true };
    }

    const subject = await validateMaterialSubject(
      { supplySource, inventoryItemId, uomId, description },
      context.job.clientId,
      tx,
    );

    if (supersedesDemandId) {
      const predecessor = await handymanMaterialDemandRepository.lockDemandById(
        supersedesDemandId,
        tx,
      );
      if (
        !predecessor ||
        predecessor.clientId !== context.job.clientId ||
        predecessor.handymanJobId !== context.job.id ||
        predecessor.status !== 'ACTIVE' ||
        predecessor.commercialBasis !== 'NON_CHARGEABLE_OPERATIONAL'
      ) {
        throw handymanMaterialDemandStateInvalidError(
          'Only an active non-chargeable demand of this job may be superseded.',
        );
      }
      // An ACTIVE inventory allocation belongs to the predecessor demand and
      // must be explicitly released/cancelled through inventory first. Never
      // silently strand or release physical stock while changing scope.
      const activeReservations =
        await inventoryMaterialReservationRepository.countActiveByHandymanMaterialDemand(
          tx,
          predecessor.id,
        );
      if (activeReservations > 0) {
        throw handymanMaterialDemandStateInvalidError(
          'A material demand with active inventory reservations cannot be superseded.',
        );
      }
      const superseded = await handymanMaterialDemandRepository.supersedeActiveDemand(
        predecessor.id,
        actorUserId,
        tx,
      );
      if (!superseded) throw handymanMaterialDemandStateInvalidError();
      await recordMaterialEvent(
        context,
        {
          eventType: 'HANDYMAN_MATERIAL_DEMAND_SUPERSEDED',
          entityType: 'HANDYMAN_MATERIAL_DEMAND',
          entityId: superseded.id,
          actorUserId,
          summary: 'Handyman material demand superseded.',
          metadata: {
            demandId: superseded.id,
            status: superseded.status,
          },
        },
        tx,
      );
    }

    const created = await handymanMaterialDemandRepository.createDemand(
      {
        clientId: context.job.clientId,
        handymanJobId: context.job.id,
        handymanRequestId: context.request.id,
        buildingId: context.request.buildingId,
        supplySource,
        commercialBasis: 'NON_CHARGEABLE_OPERATIONAL',
        sourceContext,
        inventoryItemId: subject.inventoryItemId,
        uomId: subject.uomId,
        description: subject.description,
        quantity,
        handymanServiceVisitId,
        quotationRevisionId: null,
        handymanQuotationLineId: null,
        commercialAddendumId: null,
        handymanMaterialApprovalId: null,
        supersedesDemandId,
        idempotencyKey,
        idempotencyFingerprint,
        createdByUserId: actorUserId,
      },
      tx,
    );
    if (!created) {
      const winner = await handymanMaterialDemandRepository.findDemandByIdempotencyKey(
        context.job.clientId,
        idempotencyKey,
        tx,
      );
      if (!winner) throw new Error('Material demand idempotency winner could not be loaded.');
      assertFingerprint(
        winner.idempotencyFingerprint,
        idempotencyFingerprint,
        handymanMaterialDemandIdempotencyConflictError,
      );
      return { demand: toPublicHandymanMaterialDemand(winner), replayed: true };
    }
    await recordMaterialEvent(
      context,
      {
        eventType: 'HANDYMAN_MATERIAL_DEMAND_CREATED',
        entityType: 'HANDYMAN_MATERIAL_DEMAND',
        entityId: created.id,
        actorUserId,
        summary: 'Handyman material demand created.',
        metadata: {
          demandId: created.id,
          commercialBasis: created.commercialBasis,
          sourceContext: created.sourceContext,
          supplySource: created.supplySource,
          status: created.status,
          supersedesDemandId: created.supersedesDemandId,
        },
      },
      tx,
    );
    return { demand: toPublicHandymanMaterialDemand(created), replayed: false };
  });
}

/** Explicit customer-supplied convenience lane; it does not create an item/UOM. */
export async function createCustomerSuppliedMaterialDemand(
  input: CreateCustomerSuppliedMaterialDemandInput,
  actorUserId: string,
): Promise<HandymanMaterialDemandCreationResult> {
  return createNonChargeableMaterialDemand(
    { ...input, supplySource: 'CUSTOMER_SUPPLIED' },
    actorUserId,
  );
}

/**
 * Creates a narrow immutable supplemental addendum and its one dedicated
 * PENDING approval fact. Only a matched existing price-catalog authority can
 * supply Provider-stock price facts; callers cannot author price/currency.
 */
export async function createHandymanMaterialCommercialAddendum(
  input: CreateHandymanMaterialCommercialAddendumInput,
  actorUserId: string,
): Promise<HandymanMaterialAddendumCreationResult> {
  const handymanJobId =
    typeof input.handymanJobId === 'string' && isValidUuid(input.handymanJobId)
      ? input.handymanJobId
      : (() => {
          throw handymanJobNotFoundError();
        })();
  const supplySource = parseSupplySource(input.supplySource);
  const inventoryItemId = optionalUuid(input.inventoryItemId, 'inventoryItemId');
  const uomId = requireUuid(input.uomId, 'uomId');
  const description = parseOptionalDescription(input.description);
  const quantity = parsePositiveQuantity(input.quantity);
  const supersedesAddendumId = optionalUuid(
    input.supersedesAddendumId,
    'supersedesAddendumId',
  );
  const idempotencyKey = parseRequiredIdempotencyKey(input.idempotencyKey);
  const idempotencyFingerprint = fingerprint('CREATE_MATERIAL_ADDENDUM', {
    handymanJobId,
    supplySource,
    inventoryItemId,
    uomId,
    description,
    quantity,
    supersedesAddendumId,
  });

  const preview = await loadMaterialJobContext(
    handymanJobId,
    getPool(),
  );
  // Customer price scope is a governed staff command in Run 1. Field leads
  // may record non-chargeable discovered scope, but cannot author or resolve
  // customer-chargeable price scope through this service.
  await assertStaffBuildingAccess(preview, actorUserId);
  const replay = await handymanMaterialDemandRepository.findAddendumByIdempotencyKey(
    preview.job.clientId,
    idempotencyKey,
  );
  if (replay) {
    assertFingerprint(
      replay.idempotencyFingerprint,
      idempotencyFingerprint,
      handymanMaterialAddendumIdempotencyConflictError,
    );
    return addendumCreationResult(replay, true);
  }

  return withTransaction(async (tx) => {
    const context = await loadMaterialJobContext(handymanJobId, tx, {
      forUpdate: true,
    });
    await assertStaffBuildingAccess(context, actorUserId);
    await lockIdempotencyKey(
      tx,
      'handyman_material_addenda',
      context.job.clientId,
      idempotencyKey,
    );
    const existing = await handymanMaterialDemandRepository.findAddendumByIdempotencyKey(
      context.job.clientId,
      idempotencyKey,
      tx,
    );
    if (existing) {
      assertFingerprint(
        existing.idempotencyFingerprint,
        idempotencyFingerprint,
        handymanMaterialAddendumIdempotencyConflictError,
      );
      return addendumCreationResult(existing, true, tx);
    }

    const subject = await validateMaterialSubject(
      { supplySource, inventoryItemId, uomId, description },
      context.job.clientId,
      tx,
    );
    const price =
      supplySource === 'PROVIDER_STOCK'
        ? await resolveProviderStockAddendumPrice(context, subject, actorUserId)
        : null;

    if (supersedesAddendumId) {
      const predecessor = await handymanMaterialDemandRepository.lockAddendumById(
        supersedesAddendumId,
        tx,
      );
      if (!predecessor) throw handymanMaterialAddendumNotFoundError();
      assertAddendumContext(predecessor, context);
      if (predecessor.status !== 'PENDING') {
        throw handymanMaterialAddendumStateInvalidError(
          'Only a pending material addendum may be superseded in Run 1.',
        );
      }
      const predecessorApproval =
        await handymanMaterialDemandRepository.lockApprovalByAddendumId(
          predecessor.id,
          tx,
        );
      if (!predecessorApproval || predecessorApproval.status !== 'PENDING') {
        throw handymanMaterialAddendumStateInvalidError(
          'The superseded addendum must retain its one pending approval fact.',
        );
      }
      const cancelledApproval =
        await handymanMaterialDemandRepository.cancelPendingApproval(
          predecessorApproval.id,
          actorUserId,
          tx,
        );
      if (!cancelledApproval) throw handymanMaterialAddendumStateInvalidError();
      const superseded =
        await handymanMaterialDemandRepository.transitionPendingAddendum(
          predecessor.id,
          'SUPERSEDED',
          actorUserId,
          tx,
        );
      if (!superseded) throw handymanMaterialAddendumStateInvalidError();
      await recordMaterialEvent(
        context,
        {
          eventType: 'HANDYMAN_MATERIAL_APPROVAL_CANCELLED',
          entityType: 'HANDYMAN_MATERIAL_APPROVAL',
          entityId: cancelledApproval.id,
          actorUserId,
          summary: 'Handyman material approval cancelled.',
          metadata: {
            approvalId: cancelledApproval.id,
            status: cancelledApproval.status,
            commercialAddendumId: predecessor.id,
          },
        },
        tx,
      );
      await recordMaterialEvent(
        context,
        {
          eventType: 'HANDYMAN_MATERIAL_ADDENDUM_SUPERSEDED',
          entityType: 'HANDYMAN_MATERIAL_COMMERCIAL_ADDENDUM',
          entityId: superseded.id,
          actorUserId,
          summary: 'Handyman material commercial addendum superseded.',
          metadata: {
            commercialAddendumId: superseded.id,
            status: superseded.status,
          },
        },
        tx,
      );
    }

    const createInput: NewHandymanMaterialCommercialAddendum = {
      clientId: context.job.clientId,
      handymanJobId: context.job.id,
      handymanRequestId: context.request.id,
      buildingId: context.request.buildingId,
      supplySource,
      inventoryItemId: subject.inventoryItemId,
      uomId: subject.uomId,
      description: subject.description,
      quantity,
      currency: price?.currency ?? null,
      unitCommercialAmount: price?.unitCommercialAmount ?? null,
      referencePriceCatalogEntryId: price?.referencePriceCatalogEntryId ?? null,
      referenceScopeTier: price?.referenceScopeTier ?? null,
      referenceAsOf: price?.referenceAsOf ?? null,
      supersedesAddendumId,
      idempotencyKey,
      idempotencyFingerprint,
      createdByUserId: actorUserId,
    };
    const created = await handymanMaterialDemandRepository.createAddendum(
      createInput,
      tx,
    );
    if (!created) {
      const winner = await handymanMaterialDemandRepository.findAddendumByIdempotencyKey(
        context.job.clientId,
        idempotencyKey,
        tx,
      );
      if (!winner) throw new Error('Material addendum idempotency winner could not be loaded.');
      assertFingerprint(
        winner.idempotencyFingerprint,
        idempotencyFingerprint,
        handymanMaterialAddendumIdempotencyConflictError,
      );
      return addendumCreationResult(winner, true, tx);
    }
    const approval = await handymanMaterialDemandRepository.createPendingApproval(
      {
        clientId: context.job.clientId,
        handymanJobId: context.job.id,
        handymanRequestId: context.request.id,
        buildingId: context.request.buildingId,
        commercialAddendumId: created.id,
        createdByUserId: actorUserId,
      },
      tx,
    );
    await recordMaterialEvent(
      context,
      {
        eventType: 'HANDYMAN_MATERIAL_ADDENDUM_CREATED',
        entityType: 'HANDYMAN_MATERIAL_COMMERCIAL_ADDENDUM',
        entityId: created.id,
        actorUserId,
        summary: 'Handyman material commercial addendum created.',
        metadata: {
          commercialAddendumId: created.id,
          approvalId: approval.id,
          commercialBasis: created.commercialBasis,
          supplySource: created.supplySource,
          status: created.status,
          supersedesAddendumId: created.supersedesAddendumId,
        },
      },
      tx,
    );
    await recordMaterialEvent(
      context,
      {
        eventType: 'HANDYMAN_MATERIAL_APPROVAL_PENDING',
        entityType: 'HANDYMAN_MATERIAL_APPROVAL',
        entityId: approval.id,
        actorUserId,
        summary: 'Handyman material approval pending.',
        metadata: {
          approvalId: approval.id,
          commercialAddendumId: created.id,
          status: approval.status,
        },
      },
      tx,
    );
    return {
      addendum: toPublicHandymanMaterialCommercialAddendum(created),
      approval: toPublicHandymanMaterialApproval(approval),
      replayed: false,
    };
  });
}

async function applyMaterialApprovalDecision(
  input: {
    handymanMaterialApprovalId: string;
    decision: HandymanMaterialApprovalDecision;
    method: HandymanMaterialApprovalMethod;
    approvedFor: ApprovedForSnapshot;
    notes: string | null;
    recordedByUserId: string | null;
    idempotencyKey: string;
    idempotencyFingerprint: string;
  },
  actorUserId: string,
  options: {
    directTenantAuthority?: boolean;
    assistedApprovedFor?: RecordHandymanMaterialApprovalAssistedInput['approvedFor'];
  } = {},
): Promise<HandymanMaterialApprovalDecisionResult> {
  const previewApproval = await handymanMaterialDemandRepository.findApprovalById(
    input.handymanMaterialApprovalId,
  );
  if (!previewApproval) throw handymanMaterialApprovalNotFoundError();
  const previewContext = await loadMaterialJobContext(
    previewApproval.handymanJobId,
    getPool(),
  );
  const previewAddendum = await handymanMaterialDemandRepository.findAddendumById(
    previewApproval.commercialAddendumId,
  );
  if (!previewAddendum) throw handymanMaterialAddendumNotFoundError();
  assertAddendumContext(previewAddendum, previewContext);
  assertApprovalContext(previewApproval, previewAddendum, previewContext);
  if (options.directTenantAuthority) {
    await resolveAuthorizedTenantPic(previewContext.request, actorUserId);
  } else {
    await assertStaffBuildingAccess(previewContext, actorUserId);
  }

  const earlyReplay =
    await handymanMaterialDemandRepository.findApprovalByDecisionIdempotencyKey(
      previewContext.job.clientId,
      input.idempotencyKey,
    );
  if (earlyReplay) {
    assertFingerprint(
      earlyReplay.decisionIdempotencyFingerprint,
      input.idempotencyFingerprint,
      handymanMaterialApprovalIdempotencyConflictError,
    );
    return approvalDecisionResult(earlyReplay, true);
  }

  return withTransaction(async (tx) => {
    // Deterministic lock order for all addendum/approval pathways:
    // job -> addendum -> approval -> client-scoped command key.
    const context = await loadMaterialJobContext(previewApproval.handymanJobId, tx, {
      forUpdate: true,
    });
    const addendum = await handymanMaterialDemandRepository.lockAddendumById(
      previewApproval.commercialAddendumId,
      tx,
    );
    if (!addendum) throw handymanMaterialAddendumNotFoundError();
    const approval = await handymanMaterialDemandRepository.lockApprovalById(
      input.handymanMaterialApprovalId,
      tx,
    );
    if (!approval) throw handymanMaterialApprovalNotFoundError();
    assertAddendumContext(addendum, context);
    assertApprovalContext(approval, addendum, context);
    let approvedFor = input.approvedFor;
    if (options.directTenantAuthority) {
      const pic = await resolveAuthorizedTenantPic(context.request, actorUserId);
      approvedFor = {
        approvedForType: 'TENANT_PIC',
        approvedForTenantCompanyId: pic.companyId,
        approvedForTenantPicId: pic.picId,
        approvedForName: pic.picName,
      };
    } else {
      await assertStaffBuildingAccess(context, actorUserId);
      if (options.assistedApprovedFor) {
        // Customer/request/building relationship authority is re-derived after
        // the deterministic locks, so an intervening tenant-context change
        // cannot finalize an assisted decision from stale preview data.
        approvedFor = await resolveAssistedApprovedFor(
          options.assistedApprovedFor,
          context.request,
        );
      }
    }
    await lockIdempotencyKey(
      tx,
      'handyman_material_approval_decisions',
      context.job.clientId,
      input.idempotencyKey,
    );
    const keyed =
      await handymanMaterialDemandRepository.findApprovalByDecisionIdempotencyKey(
        context.job.clientId,
        input.idempotencyKey,
        tx,
      );
    if (keyed) {
      assertFingerprint(
        keyed.decisionIdempotencyFingerprint,
        input.idempotencyFingerprint,
        handymanMaterialApprovalIdempotencyConflictError,
      );
      return approvalDecisionResult(keyed, true, tx);
    }
    if (approval.status !== 'PENDING') throw handymanMaterialApprovalNotPendingError();
    if (addendum.status !== 'PENDING') {
      throw handymanMaterialAddendumStateInvalidError(
        'A material approval can be decided only while its addendum is pending.',
      );
    }

    const nextAddendum =
      await handymanMaterialDemandRepository.transitionPendingAddendum(
        addendum.id,
        input.decision,
        actorUserId,
        tx,
      );
    if (!nextAddendum) {
      throw handymanMaterialAddendumStateInvalidError(
        'A concurrent command already changed the material addendum.',
      );
    }
    const decided = await handymanMaterialDemandRepository.decideApprovalFromPending(
      approval.id,
      {
        status: input.decision,
        method: input.method,
        approvedForType: approvedFor.approvedForType,
        approvedForTenantCompanyId: approvedFor.approvedForTenantCompanyId,
        approvedForTenantPicId: approvedFor.approvedForTenantPicId,
        approvedForName: approvedFor.approvedForName,
        decisionNotes: input.notes,
        recordedByUserId: input.recordedByUserId,
        decisionIdempotencyKey: input.idempotencyKey,
        decisionIdempotencyFingerprint: input.idempotencyFingerprint,
      },
      tx,
    );
    if (!decided) {
      throw handymanMaterialApprovalNotPendingError(
        'A concurrent material approval decision won.',
      );
    }

    let demand: HandymanMaterialDemandRecord | null = null;
    if (input.decision === 'APPROVED') {
      const demandFingerprint = fingerprint('APPROVED_MATERIAL_ADDENDUM_DEMAND', {
        handymanMaterialApprovalId: decided.id,
        commercialAddendumId: nextAddendum.id,
      });
      demand = await handymanMaterialDemandRepository.createDemand(
        {
          clientId: context.job.clientId,
          handymanJobId: context.job.id,
          handymanRequestId: context.request.id,
          buildingId: context.request.buildingId,
          supplySource: nextAddendum.supplySource,
          commercialBasis: 'ADDITIONAL_CUSTOMER_CHARGEABLE',
          sourceContext: 'CUSTOMER_APPROVED_ADDENDUM',
          inventoryItemId: nextAddendum.inventoryItemId,
          uomId: nextAddendum.uomId,
          description: nextAddendum.description,
          quantity: nextAddendum.quantity,
          handymanServiceVisitId: null,
          quotationRevisionId: null,
          handymanQuotationLineId: null,
          commercialAddendumId: nextAddendum.id,
          handymanMaterialApprovalId: decided.id,
          supersedesDemandId: null,
          // The externally callable approval command owns this automatic
          // demand creation, so its key is the durable replay seam.
          idempotencyKey: input.idempotencyKey,
          idempotencyFingerprint: demandFingerprint,
          createdByUserId: actorUserId,
        },
        tx,
      );
      if (!demand) {
        const keyedDemand =
          await handymanMaterialDemandRepository.findDemandByIdempotencyKey(
            context.job.clientId,
            input.idempotencyKey,
            tx,
          );
        if (keyedDemand) {
          assertFingerprint(
            keyedDemand.idempotencyFingerprint,
            demandFingerprint,
            handymanMaterialDemandIdempotencyConflictError,
          );
          demand = keyedDemand;
        } else {
          demand = await handymanMaterialDemandRepository.findDemandByApprovalId(
            decided.id,
            tx,
          );
        }
        if (!demand || demand.handymanMaterialApprovalId !== decided.id) {
          throw new Error('Approved material demand could not be loaded after idempotency convergence.');
        }
      }
      await recordMaterialEvent(
        context,
        {
          eventType: 'HANDYMAN_MATERIAL_DEMAND_CREATED',
          entityType: 'HANDYMAN_MATERIAL_DEMAND',
          entityId: demand.id,
          actorUserId,
          summary: 'Handyman material demand created.',
          metadata: {
            demandId: demand.id,
            commercialBasis: demand.commercialBasis,
            sourceContext: demand.sourceContext,
            status: demand.status,
            commercialAddendumId: nextAddendum.id,
            approvalId: decided.id,
          },
        },
        tx,
      );
    }
    await recordMaterialEvent(
      context,
      {
        eventType:
          input.decision === 'APPROVED'
            ? 'HANDYMAN_MATERIAL_APPROVAL_APPROVED'
            : 'HANDYMAN_MATERIAL_APPROVAL_REJECTED',
        entityType: 'HANDYMAN_MATERIAL_APPROVAL',
        entityId: decided.id,
        actorUserId,
        summary: `Handyman material approval ${input.decision.toLowerCase()}.`,
        metadata: {
          approvalId: decided.id,
          commercialAddendumId: nextAddendum.id,
          decision: input.decision,
          method: input.method,
          approvedForType: decided.approvedForType,
          status: decided.status,
          demandId: demand?.id ?? null,
        },
      },
      tx,
    );
    return {
      approval: toPublicHandymanMaterialApproval(decided),
      addendum: toPublicHandymanMaterialCommercialAddendum(nextAddendum),
      demand: demand ? toPublicHandymanMaterialDemand(demand) : null,
      replayed: false,
    };
  });
}

/** Direct decision: CR03 tenant/customer chain, no caller-approved-for or recorder. */
export async function decideHandymanMaterialApprovalInApp(
  input: DecideHandymanMaterialApprovalInAppInput,
  actorUserId: string,
): Promise<HandymanMaterialApprovalDecisionResult> {
  const handymanMaterialApprovalId =
    typeof input.handymanMaterialApprovalId === 'string' &&
    isValidUuid(input.handymanMaterialApprovalId)
      ? input.handymanMaterialApprovalId
      : (() => {
          throw handymanMaterialApprovalNotFoundError();
        })();
  const decision = parseDecision(input.decision);
  const notes = parseOptionalDecisionNotes(input.notes, { required: false });
  const idempotencyKey = parseRequiredIdempotencyKey(input.idempotencyKey);

  const approval = await handymanMaterialDemandRepository.findApprovalById(
    handymanMaterialApprovalId,
  );
  if (!approval) throw handymanMaterialApprovalNotFoundError();
  const context = await loadMaterialJobContext(
    approval.handymanJobId,
    getPool(),
  );
  const pic = await resolveAuthorizedTenantPic(context.request, actorUserId);
  const approvedFor: ApprovedForSnapshot = {
    approvedForType: 'TENANT_PIC',
    approvedForTenantCompanyId: pic.companyId,
    approvedForTenantPicId: pic.picId,
    approvedForName: pic.picName,
  };
  const idempotencyFingerprint = fingerprint('DECIDE_MATERIAL_APPROVAL_IN_APP', {
    handymanMaterialApprovalId,
    decision,
    notes,
  });
  return applyMaterialApprovalDecision(
    {
      handymanMaterialApprovalId,
      decision,
      method: 'IN_APP',
      approvedFor,
      notes,
      recordedByUserId: null,
      idempotencyKey,
      idempotencyFingerprint,
    },
    actorUserId,
    { directTenantAuthority: true },
  );
}

/** Assisted decision: staff building scope + separately derived approved-for party. */
export async function recordHandymanMaterialApprovalAssistedDecision(
  input: RecordHandymanMaterialApprovalAssistedInput,
  actorUserId: string,
): Promise<HandymanMaterialApprovalDecisionResult> {
  const handymanMaterialApprovalId =
    typeof input.handymanMaterialApprovalId === 'string' &&
    isValidUuid(input.handymanMaterialApprovalId)
      ? input.handymanMaterialApprovalId
      : (() => {
          throw handymanMaterialApprovalNotFoundError();
        })();
  const decision = parseDecision(input.decision);
  const notes = parseOptionalDecisionNotes(input.notes, { required: true });
  const idempotencyKey = parseRequiredIdempotencyKey(input.idempotencyKey);
  const approval = await handymanMaterialDemandRepository.findApprovalById(
    handymanMaterialApprovalId,
  );
  if (!approval) throw handymanMaterialApprovalNotFoundError();
  const context = await loadMaterialJobContext(
    approval.handymanJobId,
    getPool(),
  );
  await assertStaffBuildingAccess(context, actorUserId);
  const approvedFor = await resolveAssistedApprovedFor(input.approvedFor, context.request);
  const idempotencyFingerprint = fingerprint('DECIDE_MATERIAL_APPROVAL_ASSISTED', {
    handymanMaterialApprovalId,
    decision,
    // Fingerprint normalized, server-derived identity facts rather than the
    // caller object's property order or display-name snapshot.
    approvedFor: {
      type: approvedFor.approvedForType,
      tenantCompanyId: approvedFor.approvedForTenantCompanyId,
      tenantPicId: approvedFor.approvedForTenantPicId,
    },
    notes,
  });
  return applyMaterialApprovalDecision(
    {
      handymanMaterialApprovalId,
      decision,
      method: 'ASSISTED',
      approvedFor,
      notes,
      // Explicitly separate from Approved For — the authenticated staff actor
      // records the customer decision but never becomes the customer authority.
      recordedByUserId: actorUserId,
      idempotencyKey,
      idempotencyFingerprint,
    },
    actorUserId,
    { assistedApprovedFor: input.approvedFor },
  );
}

/** Cancels an ACTIVE demand without deleting/repricing/releasing stock. */
export async function cancelHandymanMaterialDemand(
  input: CancelHandymanMaterialDemandInput,
  actorUserId: string,
): Promise<HandymanMaterialDemandCancellationResult> {
  const handymanMaterialDemandId =
    typeof input.handymanMaterialDemandId === 'string' &&
    isValidUuid(input.handymanMaterialDemandId)
      ? input.handymanMaterialDemandId
      : (() => {
          throw handymanMaterialDemandNotFoundError();
        })();
  const reason = parseCancellationReason(input.reason);
  const idempotencyKey = parseRequiredIdempotencyKey(input.idempotencyKey);
  const idempotencyFingerprint = fingerprint('CANCEL_MATERIAL_DEMAND', {
    handymanMaterialDemandId,
    reason,
  });
  const previewDemand = await handymanMaterialDemandRepository.findDemandById(
    handymanMaterialDemandId,
  );
  if (!previewDemand) throw handymanMaterialDemandNotFoundError();
  const previewContext = await loadMaterialJobContext(
    previewDemand.handymanJobId,
    getPool(),
  );
  await assertStaffBuildingAccess(previewContext, actorUserId);
  const earlyReplay =
    await handymanMaterialDemandRepository.findDemandByCancellationIdempotencyKey(
      previewContext.job.clientId,
      idempotencyKey,
    );
  if (earlyReplay) {
    assertFingerprint(
      earlyReplay.cancellationIdempotencyFingerprint,
      idempotencyFingerprint,
      handymanMaterialDemandIdempotencyConflictError,
    );
    return { demand: toPublicHandymanMaterialDemand(earlyReplay), replayed: true };
  }

  return withTransaction(async (tx) => {
    const context = await loadMaterialJobContext(previewDemand.handymanJobId, tx, {
      forUpdate: true,
    });
    const demand = await handymanMaterialDemandRepository.lockDemandById(
      handymanMaterialDemandId,
      tx,
    );
    if (!demand) throw handymanMaterialDemandNotFoundError();
    if (
      demand.clientId !== context.job.clientId ||
      demand.handymanJobId !== context.job.id
    ) {
      throw handymanMaterialDemandContextInvalidError();
    }
    await assertStaffBuildingAccess(context, actorUserId);
    await lockIdempotencyKey(
      tx,
      'handyman_material_demand_cancellations',
      context.job.clientId,
      idempotencyKey,
    );
    const keyed =
      await handymanMaterialDemandRepository.findDemandByCancellationIdempotencyKey(
        context.job.clientId,
        idempotencyKey,
        tx,
      );
    if (keyed) {
      assertFingerprint(
        keyed.cancellationIdempotencyFingerprint,
        idempotencyFingerprint,
        handymanMaterialDemandIdempotencyConflictError,
      );
      return { demand: toPublicHandymanMaterialDemand(keyed), replayed: true };
    }
    if (demand.status !== 'ACTIVE') throw handymanMaterialDemandStateInvalidError();
    // Keep the source row locked while checking allocation. Reservation
    // creation holds this same demand lock, so cancellation cannot race a new
    // ACTIVE inventory allocation or silently release it.
    const activeReservations =
      await inventoryMaterialReservationRepository.countActiveByHandymanMaterialDemand(
        tx,
        demand.id,
      );
    if (activeReservations > 0) {
      throw handymanMaterialDemandStateInvalidError(
        'A material demand with active inventory reservations cannot be cancelled.',
      );
    }
    const cancelled = await handymanMaterialDemandRepository.cancelActiveDemand(
      demand.id,
      {
        actorUserId,
        reason,
        idempotencyKey,
        idempotencyFingerprint,
      },
      tx,
    );
    if (!cancelled) throw handymanMaterialDemandStateInvalidError();
    await recordMaterialEvent(
      context,
      {
        eventType: 'HANDYMAN_MATERIAL_DEMAND_CANCELLED',
        entityType: 'HANDYMAN_MATERIAL_DEMAND',
        entityId: cancelled.id,
        actorUserId,
        summary: 'Handyman material demand cancelled.',
        metadata: {
          demandId: cancelled.id,
          status: cancelled.status,
          cancellationReason: cancelled.cancellationReason,
        },
      },
      tx,
    );
    return { demand: toPublicHandymanMaterialDemand(cancelled), replayed: false };
  });
}

/** Cancels only PENDING addendum scope and its PENDING decision fact. */
export async function cancelHandymanMaterialCommercialAddendum(
  input: CancelHandymanMaterialCommercialAddendumInput,
  actorUserId: string,
): Promise<HandymanMaterialAddendumCancellationResult> {
  const handymanMaterialCommercialAddendumId =
    typeof input.handymanMaterialCommercialAddendumId === 'string' &&
    isValidUuid(input.handymanMaterialCommercialAddendumId)
      ? input.handymanMaterialCommercialAddendumId
      : (() => {
          throw handymanMaterialAddendumNotFoundError();
        })();
  const reason = parseCancellationReason(input.reason);
  const idempotencyKey = parseRequiredIdempotencyKey(input.idempotencyKey);
  const idempotencyFingerprint = fingerprint('CANCEL_MATERIAL_ADDENDUM', {
    handymanMaterialCommercialAddendumId,
    reason,
  });
  const previewAddendum = await handymanMaterialDemandRepository.findAddendumById(
    handymanMaterialCommercialAddendumId,
  );
  if (!previewAddendum) throw handymanMaterialAddendumNotFoundError();
  const previewContext = await loadMaterialJobContext(
    previewAddendum.handymanJobId,
    getPool(),
  );
  assertAddendumContext(previewAddendum, previewContext);
  await assertStaffBuildingAccess(previewContext, actorUserId);
  const earlyReplay =
    await handymanMaterialDemandRepository.findAddendumByCancellationIdempotencyKey(
      previewContext.job.clientId,
      idempotencyKey,
    );
  if (earlyReplay) {
    assertFingerprint(
      earlyReplay.cancellationIdempotencyFingerprint,
      idempotencyFingerprint,
      handymanMaterialAddendumIdempotencyConflictError,
    );
    const approval = await handymanMaterialDemandRepository.findApprovalByAddendumId(
      earlyReplay.id,
    );
    if (!approval) throw handymanMaterialDemandContextInvalidError();
    return {
      addendum: toPublicHandymanMaterialCommercialAddendum(earlyReplay),
      approval: toPublicHandymanMaterialApproval(approval),
      replayed: true,
    };
  }

  return withTransaction(async (tx) => {
    const context = await loadMaterialJobContext(previewAddendum.handymanJobId, tx, {
      forUpdate: true,
    });
    const addendum = await handymanMaterialDemandRepository.lockAddendumById(
      handymanMaterialCommercialAddendumId,
      tx,
    );
    if (!addendum) throw handymanMaterialAddendumNotFoundError();
    const approval = await handymanMaterialDemandRepository.lockApprovalByAddendumId(
      addendum.id,
      tx,
    );
    if (!approval) throw handymanMaterialDemandContextInvalidError();
    assertAddendumContext(addendum, context);
    assertApprovalContext(approval, addendum, context);
    await assertStaffBuildingAccess(context, actorUserId);
    await lockIdempotencyKey(
      tx,
      'handyman_material_addendum_cancellations',
      context.job.clientId,
      idempotencyKey,
    );
    const keyed =
      await handymanMaterialDemandRepository.findAddendumByCancellationIdempotencyKey(
        context.job.clientId,
        idempotencyKey,
        tx,
      );
    if (keyed) {
      assertFingerprint(
        keyed.cancellationIdempotencyFingerprint,
        idempotencyFingerprint,
        handymanMaterialAddendumIdempotencyConflictError,
      );
      const keyedApproval = await handymanMaterialDemandRepository.findApprovalByAddendumId(
        keyed.id,
        tx,
      );
      if (!keyedApproval) throw handymanMaterialDemandContextInvalidError();
      return {
        addendum: toPublicHandymanMaterialCommercialAddendum(keyed),
        approval: toPublicHandymanMaterialApproval(keyedApproval),
        replayed: true,
      };
    }
    if (addendum.status !== 'PENDING' || approval.status !== 'PENDING') {
      throw handymanMaterialAddendumStateInvalidError(
        'Only a pending material addendum and pending approval may be cancelled.',
      );
    }
    const cancelledApproval =
      await handymanMaterialDemandRepository.cancelPendingApproval(
        approval.id,
        actorUserId,
        tx,
      );
    if (!cancelledApproval) throw handymanMaterialAddendumStateInvalidError();
    const cancelled = await handymanMaterialDemandRepository.cancelPendingAddendum(
      addendum.id,
      {
        actorUserId,
        reason,
        idempotencyKey,
        idempotencyFingerprint,
      },
      tx,
    );
    if (!cancelled) throw handymanMaterialAddendumStateInvalidError();
    await recordMaterialEvent(
      context,
      {
        eventType: 'HANDYMAN_MATERIAL_APPROVAL_CANCELLED',
        entityType: 'HANDYMAN_MATERIAL_APPROVAL',
        entityId: cancelledApproval.id,
        actorUserId,
        summary: 'Handyman material approval cancelled.',
        metadata: {
          approvalId: cancelledApproval.id,
          commercialAddendumId: cancelled.id,
          status: cancelledApproval.status,
        },
      },
      tx,
    );
    await recordMaterialEvent(
      context,
      {
        eventType: 'HANDYMAN_MATERIAL_ADDENDUM_CANCELLED',
        entityType: 'HANDYMAN_MATERIAL_COMMERCIAL_ADDENDUM',
        entityId: cancelled.id,
        actorUserId,
        summary: 'Handyman material commercial addendum cancelled.',
        metadata: {
          commercialAddendumId: cancelled.id,
          status: cancelled.status,
          cancellationReason: cancelled.cancellationReason,
        },
      },
      tx,
    );
    return {
      addendum: toPublicHandymanMaterialCommercialAddendum(cancelled),
      approval: toPublicHandymanMaterialApproval(cancelledApproval),
      replayed: false,
    };
  });
}

async function assertMaterialReadAccess(
  context: MaterialJobContext,
  actorUserId: string,
  options: { allowFieldLead?: boolean } = {},
): Promise<void> {
  if (
    await contextAccessService.canAccessBuilding(
      actorUserId,
      context.request.buildingId,
    )
  ) {
    return;
  }
  // A direct customer can read only through the same tenant/request relation
  // used for direct decisions — no client/request/customer id is trusted.
  try {
    await resolveAuthorizedTenantPic(context.request, actorUserId);
    return;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
  }
  // Current governed Lead Worker gets only demand-level operational reads;
  // commercial addendum amounts and approval facts remain staff/customer-only.
  if (options.allowFieldLead === false) throw buildingAccessDeniedError();
  // No crew identity from a caller is accepted and no lifecycle authority is
  // granted by this narrow operational read allowance.
  const bindingIds = await resolveFieldActorActiveBindingIds(actorUserId);
  if (bindingIds.length > 0) {
    const composition = await handymanJobRepository.findActiveByJobId(
      context.job.id,
    );
    if (composition) {
      const lead = await handymanWorkCrewRepository.findActiveLead(
        composition.handymanWorkCrewId,
      );
      if (lead && bindingIds.includes(lead.vendorWorkforceBindingId)) return;
    }
  }
  throw buildingAccessDeniedError();
}

/** Privacy-safe service read of a single demand. */
export async function getHandymanMaterialDemand(
  handymanMaterialDemandId: string,
  actorUserId: string,
): Promise<PublicHandymanMaterialDemand> {
  if (!isValidUuid(handymanMaterialDemandId)) throw handymanMaterialDemandNotFoundError();
  const demand = await handymanMaterialDemandRepository.findDemandById(
    handymanMaterialDemandId,
  );
  if (!demand) throw handymanMaterialDemandNotFoundError();
  const context = await loadMaterialJobContext(
    demand.handymanJobId,
    getPool(),
  );
  if (demand.clientId !== context.job.clientId || demand.handymanJobId !== context.job.id) {
    throw handymanMaterialDemandContextInvalidError();
  }
  await assertMaterialReadAccess(context, actorUserId);
  return toPublicHandymanMaterialDemand(demand);
}

/** Privacy-safe job-scoped demand history read. */
export async function listHandymanMaterialDemands(
  handymanJobId: string,
  actorUserId: string,
): Promise<PublicHandymanMaterialDemand[]> {
  const context = await loadMaterialJobContext(
    handymanJobId,
    getPool(),
  );
  await assertMaterialReadAccess(context, actorUserId);
  const records = await handymanMaterialDemandRepository.listDemandsByJob(
    context.job.id,
  );
  return records.map(toPublicHandymanMaterialDemand);
}

/** Privacy-safe immutable addendum read. */
export async function getHandymanMaterialCommercialAddendum(
  handymanMaterialCommercialAddendumId: string,
  actorUserId: string,
): Promise<PublicHandymanMaterialCommercialAddendum> {
  if (!isValidUuid(handymanMaterialCommercialAddendumId)) {
    throw handymanMaterialAddendumNotFoundError();
  }
  const addendum = await handymanMaterialDemandRepository.findAddendumById(
    handymanMaterialCommercialAddendumId,
  );
  if (!addendum) throw handymanMaterialAddendumNotFoundError();
  const context = await loadMaterialJobContext(
    addendum.handymanJobId,
    getPool(),
  );
  assertAddendumContext(addendum, context);
  await assertMaterialReadAccess(context, actorUserId, { allowFieldLead: false });
  return toPublicHandymanMaterialCommercialAddendum(addendum);
}

/** Privacy-safe job-scoped addendum history read. */
export async function listHandymanMaterialCommercialAddenda(
  handymanJobId: string,
  actorUserId: string,
): Promise<PublicHandymanMaterialCommercialAddendum[]> {
  const context = await loadMaterialJobContext(
    handymanJobId,
    getPool(),
  );
  await assertMaterialReadAccess(context, actorUserId, { allowFieldLead: false });
  const records = await handymanMaterialDemandRepository.listAddendaByJob(
    context.job.id,
  );
  return records.map(toPublicHandymanMaterialCommercialAddendum);
}

/** Privacy-safe approval read; approved-for name and raw notes remain private. */
export async function getHandymanMaterialApproval(
  handymanMaterialApprovalId: string,
  actorUserId: string,
): Promise<PublicHandymanMaterialApproval> {
  if (!isValidUuid(handymanMaterialApprovalId)) {
    throw handymanMaterialApprovalNotFoundError();
  }
  const approval = await handymanMaterialDemandRepository.findApprovalById(
    handymanMaterialApprovalId,
  );
  if (!approval) throw handymanMaterialApprovalNotFoundError();
  const context = await loadMaterialJobContext(
    approval.handymanJobId,
    getPool(),
  );
  const addendum = await handymanMaterialDemandRepository.findAddendumById(
    approval.commercialAddendumId,
  );
  if (!addendum) throw handymanMaterialAddendumNotFoundError();
  assertAddendumContext(addendum, context);
  assertApprovalContext(approval, addendum, context);
  await assertMaterialReadAccess(context, actorUserId, { allowFieldLead: false });
  return toPublicHandymanMaterialApproval(approval);
}
