import { AppError } from '../../shared/errors';
import { withTransaction } from '../../database';
import { currencyRepository } from '../currencies';
import { recordOperationalEvent } from '../operational-events';
import {
  computeRequestFingerprint,
  executeIdempotent,
} from '../request-idempotency';
import { saasPackageNotFoundError, saasProductNotFoundError } from '../platform-products/platform-product.errors';
import { platformProductRepository } from '../platform-products/platform-product.repository';
import {
  saasPricebookCodeAlreadyExistsError,
  saasPricebookNotFoundError,
  saasPricebookVersionNotPublishableError,
  saasPricebookVersionNotFoundError,
} from './platform-pricebook.errors';
import { platformPricebookRepository } from './platform-pricebook.repository';
import {
  type BillingCycle,
  type CreateSaasPricebookInput,
  type CreateSaasPricebookVersionInput,
  type ListSaasPricebookFilters,
  type NormalizedPriceItem,
  type SaasPricebookDetail,
  type SaasPricebookRecord,
  type SaasPricebookVersionDetail,
  type SaasPricebookVersionRecord,
} from './platform-pricebook.types';

/**
 * CR-BE-SAAS-01 PART 02 — versioned SaaS Pricebook domain service
 * (SaaS Control Plane).
 *
 * Lifecycle (frozen §10.2): DRAFT → PUBLISHED → SUPERSEDED.
 *   - creating a version produces a DRAFT with items;
 *   - publish is the ONLY state transition: DRAFT → PUBLISHED (+ the
 *     previous PUBLISHED version is supersed: status + effective_to),
 *     executed in ONE transaction under the pricebook row lock;
 *   - PUBLISHED/SUPERSEDED versions and their items are immutable
 *     (service state check + database trigger — historical commercial
 *     terms are never restated).
 *
 * Idempotency (frozen §17.2): `POST /platform/pricebook-versions/:id/publish`
 * is the only PART 02 command on the frozen idempotency surface; it reuses
 * `executeIdempotent` under operation key `saas.pricebook.publish`
 * (operation key derived from the frozen catalog naming pattern — see the
 * PART 02 report; the frozen catalog enumerates endpoints, publish is the
 * §22 "Idem." row for pricebooks).
 *
 * Audit (frozen §18): platform-scope events (`client_id = NULL`) on the
 * single canonical store:
 *   - SAAS_PRICEBOOK_CREATED        (entity SAAS_PRICEBOOK);
 *   - SAAS_PRICE_CHANGED (frozen §18.2 "version publish/supersede") with
 *     metadata.action = DRAFT_VERSION_CREATED | PUBLISHED.
 */

/** PART 02 event names (see module doc for provenance). */
export const SAAS_PRICEBOOK_CREATED_EVENT = 'SAAS_PRICEBOOK_CREATED';
/** Frozen §18.2 name: "SAAS_PRICE_CHANGED (version publish/supersede)". */
export const SAAS_PRICE_CHANGED_EVENT = 'SAAS_PRICE_CHANGED';

/** Derived from the frozen §17.2 catalog naming pattern (saas.<domain>.<action>). */
export const SAAS_PRICEBOOK_PUBLISH_OPERATION_KEY = 'saas.pricebook.publish';

const BILLING_CYCLES: readonly BillingCycle[] = ['MONTHLY', 'ANNUAL', 'CUSTOM'];
const NAME_MAX_LENGTH = 255;
const MAX_ITEMS_PER_VERSION = 500;
const MAX_PRICE_DECIMAL_PLACES = 2;

function assertName(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw AppError.validation(`${field} is required.`, [
      { field, message: `${field} is required.` },
    ]);
  }
  if (trimmed.length > NAME_MAX_LENGTH) {
    throw AppError.validation(`${field} is too long.`, [
      { field, message: `${field} must be at most ${NAME_MAX_LENGTH} characters.` },
    ]);
  }
  return trimmed;
}

function assertStatus(
  value: string,
  field: string,
): 'ACTIVE' | 'INACTIVE' {
  if (value !== 'ACTIVE' && value !== 'INACTIVE') {
    throw AppError.validation(`${field} must be ACTIVE or INACTIVE.`, [
      { field, message: `${field} must be ACTIVE or INACTIVE.` },
    ]);
  }
  return value;
}

