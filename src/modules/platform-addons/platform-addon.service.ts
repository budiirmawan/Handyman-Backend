/**
 * CR-BE-SAAS-01 PART 13C PART 01C — Add-on domain service (frozen
 * §9.5 + §6 + §18.2 amendment + §12.1 quota clarification).
 *
 * §18.2 events (closed by PART 13C PART 01C amendment):
 *   - `SAAS_ADD_ON_CHANGED` — platform-scope; catalogue create/update;
 *     `client_id = NULL`.
 *   - `SAAS_SUBSCRIPTION_ADD_ON_CHANGED` — customer-scoped; attach/
 *     detach.
 *
 * §12.1 source interaction rules (closed by PART 13C PART 01C
 * amendment):
 *   - PACKAGE active → ADD_ON attaches; PACKAGE is suspended; on
 *     detach PACKAGE is re-materialized via canonical
 *     `syncPackageEntitlements`.
 *   - ADD_ON active → duplicate binding rejected by binding-uniqueness
 *     partial index (one ACTIVE binding per `(subscription, add-on)`).
 *   - OVERRIDE | PROMOTION | MANUAL active → attach FAILS with canonical
 *     generic 409 CONFLICT; the protected row remains ACTIVE; no
 *     entitlement rows are written.
 *
 * §12.1 quota formula (closed by PART 13C PART 01C amendment):
 *   `effectiveLimit = packageBase + SUM(active add-on quota delta)`
 *   (additive on top of the package base; `deltaValue` denotes the
 *   increment above the base). Detach semantics follow from
 *   query-time computation — no separate quota table.
 *
 * Audit atomicity: every successful mutation emits exactly one
 * `recordOperationalEvent(..., txClient)` call on the SAME DB
 * client inside the same `withTransaction` (PART 13B rules A + B).
 * Failed validation / OCC / capability_locked failures emit zero
 * audit rows.
 *
 * No HTTP layers, no OpenAPI edits, no PART 14 work in this PART.
 */

import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { recordOperationalEvent } from '../operational-events';
import { syncPackageEntitlements } from '../entitlements';
import { entitlementRepository } from '../entitlements';
import { moduleRepository } from '../modules/module.repository';
import { platformProductRepository } from '../platform-products';
import { platformSubscriptionRepository } from '../platform-subscriptions/platform-subscription.repository';
import { platformAddOnRepository } from './platform-addon.repository';
import { saasAddOnNotFoundError } from './platform-addon.errors';
import type {
  AttachSaasAddOnInput,
  CreateSaasAddOnInput,
  ListSaasAddOnFilters,
  SaasAddOnRecord,
  SaasSubscriptionAddOnDetail,
  SaasSubscriptionAddOnRecord,
  UpdateSaasAddOnInput,
} from './platform-addon.types';

type Q = Pick<PoolClient, 'query'> | ReturnType<typeof getPool>;

/**
 * §18.2 amendment (PART 13C PART 01C) — frozen event names.
 */
export const SAAS_ADD_ON_CHANGED_EVENT = 'SAAS_ADD_ON_CHANGED';
export const SAAS_SUBSCRIPTION_ADD_ON_CHANGED_EVENT =
  'SAAS_SUBSCRIPTION_ADD_ON_CHANGED';

const SAAS_ADD_ON_ENTITY_TYPE = 'SAAS_ADD_ON';
const SAAS_SUBSCRIPTION_ADD_ON_ENTITY_TYPE = 'SAAS_SUBSCRIPTION_ADD_ON';

/**
 * Sources that PROTECT the one-active slot from displacement by an
 * ADD_ON attach (PART 13C PART 01C source-precedence amendment).
 */
const PROTECTED_ACTIVE_SOURCES = new Set([
  'OVERRIDE',
  'PROMOTION',
  'MANUAL',
]);

function validateCatalogEffects(input: CreateSaasAddOnInput): void {
  if (!input.productId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'productId', message: 'productId is mandatory.' },
    ]);
  }
  if (
    !input.code ||
    typeof input.code !== 'string' ||
    input.code.length > 100
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'code',
        message: 'code is mandatory and must be ≤100 characters.',
      },
    ]);
  }
  if (!input.name || typeof input.name !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field: 'name', message: 'name is mandatory.' },
    ]);
  }
  if (
    input.entitlementEffects !== undefined &&
    !Array.isArray(input.entitlementEffects)
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'entitlementEffects',
        message: 'entitlementEffects must be an array.',
      },
    ]);
  }
  if (
    input.quotaEffects !== undefined &&
    !Array.isArray(input.quotaEffects)
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'quotaEffects',
        message: 'quotaEffects must be an array.',
      },
    ]);
  }
}

