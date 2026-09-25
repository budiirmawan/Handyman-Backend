/**
 * CR-BE-SAAS-01 PART 06 — SaaS Invoice service (SaaS Control Plane).
 *
 * Frozen §14: the canonical SaaS subscription billing document
 * (Gatepro → SaaS Customer). Product-agnostic: the commercial chain is
 * always Customer → Subscription → bound Product/Package → bound
 * (historical) Pricebook Version/Item — no product-specific branching,
 * so any future Gatepro product profile bills through the same engine.
 *
 * Commands (frozen §22):
 *   - POST /platform/invoices (Idem., op key `saas.invoice.issue`):
 *     DRAFT, or draft+issue in one command;
 *   - POST /platform/invoices/:id/issue (Idem. + ver): DRAFT → ISSUED
 *     (number already final from creation; due_at = issued_at + the
 *     billing account's payment terms); audit SAAS_INVOICE_ISSUED;
 *   - POST /platform/invoices/:id/void (ver, reason mandatory):
 *     DRAFT/ISSUED → VOID (terminal); audit SAAS_INVOICE_VOIDED.
 *
 * Commercial source (frozen §10.4 + PART 06 scope): line amounts come
 * ONLY from the bound pricebook version's item — the caller can never
 * supply a unit price, base price, discount, currency, or total.
 * PART 06 generates only the line types backed by implemented authority
 * (BASE_SUBSCRIPTION; ADDITIONAL_BUILDING from the customer's ACTIVE
 * building count). ADD_ON (no add-on authority yet), USAGE (PART 09),
 * DISCOUNT/ADJUSTMENT/TAX (no authorized rule in PART 06) are frozen
 * vocabulary only — tax_amount is stored as 0 (no tax engine is built or
 * claimed).
 *
 * Historical integrity (frozen §14.3): amounts are snapshotted at
 * creation from the BOUND version — later publishing/supersession
 * (version B) or product/package renames never rewrite the invoice.
 * Invoices are immutable once ISSUED (corrections = new ADJUSTMENT-line
 * invoice or VOID); no mutation path exists for issued financial
 * meaning.
 *
 * PART 07 boundary: `paid_at` stays NULL; PARTIALLY_PAID/PAID/OVERDUE
 * transitions are NOT implemented (owned by PART 07 / PART 08).
 */
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import {
  platformProductRepository,
} from '../platform-products';
import {
  platformPricebookRepository,
} from '../platform-pricebooks';
import {
  platformSubscriptionRepository,
} from '../platform-subscriptions/platform-subscription.repository';
import { saasSubscriptionNotFoundError } from '../platform-subscriptions/platform-subscription.errors';
import {
  computeRequestFingerprint,
  executeIdempotent,
} from '../request-idempotency';
import { recordOperationalEvent } from '../operational-events';
import { AppError, ERROR_CODES } from '../../shared/errors';
import {
  saasBillingAccountNotFoundError,
  saasInvoiceNotFoundError,
  saasInvoicePeriodConflictError,
  saasInvoiceStatusNotAllowedError,
  saasInvoiceVersionConflictError,
} from './platform-billing.errors';
import { saasBillingAccountRepository } from './platform-billing-account.repository';
import { saasInvoiceRepository } from './platform-invoice.repository';
import type {
  CreateSaasInvoiceInput,
  IssueSaasInvoiceInput,
  ListSaasInvoiceFilters,
  PublicSaasInvoice,
  PublicSaasInvoiceDetail,
  PublicSaasInvoiceLine,
  SaasInvoiceLineRecord,
  SaasInvoiceRecord,
  VoidSaasInvoiceInput,
} from './platform-billing.types';

/** Frozen §17.2 operation key (covers issue AND the draft+issue create). */
export const SAAS_INVOICE_ISSUE_OPERATION_KEY = 'saas.invoice.issue';

/** Frozen §18.2 event names (PART 06 subset). */
export const SAAS_INVOICE_ISSUED_EVENT = 'SAAS_INVOICE_ISSUED';
export const SAAS_INVOICE_VOIDED_EVENT = 'SAAS_INVOICE_VOIDED';