/** Reuses the canonical currency authority (0331) — no second currency list. */
async function assertActiveCurrency(
  currencyCode: string,
  details: { field: string; message: string }[] = [],
): Promise<void> {
  const currency = await currencyRepository.find(currencyCode);
  if (!currency || currency.status !== 'ACTIVE') {
    details.push({
      field: 'currencyCode',
      message: `currencyCode must reference an ACTIVE currency (${currencyCode} is unknown or inactive).`,
    });
  }
}

function parseEffectiveFrom(
  value: unknown,
): Date {
  if (typeof value !== 'string' || value.trim() === '') {
    throw AppError.validation('effectiveFrom is required.', [
      { field: 'effectiveFrom', message: 'effectiveFrom is required.' },
    ]);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw AppError.validation('effectiveFrom is not a valid date.', [
      {
        field: 'effectiveFrom',
        message: 'effectiveFrom must be a valid ISO date-time.',
      },
    ]);
  }
  return date;
}

function assertPrice(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw AppError.validation(`Invalid ${field}.`, [
      { field, message: `${field} must be a non-negative number.` },
    ]);
  }
  const decimals = Math.round(value * 10 ** MAX_PRICE_DECIMAL_PLACES) / 10 ** MAX_PRICE_DECIMAL_PLACES;
  if (decimals !== value) {
    throw AppError.validation(`Invalid ${field}.`, [
      {
        field,
        message: `${field} must have at most ${MAX_PRICE_DECIMAL_PLACES} decimal places.`,
      },
    ]);
  }
  if (value > 10 ** 16) {
    throw AppError.validation(`${field} is too large.`, [
      { field, message: `${field} exceeds NUMERIC(18,2) capacity.` },
    ]);
  }
  return value;
}