export async function listSaasAddOns(
  filters: ListSaasAddOnFilters = {},
): Promise<SaasAddOnRecord[]> {
  return platformAddOnRepository.listAll(filters);
}

export async function getSaasAddOnDetail(
  id: string,
): Promise<SaasAddOnRecord> {
  const record = await platformAddOnRepository.findById(id);
  if (!record) throw saasAddOnNotFoundError(id);
  return record;
}

/**
 * POST /platform/add-ons — catalogue create.
 *
 * Audit: `SAAS_ADD_ON_CHANGED` once, `client_id = NULL` (platform-scope).
 * Mutation + audit in same `withTransaction`.
 */
export async function createSaasAddOn(input: {
  actorUserId: string;
  authority: string;
  body: CreateSaasAddOnInput;
  requestId?: string;
}): Promise<SaasAddOnRecord> {
  validateCatalogEffects(input.body);
  const product = await platformProductRepository.findProductById(
    input.body.productId,
  );
  if (!product) {
    throw new AppError({
      code: ERROR_CODES.SAAS_PRODUCT_NOT_FOUND,
      message: 'Owning SaaS product not found.',
      statusCode: 404,
      resource: { type: 'SAAS_PRODUCT', id: input.body.productId },
    });
  }

  try {
    return await withTransaction(async (txClient) => {
      const record = await platformAddOnRepository.insert(
        input.body,
        txClient,
      );
      await recordOperationalEvent(
        {
          clientId: null,
          eventType: SAAS_ADD_ON_CHANGED_EVENT,
          entityType: SAAS_ADD_ON_ENTITY_TYPE,
          entityId: record.id,
          actorUserId: input.actorUserId,
          summary: `Add-on ${input.body.code} created`,
          metadata: {
            authority: input.authority,
            action: 'CREATED',
            addOnId: record.id,
            productId: record.productId,
            code: record.code,
            after: {
              name: record.name,
              status: record.status,
            },
            requestId: input.requestId ?? null,
          },
        },
        txClient,
      );
      return record;
    });
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    ) {
      throw new AppError({
        code: ERROR_CODES.CONFLICT,
        message:
          'An add-on with this code already exists for the product.',
        statusCode: 409,
      });
    }
    throw err;
  }
}

/**
 * PATCH /platform/add-ons/:id — catalogue update (no OCC).
 *
 * Audit: `SAAS_ADD_ON_CHANGED` once, `client_id = NULL`.
 */
export async function updateSaasAddOn(input: {
  actorUserId: string;
  authority: string;
  id: string;
  body: UpdateSaasAddOnInput;
  requestId?: string;
}): Promise<SaasAddOnRecord> {
  return withTransaction(async (txClient) => {
    const before = await platformAddOnRepository.findById(input.id, txClient);
    if (!before) throw saasAddOnNotFoundError(input.id);
    const updated = await platformAddOnRepository.update(
      input.id,
      input.body,
      txClient,
    );
    if (!updated) throw saasAddOnNotFoundError(input.id);
    await recordOperationalEvent(
      {
        clientId: null,
        eventType: SAAS_ADD_ON_CHANGED_EVENT,
        entityType: SAAS_ADD_ON_ENTITY_TYPE,
        entityId: updated.id,
        actorUserId: input.actorUserId,
        summary: `Add-on ${updated.code} updated`,
        metadata: {
          authority: input.authority,
          action: 'UPDATED',
          addOnId: updated.id,
          productId: updated.productId,
          code: updated.code,
          before: {
            name: before.name,
            status: before.status,
          },
          after: {
            name: updated.name,
            status: updated.status,
          },
          requestId: input.requestId ?? null,
        },
      },
      txClient,
    );
    return updated;
  });
}

async function resolveAddOnCapabilityTargets(
  record: SaasAddOnRecord,
  q: Q,
): Promise<Array<{ moduleId: string; capabilityCode: string }>> {
  const out: Array<{ moduleId: string; capabilityCode: string }> = [];
  for (const effect of record.entitlementEffects) {
    if (!effect.capabilityCode) continue;
    const module = await moduleRepository.findByCode(
      effect.capabilityCode,
      q,
    );
    if (!module) continue;
    if (out.some((entry) => entry.moduleId === module.id)) continue;
    out.push({ moduleId: module.id, capabilityCode: module.code });
  }
  return out;
}