function toIso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

export function toPublicSaasInvoiceLine(
  line: SaasInvoiceLineRecord,
): PublicSaasInvoiceLine {
  return {
    id: line.id,
    lineType: line.lineType,
    description: line.description,
    quantity: line.quantity,
    unitAmount: line.unitAmount,
    amount: line.amount,
    currencyCode: line.currencyCode,
    referenceType: line.referenceType,
    referenceId: line.referenceId,
  };
}

export function toPublicSaasInvoice(record: SaasInvoiceRecord): PublicSaasInvoice {
  return {
    id: record.id,
    number: record.number,
    billingAccountId: record.billingAccountId,
    customerId: record.customerId,
    subscriptionId: record.subscriptionId,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    currencyCode: record.currencyCode,
    baseAmount: record.baseAmount,
    taxAmount: record.taxAmount,
    totalAmount: record.totalAmount,
    status: record.status,
    issuedAt: toIso(record.issuedAt),
    dueAt: toIso(record.dueAt),
    // PART 07 sets paidAt; PART 06 never fabricates payment state.
    paidAt: toIso(record.paidAt),
    voidedAt: toIso(record.voidedAt),
    voidReason: record.voidReason,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Structural (non-metered) building count for the customer:
 * Building → Property → Client (the existing structural chain; no
 * client_id on buildings by design).
 */
async function countActiveBuildings(
  customerId: string,
  q: PoolClient,
): Promise<number> {
  const result = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM buildings b
       JOIN properties p ON p.id = b.property_id
      WHERE p.client_id = $1
        AND b.status = 'ACTIVE'`,
    [customerId],
  );
  return result.rows[0]?.n ?? 0;
}

/**
 * Resolves the authoritative commercial snapshot for a subscription:
 * the BOUND (historical) pricebook version's item — never the latest
 * version (frozen §10.4). Product-agnostic.
 */
async function resolveCommercialSnapshot(
  record: {
    productId: string | null;
    packageId: string | null;
    pricebookVersionId: string | null;
    billingCycle: string | null;
  },
  q: PoolClient,
) {
  if (
    !record.productId ||
    !record.packageId ||
    !record.pricebookVersionId ||
    !record.billingCycle
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'subscriptionId',
        message: 'the subscription has no complete commercial binding.',
      },
    ]);
  }
  const product = await platformProductRepository.findProductById(
    record.productId,
    q,
  );
  const packageRow = await platformProductRepository.findPackageById(
    record.packageId,
    q,
  );
  const version = await platformPricebookRepository.findVersionById(
    record.pricebookVersionId,
    q,
  );
  if (!product || !packageRow || !version) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'subscriptionId',
        message: 'the subscription commercial reference is incomplete.',
      },
    ]);
  }
  const pricebook = await platformPricebookRepository.findPricebookById(
    version.pricebookId,
    q,
  );
  const items = await platformPricebookRepository.findItemsByVersionId(
    record.pricebookVersionId,
    q,
  );
  const item = items.find(
    (candidate) =>
      candidate.productId === record.productId &&
      candidate.packageId === record.packageId &&
      candidate.billingCycle === record.billingCycle,
  );
  if (!item) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'subscriptionId',
        message: `no price item for the bound ${record.billingCycle} commercial reference.`,
      },
    ]);
  }
  return { product, packageRow, version, pricebook, item };
}

async function auditInvoiceEvent(
  params: {
    clientId: string;
    eventType: string;
    entityId: string;
    actorUserId: string;
    authority: string;
    summary: string;
    metadata: Record<string, unknown>;
  },
  q: PoolClient,
): Promise<void> {
  await recordOperationalEvent(
    {
      clientId: params.clientId,
      eventType: params.eventType,
      entityType: 'SAAS_INVOICE',
      entityId: params.entityId,
      actorUserId: params.actorUserId,
      summary: params.summary,
      metadata: { authority: params.authority, ...params.metadata },
    },
    q,
  );
}

/**
 * Shared DRAFT construction (used by the create command): resolves the
 * commercial snapshot, the billing account, the period, guards
 * duplicate periods, and writes the DRAFT invoice + line snapshots.
 * Runs inside the caller's (idempotent) transaction.
 */
async function buildDraftInvoice(
  input: CreateSaasInvoiceInput,
  now: Date,
  q: PoolClient,
): Promise<{ invoice: SaasInvoiceRecord; lineCount: number; willIssue: boolean }> {
  const subscription = await platformSubscriptionRepository.findById(
    input.subscriptionId,
    q,
  );
  if (!subscription) {
    throw saasSubscriptionNotFoundError(input.subscriptionId);
  }

  const account = await saasBillingAccountRepository.findActiveByCustomerId(
    subscription.clientId,
    q,
  );
  if (!account) {
    throw saasBillingAccountNotFoundError(subscription.clientId);
  }

  // Currency consistency (frozen): the invoice currency is the
  // SUBSCRIPTION's commercial currency and must match the billing
  // account. Never caller-supplied.
  if (!subscription.currencyCode) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'subscriptionId',
        message: 'the subscription has no commercial currency.',
      },
    ]);
  }
  if (subscription.currencyCode !== account.currencyCode) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'subscriptionId',
        message: `subscription currency ${subscription.currencyCode} does not match the billing account currency ${account.currencyCode}.`,
      },
    ]);
  }

  // Billing period: explicit, or the subscription's current period.
  let periodStart: Date;
  let periodEnd: Date;
  if (input.periodStart || input.periodEnd) {
    periodStart = input.periodStart ? new Date(input.periodStart) : now;
    periodEnd = input.periodEnd ? new Date(input.periodEnd) : now;
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
      throw AppError.validation('Request validation failed.', [
        { field: 'periodStart', message: 'periodStart must be an ISO-8601 timestamp.' },
      ]);
    }
  } else if (subscription.currentPeriodStart && subscription.currentPeriodEnd) {
    periodStart = subscription.currentPeriodStart;
    periodEnd = subscription.currentPeriodEnd;
  } else {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'periodStart',
        message: 'periodStart and periodEnd are required when the subscription has no current period.',
      },
    ]);
  }
  if (periodEnd.getTime() <= periodStart.getTime()) {
    throw AppError.validation('Request validation failed.', [
      { field: 'periodEnd', message: 'periodEnd must be after periodStart.' },
    ]);
  }

  // Canonical duplicate-period guard: one non-VOID invoice per
  // subscription per identical period.
  const existing = await saasInvoiceRepository.findNonVoidBySubscriptionAndPeriod(
    subscription.id,
    periodStart,
    periodEnd,
    q,
  );
  if (existing) {
    throw saasInvoicePeriodConflictError(
      subscription.id,
      periodStart.toISOString(),
      periodEnd.toISOString(),
    );
  }

  // Authoritative commercial snapshot (bound version — never latest).
  const snapshot = await resolveCommercialSnapshot(subscription, q);
  const currencyCode = subscription.currencyCode;

  // Deterministic integer-cent arithmetic (no floating point).
  const cents = (value: number): number => Math.round(value * 100);
  const baseLines: Array<{
    lineType: 'BASE_SUBSCRIPTION' | 'ADDITIONAL_BUILDING';
    description: string;
    quantity: number;
    unitCents: number;
    referenceType: 'SUBSCRIPTION';
    referenceId: string;
  }> = [];
  baseLines.push({
    lineType: 'BASE_SUBSCRIPTION',
    description: `${snapshot.product.code} / ${snapshot.packageRow.code} — ${subscription.billingCycle} subscription (pricebook ${snapshot.pricebook?.code ?? 'n/a'} v${snapshot.version.versionNumber})`,
    quantity: 1,
    unitCents: cents(snapshot.item.basePrice),
    referenceType: 'SUBSCRIPTION',
    referenceId: subscription.id,
  });

  if (
    snapshot.item.additionalBuildingPrice > 0 &&
    snapshot.item.includedBuildingCount !== null &&
    snapshot.item.includedBuildingCount !== undefined
  ) {
    const buildingCount = await countActiveBuildings(subscription.clientId, q);
    const extra = Math.max(
      0,
      buildingCount - snapshot.item.includedBuildingCount,
    );
    if (extra > 0) {
      baseLines.push({
        lineType: 'ADDITIONAL_BUILDING',
        description: `Additional buildings beyond included count (${buildingCount} active, ${snapshot.item.includedBuildingCount} included)`,
        quantity: extra,
        unitCents: cents(snapshot.item.additionalBuildingPrice),
        referenceType: 'SUBSCRIPTION',
        referenceId: subscription.id,
      });
    }
  }

  // PART 06 generates no DISCOUNT/TAX lines (no authorized rule); the
  // tax_amount snapshot is 0 — no tax engine is built or claimed.
  const baseCents = baseLines.reduce(
    (sum, line) => sum + line.quantity * line.unitCents,
    0,
  );
  const taxCents = 0;
  const totalCents = baseCents + taxCents;

  const number = await saasInvoiceRepository.nextInvoiceNumber(now, q);
  const invoice = await saasInvoiceRepository.create(
    {
      number,
      billingAccountId: account.id,
      customerId: subscription.clientId,
      subscriptionId: subscription.id,
      periodStart,
      periodEnd,
      currencyCode,
      baseAmount: baseCents / 100,
      taxAmount: taxCents / 100,
      totalAmount: totalCents / 100,
    },
    q,
  );
  const lines = await saasInvoiceRepository.createLines(
    baseLines.map((line) => ({
      invoiceId: invoice.id,
      lineType: line.lineType,
      description: line.description,
      quantity: line.quantity,
      unitAmount: line.unitCents / 100,
      amount: (line.quantity * line.unitCents) / 100,
      currencyCode,
      referenceType: line.referenceType,
      referenceId: line.referenceId,
    })),
    q,
  );

  return { invoice, lineCount: lines.length, willIssue: input.issue === true };
}

/** Issues a DRAFT invoice in the caller's transaction (frozen §14.4). */
async function issueDraftInvoice(
  params: {
    invoiceId: string;
    expectedVersion: number;
    actorUserId: string;
    authority: string;
    now: Date;
  },
  q: PoolClient,
): Promise<SaasInvoiceRecord> {
  const { invoiceId, expectedVersion, actorUserId, authority, now } = params;

  const locked = await saasInvoiceRepository.lockById(invoiceId, q);
  if (!locked) throw saasInvoiceNotFoundError(invoiceId);
  if (locked.status !== 'DRAFT') {
    throw saasInvoiceStatusNotAllowedError(
      invoiceId,
      locked.status,
      'issue',
      ['DRAFT'],
    );
  }

  const account = await saasBillingAccountRepository.findById(
    locked.billingAccountId,
    q,
  );
  const paymentTerms = account?.paymentTerms ?? 30;

  const issued = await saasInvoiceRepository.issueWithVersion(
    invoiceId,
    expectedVersion,
    paymentTerms,
    now,
    q,
  );
  if (!issued) {
    const current = await saasInvoiceRepository.findById(invoiceId, q);
    if (!current) throw saasInvoiceNotFoundError(invoiceId);
    if (current.status !== 'DRAFT') {
      throw saasInvoiceStatusNotAllowedError(
        invoiceId,
        current.status,
        'issue',
        ['DRAFT'],
      );
    }
    throw saasInvoiceVersionConflictError(
      invoiceId,
      current.version,
      expectedVersion,
    );
  }

  // Frozen §14.3: line amounts must sum to the invoice total (checked at
  // issue). Lines are written atomically with the invoice, so a mismatch
  // is a data-integrity failure — block issuance.
  const lines = await saasInvoiceRepository.findByInvoiceId(invoiceId, q);
  const lineTotalCents = lines.reduce(
    (sum, line) => sum + Math.round(line.amount * 100),
    0,
  );
  if (lineTotalCents !== Math.round(issued.totalAmount * 100)) {
    throw new AppError({
      code: ERROR_CODES.SAAS_INVOICE_STATUS_NOT_ALLOWED,
      message:
        'Invoice line totals do not match the invoice total; issuance blocked.',
      statusCode: 409,
      resource: { type: 'SAAS_INVOICE', id: invoiceId },
    });
  }

  await auditInvoiceEvent(
    {
      clientId: issued.customerId,
      eventType: SAAS_INVOICE_ISSUED_EVENT,
      entityId: issued.id,
      actorUserId,
      authority,
      summary: `SaaS invoice issued: ${issued.number} (${issued.totalAmount} ${issued.currencyCode})`,
      metadata: {
        before: { status: 'DRAFT' },
        after: {
          status: 'ISSUED',
          issuedAt: issued.issuedAt?.toISOString(),
          dueAt: issued.dueAt?.toISOString(),
        },
        number: issued.number,
        subscriptionId: issued.subscriptionId,
        billingAccountId: issued.billingAccountId,
        currencyCode: issued.currencyCode,
        totalAmount: issued.totalAmount,
        lineCount: lines.length,
      },
    },
    q,
  );

  return issued;
}

/**
 * POST /platform/invoices — create a DRAFT (or draft+issue).
 * Idempotency-Key required (frozen §22); op key `saas.invoice.issue`.
 */
export async function createSaasInvoice(
  actorUserId: string,
  authority: string,
  input: CreateSaasInvoiceInput,
  idempotencyKey: string,
): Promise<{ data: PublicSaasInvoice; replayed: boolean }> {
  const requestFingerprint = computeRequestFingerprint({
    id: input.subscriptionId,
    body: input,
  });

  const result = await executeIdempotent({
    actorUserId,
    operationKey: SAAS_INVOICE_ISSUE_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) => {
      const now = new Date();
      const { invoice, willIssue } = await buildDraftInvoice(input, now, client);

      let finalInvoice = invoice;
      if (willIssue) {
        // The fresh draft is version 1, DRAFT, held in this transaction.
        finalInvoice = await issueDraftInvoice(
          { invoiceId: invoice.id, expectedVersion: 1, actorUserId, authority, now },
          client,
        );
      }

      return {
        responseStatus: 201,
        responseBody: toPublicSaasInvoice(finalInvoice),
      };
    },
  });

  return { data: result.responseBody as PublicSaasInvoice, replayed: result.replayed };
}

/** GET /platform/invoices/:id — with lines (frozen §22). */
export async function getSaasInvoiceDetail(
  invoiceId: string,
): Promise<PublicSaasInvoiceDetail> {
  const record = await saasInvoiceRepository.findById(invoiceId);
  if (!record) throw saasInvoiceNotFoundError(invoiceId);
  const lines = await saasInvoiceRepository.findByInvoiceId(invoiceId);
  return {
    ...toPublicSaasInvoice(record),
    lines: lines.map(toPublicSaasInvoiceLine),
  };
}

/** GET /platform/invoices — filters: customerId, status, periodStart/End. */
export async function listSaasInvoices(params: {
  filters: ListSaasInvoiceFilters;
  withTotal: boolean;
  page?: number;
  pageSize?: number;
}): Promise<{ records: PublicSaasInvoice[]; total: number | null }> {
  const limit = params.pageSize;
  const offset =
    params.page !== undefined && params.pageSize !== undefined
      ? (params.page - 1) * params.pageSize
      : undefined;
  const { records, total } = await saasInvoiceRepository.list(
    {
      customerId: params.filters.customerId,
      status: params.filters.status,
      periodStart: params.filters.periodStart
        ? new Date(params.filters.periodStart)
        : undefined,
      periodEnd: params.filters.periodEnd
        ? new Date(params.filters.periodEnd)
        : undefined,
    },
    { withTotal: params.withTotal, limit, offset },
  );
  return { records: records.map(toPublicSaasInvoice), total };
}

/**
 * POST /platform/invoices/:id/issue — DRAFT → ISSUED (frozen §14.4).
 * Idempotency-Key + expectedVersion (frozen §22); audit
 * SAAS_INVOICE_ISSUED.
 */
export async function issueSaasInvoice(
  actorUserId: string,
  authority: string,
  invoiceId: string,
  input: IssueSaasInvoiceInput,
  idempotencyKey: string,
): Promise<{ data: PublicSaasInvoice; replayed: boolean }> {
  const requestFingerprint = computeRequestFingerprint({
    id: invoiceId,
    body: input,
  });

  const result = await executeIdempotent({
    actorUserId,
    operationKey: SAAS_INVOICE_ISSUE_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) => {
      const issued = await issueDraftInvoice(
        {
          invoiceId,
          expectedVersion: input.expectedVersion,
          actorUserId,
          authority,
          now: new Date(),
        },
        client,
      );
      return {
        responseStatus: 200,
        responseBody: toPublicSaasInvoice(issued),
      };
    },
  });

  return { data: result.responseBody as PublicSaasInvoice, replayed: result.replayed };
}

/**
 * POST /platform/invoices/:id/void — DRAFT/ISSUED → VOID (frozen §14.4:
 * authorized, reason, terminal). expectedVersion (frozen §17.3); audit
 * SAAS_INVOICE_VOIDED.
 */
export async function voidSaasInvoice(
  actorUserId: string,
  authority: string,
  invoiceId: string,
  input: VoidSaasInvoiceInput,
): Promise<PublicSaasInvoice> {
  return withTransaction(async (client) => {
    const locked = await saasInvoiceRepository.lockById(invoiceId, client);
    if (!locked) throw saasInvoiceNotFoundError(invoiceId);
    if (locked.status !== 'DRAFT' && locked.status !== 'ISSUED') {
      throw saasInvoiceStatusNotAllowedError(
        invoiceId,
        locked.status,
        'void',
        ['DRAFT', 'ISSUED'],
      );
    }

    const voided = await saasInvoiceRepository.voidWithVersion(
      invoiceId,
      input.expectedVersion,
      input.reason,
      new Date(),
      client,
    );
    if (!voided) {
      const current = await saasInvoiceRepository.findById(invoiceId, client);
      if (!current) throw saasInvoiceNotFoundError(invoiceId);
      if (current.status !== 'DRAFT' && current.status !== 'ISSUED') {
        throw saasInvoiceStatusNotAllowedError(
          invoiceId,
          current.status,
          'void',
          ['DRAFT', 'ISSUED'],
        );
      }
      throw saasInvoiceVersionConflictError(
        invoiceId,
        current.version,
        input.expectedVersion,
      );
    }

    await auditInvoiceEvent(
      {
        clientId: voided.customerId,
        eventType: SAAS_INVOICE_VOIDED_EVENT,
        entityId: voided.id,
        actorUserId,
        authority,
        summary: `SaaS invoice voided: ${voided.number}`,
        metadata: {
          before: { status: locked.status },
          after: { status: 'VOID', voidedAt: voided.voidedAt?.toISOString() },
          reason: input.reason,
          number: voided.number,
          subscriptionId: voided.subscriptionId,
          billingAccountId: voided.billingAccountId,
          currencyCode: voided.currencyCode,
          totalAmount: voided.totalAmount,
        },
      },
      client,
    );

    return toPublicSaasInvoice(voided);
  });
}

export const saasInvoiceService = {
  createSaasInvoice,
  getSaasInvoiceDetail,
  issueSaasInvoice,
  listSaasInvoices,
  voidSaasInvoice,
  SAAS_INVOICE_ISSUE_OPERATION_KEY,
  SAAS_INVOICE_ISSUED_EVENT,
  SAAS_INVOICE_VOIDED_EVENT,
};