async function normalizePriceItems(
  rawItems: CreateSaasPricebookVersionInput['items'],
  defaultCurrencyCode: string,
): Promise<NormalizedPriceItem[]> {
  const details: { field: string; message: string }[] = [];
  const seen = new Set<string>();
  const normalized: NormalizedPriceItem[] = [];

  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    const field = (key: string) => `items[${i}].${key}`;

    const product = await platformProductRepository.findProductById(
      item.productId,
    );
    if (!product) {
      details.push({
        field: field('productId'),
        message: `product ${item.productId} not found.`,
      });
      continue;
    }

    let packageId: string | null = null;
    if (item.packageId !== undefined && item.packageId !== null) {
      const pkg = await platformProductRepository.findPackageById(
        item.packageId,
      );
      if (!pkg) {
        details.push({
          field: field('packageId'),
          message: `package ${item.packageId} not found.`,
        });
        continue;
      }
      if (pkg.productId !== product.id) {
        details.push({
          field: field('packageId'),
          message: `package ${item.packageId} does not belong to product ${product.code}.`,
        });
        continue;
      }
      packageId = pkg.id;
    }

    const currencyCode = (item.currencyCode ?? defaultCurrencyCode)
      .trim()
      .toUpperCase();
    await assertActiveCurrency(currencyCode, details);

    const billingCycle = item.billingCycle as string;
    if (!(BILLING_CYCLES as readonly string[]).includes(billingCycle)) {
      details.push({
        field: field('billingCycle'),
        message: `billingCycle must be one of ${BILLING_CYCLES.join(', ')}.`,
      });
    }

    const basePrice = assertPrice(
      item.basePrice as number,
      field('basePrice'),
    );
    const includedBuildingCount =
      item.includedBuildingCount === undefined
        ? 0
        : item.includedBuildingCount;
    if (
      typeof includedBuildingCount !== 'number' ||
      !Number.isInteger(includedBuildingCount) ||
      includedBuildingCount < 0
    ) {
      details.push({
        field: field('includedBuildingCount'),
        message: 'includedBuildingCount must be a non-negative integer.',
      });
    }
    const additionalBuildingPrice =
      item.additionalBuildingPrice === undefined
        ? 0
        : assertPrice(item.additionalBuildingPrice as number, field('additionalBuildingPrice'));

    const uniquenessKey = `${product.id}|${packageId ?? ''}|${billingCycle}`;
    if (seen.has(uniquenessKey)) {
      details.push({
        field: field('billingCycle'),
        message: 'duplicate (product, package, billingCycle) within the version.',
      });
    }
    seen.add(uniquenessKey);

    normalized.push({
      productId: product.id,
      packageId,
      currencyCode,
      billingCycle: billingCycle as BillingCycle,
      basePrice,
      includedBuildingCount,
      additionalBuildingPrice,
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Invalid price items.', details);
  }
  return normalized;
}

function versionSnapshot(
  version: SaasPricebookVersionRecord,
  items?: readonly {
    productId: string;
    packageId: string | null;
    currencyCode: string;
    billingCycle: BillingCycle;
    basePrice: number;
    includedBuildingCount: number;
    additionalBuildingPrice: number;
  }[],
): Record<string, unknown> {
  return {
    versionNumber: version.versionNumber,
    status: version.status,
    effectiveFrom: version.effectiveFrom ? version.effectiveFrom.toISOString() : null,
    effectiveTo: version.effectiveTo ? version.effectiveTo.toISOString() : null,
    publishedAt: version.publishedAt ? version.publishedAt.toISOString() : null,
    publishedByUserId: version.publishedByUserId,
    ...(items !== undefined
      ? {
          itemCount: items.length,
          items: items.map((item) => ({
            productId: item.productId,
            packageId: item.packageId,
            currencyCode: item.currencyCode,
            billingCycle: item.billingCycle,
            basePrice: item.basePrice,
            includedBuildingCount: item.includedBuildingCount,
            additionalBuildingPrice: item.additionalBuildingPrice,
          })),
        }
      : {}),
  };
}

export async function createSaasPricebook(
  actorUserId: string,
  authority: string,
  input: CreateSaasPricebookInput,
): Promise<SaasPricebookRecord> {
  const code = input.code.trim().toUpperCase();
  if (code.length === 0 || code.length > 64 || !/^[A-Z][A-Z0-9_-]*$/.test(code)) {
    throw AppError.validation('Invalid pricebook code.', [
      {
        field: 'code',
        message: 'code must start with a letter and contain letters, digits, "-" or "_" (max 64).',
      },
    ]);
  }
  const name = assertName(input.name, 'name');
  const currencyCode = input.currencyCode.trim().toUpperCase();
  const currencyDetails: { field: string; message: string }[] = [];
  await assertActiveCurrency(currencyCode, currencyDetails);
  if (currencyDetails.length > 0) {
    throw AppError.validation('Request validation failed.', currencyDetails);
  }
  const status =
    input.status !== undefined
      ? assertStatus(input.status, 'status')
      : 'ACTIVE';

  const existing = await platformPricebookRepository.findPricebookByCode(code);
  if (existing) {
    throw saasPricebookCodeAlreadyExistsError();
  }

  const record = await platformPricebookRepository.createPricebook({
    code,
    name,
    currencyCode,
    status,
  });

  await recordOperationalEvent({
    clientId: null,
    eventType: SAAS_PRICEBOOK_CREATED_EVENT,
    entityType: 'SAAS_PRICEBOOK',
    entityId: record.id,
    actorUserId,
    summary: `SaaS pricebook created: ${record.code} (${record.currencyCode})`,
    metadata: {
      authority,
      after: {
        code: record.code,
        name: record.name,
        currencyCode: record.currencyCode,
        status: record.status,
      },
    },
  });

  return record;
}

export async function listSaasPricebooks(params: {
  filters: ListSaasPricebookFilters;
  withTotal: boolean;
  page?: number;
  pageSize?: number;
}): Promise<{ records: SaasPricebookRecord[]; total: number | null }> {
  const limit = params.pageSize;
  const offset =
    params.page !== undefined && params.pageSize !== undefined
      ? (params.page - 1) * params.pageSize
      : undefined;
  return platformPricebookRepository.listPricebooks(
    params.filters,
    params.withTotal,
    limit,
    offset,
  );
}

export async function getSaasPricebookDetail(
  pricebookId: string,
): Promise<SaasPricebookDetail> {
  const pricebook = await platformPricebookRepository.findPricebookById(
    pricebookId,
  );
  if (!pricebook) {
    throw saasPricebookNotFoundError(pricebookId);
  }
  const versions = await platformPricebookRepository.findVersionsByPricebookId(
    pricebook.id,
  );
  const versionDetails: SaasPricebookVersionDetail[] = [];
  for (const version of versions) {
    const items = await platformPricebookRepository.findItemsByVersionId(
      version.id,
    );
    versionDetails.push({ ...version, items });
  }
  return { ...pricebook, versions: versionDetails };
}

export async function createSaasPricebookVersion(
  actorUserId: string,
  authority: string,
  pricebookId: string,
  input: CreateSaasPricebookVersionInput,
): Promise<SaasPricebookVersionDetail> {
  const pricebook = await platformPricebookRepository.findPricebookById(
    pricebookId,
  );
  if (!pricebook) {
    throw saasPricebookNotFoundError(pricebookId);
  }

  const effectiveFrom = parseEffectiveFrom(input.effectiveFrom);
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw AppError.validation('items is required.', [
      { field: 'items', message: 'items must be a non-empty array.' },
    ]);
  }
  if (input.items.length > MAX_ITEMS_PER_VERSION) {
    throw AppError.validation('Too many price items.', [
      {
        field: 'items',
        message: `items must have at most ${MAX_ITEMS_PER_VERSION} entries.`,
      },
    ]);
  }
  const items = await normalizePriceItems(input.items, pricebook.currencyCode);

  return withTransaction(async (client) => {
    // Serialize version numbering per pricebook.
    await platformPricebookRepository.lockPricebook(pricebook.id, client);
    const versionNumber = await platformPricebookRepository.nextVersionNumber(
      pricebook.id,
      client,
    );

    const created = await platformPricebookRepository.createVersion(
      {
        pricebookId: pricebook.id,
        versionNumber,
        effectiveFrom,
      },
      client,
    );
    await platformPricebookRepository.insertPriceItems(
      created.id,
      items,
      client,
    );
    await recordOperationalEvent(
      {
        clientId: null,
        eventType: SAAS_PRICE_CHANGED_EVENT,
        entityType: 'SAAS_PRICEBOOK',
        entityId: created.id,
        actorUserId,
        summary: `Pricebook version draft created: ${pricebook.code} v${created.versionNumber}`,
        metadata: {
          authority,
          action: 'DRAFT_VERSION_CREATED',
          after: versionSnapshot(created, items),
        },
      },
      client,
    );
    const itemsAfter = await platformPricebookRepository.findItemsByVersionId(
      created.id,
      client,
    );
    return { ...created, items: itemsAfter };
  });
}