/**
 * Attach-side entitlement materialization.
 *
 * Frozen §12.1 (PART 13C PART 01C source-precedence amendment):
 *  - PACKAGE active → SUSPEND, install ADD_ON.
 *  - ADD_ON active → unreachable here (binding uniqueness rejects first).
 *  - OVERRIDE / PROMOTION / MANUAL active → REJECT (canonical generic
 *    409 CONFLICT) before any row is written.
 */
async function materializeAddOnEntitlements(
  subscriptionId: string,
  addOn: SaasAddOnRecord,
  txClient: Q,
): Promise<string[]> {
  const targets = await resolveAddOnCapabilityTargets(addOn, txClient);
  const ids: string[] = [];
  for (const target of targets) {
    const existing =
      await entitlementRepository.findBySubscriptionAndModule(
        subscriptionId,
        target.moduleId,
        txClient,
      );
    if (existing && existing.status === 'ACTIVE') {
      if (PROTECTED_ACTIVE_SOURCES.has(existing.source)) {
        throw new AppError({
          code: ERROR_CODES.CONFLICT,
          message:
            'The targeted capability is administratively locked by an active grant of an authoritative source (OVERRIDE / PROMOTION / MANUAL). Detach that source first.',
          statusCode: 409,
        });
      }
      // PACKAGE / ADD_ON: pass the slot to ADD_ON; history preserved.
      await entitlementRepository.suspendRow(existing.id, txClient);
    }
    const newRow = await entitlementRepository.createEntitlement(
      {
        subscriptionId,
        moduleId: target.moduleId,
        status: 'ACTIVE',
        startsAt: new Date(),
        endsAt: null,
        source: 'ADD_ON',
        limitValue: null,
      },
      txClient,
    );
    ids.push(newRow.id);
  }
  return ids;
}

/**
 * POST /platform/subscriptions/:id/add-ons
 *
 * OCC: subscription aggregate (frozen §22 `ver`). Audit:
 * `SAAS_SUBSCRIPTION_ADD_ON_CHANGED` action `ATTACHED`,
 * customer-scoped.
 */
export async function attachSaasAddOn(input: {
  actorUserId: string;
  authority: string;
  body: AttachSaasAddOnInput;
  requestId?: string;
}): Promise<SaasSubscriptionAddOnDetail> {
  if (!input.body.subscriptionId) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'subscriptionId',
        message: 'subscriptionId is mandatory.',
      },
    ]);
  }
  if (!input.body.addOnId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'addOnId', message: 'addOnId is mandatory.' },
    ]);
  }

  return withTransaction(async (txClient) => {
    const addOn = await platformAddOnRepository.findById(
      input.body.addOnId,
      txClient,
    );
    if (!addOn) throw saasAddOnNotFoundError(input.body.addOnId);
    if (addOn.status !== 'ACTIVE') {
      throw saasAddOnNotFoundError(input.body.addOnId);
    }

    const subscription =
      await platformSubscriptionRepository.findById(
        input.body.subscriptionId,
        txClient,
      );
    if (!subscription) {
      throw new AppError({
        code: ERROR_CODES.SAAS_SUBSCRIPTION_NOT_FOUND,
        message: 'SaaS subscription not found.',
        statusCode: 404,
      });
    }

    const bumped =
      await platformSubscriptionRepository.bumpVersion(
        input.body.subscriptionId,
        input.body.expectedVersion,
        txClient,
      );
    if (!bumped) {
      throw new AppError({
        code: ERROR_CODES.VERSION_CONFLICT,
        message:
          'Subscription version conflict for add-on attachment.',
        statusCode: 409,
      });
    }

    const existingBinding =
      await platformAddOnRepository.findActiveBinding(
        input.body.subscriptionId,
        input.body.addOnId,
        txClient,
      );
    if (existingBinding) {
      throw new AppError({
        code: ERROR_CODES.CONFLICT,
        message:
          'This add-on is already attached to the subscription.',
        statusCode: 409,
      });
    }

    let binding: SaasSubscriptionAddOnRecord;
    try {
      binding = await platformAddOnRepository.insertBinding(
        input.body,
        txClient,
      );
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === '23505'
      ) {
        throw new AppError({
          code: ERROR_CODES.CONFLICT,
          message:
            'This add-on is already attached to the subscription.',
          statusCode: 409,
        });
      }
      throw err;
    }

    const materializedIds = await materializeAddOnEntitlements(
      input.body.subscriptionId,
      addOn,
      txClient,
    );

    await recordOperationalEvent(
      {
        clientId: subscription.clientId ?? null,
        eventType: SAAS_SUBSCRIPTION_ADD_ON_CHANGED_EVENT,
        entityType: SAAS_SUBSCRIPTION_ADD_ON_ENTITY_TYPE,
        entityId: binding.id,
        actorUserId: input.actorUserId,
        summary: `Add-on ${addOn.code} attached to subscription ${subscription.id}`,
        metadata: {
          authority: input.authority,
          action: 'ATTACHED',
          subscriptionId: subscription.id,
          addOnId: addOn.id,
          before: { bindingStatus: null },
          after: { bindingStatus: 'ACTIVE' },
          expectedVersion: input.body.expectedVersion,
          resultingVersion: bumped.version,
          materializedEntitlementIds: materializedIds,
          requestId: input.requestId ?? null,
        },
      },
      txClient,
    );

    return {
      ...binding,
      materializedEntitlementIds: materializedIds,
    };
  });
}