/**
 * Publishes a DRAFT pricebook version (frozen §10.2/§22 "Idem.").
 *
 * One transaction: lock pricebook → verify DRAFT → supersede the previous
 * PUBLISHED version (status + effective_to) → publish. Idempotent replay
 * returns the stored success; a different body on the same key is a 409
 * IDEMPOTENCY_CONFLICT.
 */
export async function publishSaasPricebookVersion(
  actorUserId: string,
  authority: string,
  versionId: string,
  idempotencyKey: string,
): Promise<{ data: SaasPricebookVersionDetail; replayed: boolean }> {
  const requestFingerprint = computeRequestFingerprint({
    pricebookVersionId: versionId,
  });

  const result = await executeIdempotent({
    actorUserId,
    operationKey: SAAS_PRICEBOOK_PUBLISH_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) => {
      const version = await platformPricebookRepository.findVersionById(
        versionId,
        client,
      );
      if (!version) {
        throw saasPricebookVersionNotFoundError(versionId);
      }
      if (version.status !== 'DRAFT') {
        throw saasPricebookVersionNotPublishableError(
          versionId,
          version.status,
        );
      }

      // Serialize publish per pricebook (monotonic invariant + single
      // PUBLISHED version per pricebook).
      await platformPricebookRepository.lockPricebook(version.pricebookId, client);

      const currentPublished =
        await platformPricebookRepository.findPublishedVersionByPricebookId(
          version.pricebookId,
          client,
        );

      const before = versionSnapshot(version);
      const published = await platformPricebookRepository.publishVersion(
        version.id,
        actorUserId,
        currentPublished?.id ?? null,
        version.effectiveFrom,
        client,
      );
      const after = versionSnapshot(published);

      await recordOperationalEvent(
        {
          clientId: null,
          eventType: SAAS_PRICE_CHANGED_EVENT,
          entityType: 'SAAS_PRICEBOOK',
          entityId: version.id,
          actorUserId,
          summary: `Pricebook version published: v${published.versionNumber}`,
          metadata: {
            authority,
            action: 'PUBLISHED',
            before,
            after,
            supersededVersionId: currentPublished?.id ?? null,
            supersede: currentPublished
              ? {
                  versionId: currentPublished.id,
                  versionNumber: currentPublished.versionNumber,
                  effectiveTo:
                    version.effectiveFrom?.toISOString() ?? null,
                }
              : null,
          },
        },
        client,
      );

      const items = await platformPricebookRepository.findItemsByVersionId(
        version.id,
        client,
      );

      return {
        responseStatus: 201,
        responseBody: { ...published, items },
      };
    },
  });

  return {
    data: result.responseBody as SaasPricebookVersionDetail,
    replayed: result.replayed,
  };
}