/**
 * DELETE /platform/subscriptions/:id/add-ons/:addOnId
 *
 * OCC: subscription aggregate (frozen §22 `ver`). Audit:
 * `SAAS_SUBSCRIPTION_ADD_ON_CHANGED` action `DETACHED`,
 * customer-scoped. PACKAGE restoration through canonical
 * `syncPackageEntitlements`.
 */
export async function detachSaasAddOn(input: {
  actorUserId: string;
  authority: string;
  subscriptionId: string;
  addOnId: string;
  expectedVersion: number;
  requestId?: string;
}): Promise<SaasSubscriptionAddOnDetail> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'expectedVersion',
        message: 'expectedVersion must be a positive integer.',
      },
    ]);
  }

  return withTransaction(async (txClient) => {
    const subscription =
      await platformSubscriptionRepository.findById(
        input.subscriptionId,
        txClient,
      );
    if (!subscription) {
      throw new AppError({
        code: ERROR_CODES.SAAS_SUBSCRIPTION_NOT_FOUND,
        message: 'SaaS subscription not found.',
        statusCode: 404,
      });
    }
    const bumped = await platformSubscriptionRepository.bumpVersion(
      input.subscriptionId,
      input.expectedVersion,
      txClient,
    );
    if (!bumped) {
      throw new AppError({
        code: ERROR_CODES.VERSION_CONFLICT,
        message: 'Subscription version conflict for add-on detach.',
        statusCode: 409,
      });
    }

    const binding =
      await platformAddOnRepository.findActiveBinding(
        input.subscriptionId,
        input.addOnId,
        txClient,
      );
    if (!binding) {
      throw new AppError({
        code: ERROR_CODES.NOT_FOUND,
        message: 'Add-on binding not found for this subscription.',
        statusCode: 404,
      });
    }

    const addOn = await platformAddOnRepository.findById(
      input.addOnId,
      txClient,
    );
    if (!addOn) throw saasAddOnNotFoundError(input.addOnId);

    const targets = await resolveAddOnCapabilityTargets(addOn, txClient);
    for (const target of targets) {
      const existing =
        await entitlementRepository.findBySubscriptionAndModule(
          input.subscriptionId,
          target.moduleId,
          txClient,
        );
      if (existing && existing.source === 'ADD_ON') {
        await entitlementRepository.suspendRow(existing.id, txClient);
      }
    }

    if (subscription.packageId) {
      await syncPackageEntitlements(
        input.subscriptionId,
        subscription.packageId,
        new Date(),
        txClient,
      );
    }

    const updatedBinding =
      await platformAddOnRepository.markBindingRemoved(
        binding.id,
        txClient,
      );
    if (!updatedBinding) {
      const reloaded =
        await platformAddOnRepository.findBindingById(
          binding.id,
          txClient,
        );
      return {
        ...(reloaded ?? binding),
        materializedEntitlementIds: [],
      };
    }

    await recordOperationalEvent(
      {
        clientId: subscription.clientId ?? null,
        eventType: SAAS_SUBSCRIPTION_ADD_ON_CHANGED_EVENT,
        entityType: SAAS_SUBSCRIPTION_ADD_ON_ENTITY_TYPE,
        entityId: updatedBinding.id,
        actorUserId: input.actorUserId,
        summary: `Add-on ${addOn.code} detached from subscription ${subscription.id}`,
        metadata: {
          authority: input.authority,
          action: 'DETACHED',
          subscriptionId: subscription.id,
          addOnId: addOn.id,
          before: { bindingStatus: 'ACTIVE' },
          after: { bindingStatus: 'REMOVED' },
          expectedVersion: input.expectedVersion,
          resultingVersion: bumped.version,
          requestId: input.requestId ?? null,
        },
      },
      txClient,
    );

    return {
      ...updatedBinding,
      materializedEntitlementIds: [],
    };
  });
}
