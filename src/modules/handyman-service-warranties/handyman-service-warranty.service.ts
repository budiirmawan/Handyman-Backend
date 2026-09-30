import { getPool, withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import { handymanBastRepository, type HandymanBastRecord }
  from '../handyman-bast';
import { handymanScopeAssignmentRepository }
  from '../handyman-scope-assignments';
import { handymanExecutionScopeNotFoundError }
  from '../handyman-quotations';
import {
  handymanServiceWarrantyActiveConflictError,
  handymanServiceWarrantyNotAuthorizedError,
  handymanServiceWarrantyNotFoundError,
  handymanServiceWarrantyNotEligibleError,
  handymanServiceWarrantyValidationError,
} from './handyman-service-warranty.errors';
import {
  assertHandymanServiceWarrantyStartEligible,
  nextHandymanServiceWarrantyStatus,
} from './handyman-service-warranty.lifecycle';
import { handymanServiceWarrantyRepository }
  from './handyman-service-warranty.repository';
import {
  HANDYMAN_SERVICE_WARRANTY_COVERAGE_TYPES,
  type ExpireHandymanServiceWarrantyInput,
  type HandymanServiceWarrantyCoverageRecord,
  type HandymanServiceWarrantyCommandResult,
  type HandymanServiceWarrantyRecord,
  type StartHandymanServiceWarrantyInput,
} from './handyman-service-warranty.types';

/**
 * CR-HM-15 PART 01 — START + EXPIRE commands ONLY (FROZEN governance
 * `CR-HM-15_START_GOVERNANCE.md` §3/§4/§5/§5.1/§6, §8 row 01).
 *
 * Warranty start is DERIVED, never claimed: the command reads the
 * scope's authoritative BAST (CR-HM-11, READ-ONLY) and may create the
 * warranty ONLY when that BAST is `ACCEPTED`. The start boundary is the
 * BAST acceptance instant — no caller-supplied time, status, coverage,
 * scope or client is ever accepted. The original BAST, session, QC,
 * evidence and quotation history are never written here.
 *
 * ZERO claim intake (PART 02), ZERO rework (PART 03), ZERO chargeable
 * additional-work separation (PART 04), ZERO pricing/payment/ledger/
 * settlement/entitlement, ZERO FM asset-warranty access, ZERO HTTP.
 *
 * Authority law applied here:
 * - exactly ONE warranty per execution scope (§4 / §5.1);
 * - every mutation is one transaction + row lock + single-use
 *   idempotency key (§repo convention), replay returning the SAME rows;
 * - the head row can never be deleted and its identity is immutable, so
 *   the accepted BAST and service history stay preserved.
 */

const PG_UNIQUE_VIOLATION = '23505';

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw handymanServiceWarrantyValidationError(field);
  }
  return raw;
}

function ensureKey(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 200) {
    throw handymanServiceWarrantyValidationError('idempotencyKey');
  }
  return raw;
}

/**
 * START authority preamble: the scope must exist (bounded 404) and the
 * actor must hold access to the scope's client (403). Caller-supplied
 * customer/actor identity is never authority.
 */
async function authorityPreamble(scopeUuid: string, actorUserId: string) {
  const scope = await handymanScopeAssignmentRepository.findScopeById(
    undefined,
    scopeUuid,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  if (!(await contextAccessService.canAccessClient(
    actorUserId,
    scope.clientId,
  ))) {
    throw handymanServiceWarrantyNotAuthorizedError();
  }
  return scope;
}

/**
 * Eligibility reads the AUTHORITATIVE BAST of the scope and nothing
 * else. FAIL-CLOSED: absent BAST, non-ACCEPTED BAST or a missing
 * recorded acceptance instant never yields a warranty.
 */
function assertAcceptedBast(scopeId: string, bast: HandymanBastRecord | null) {
  if (!bast) {
    throw handymanServiceWarrantyNotEligibleError(
      `no-bast-for-scope=${scopeId}`,
    );
  }
  assertHandymanServiceWarrantyStartEligible(bast.status);
  if (!bast.acceptedAt) {
    throw handymanServiceWarrantyNotEligibleError(
      `missing-bast-acceptance-instant=${bast.id}`,
    );
  }
  return bast;
}

/**
 * START: create the SINGLE warranty head for the scope from its ACCEPTED
 * BAST, together with BOTH coverage rows (workmanship + material) and
 * the append-only START event. Replay of the SAME idempotency key
 * returns the SAME rows; a NEW key once a warranty exists is a bounded
 * 409 (never a second warranty).
 */
export async function startHandymanServiceWarranty(
  input: StartHandymanServiceWarrantyInput,
  actorUserId: string,
): Promise<HandymanServiceWarrantyCommandResult> {
  const scopeUuid = ensureUuid(input.executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);

  const scope = await authorityPreamble(scopeUuid, actorUuid);
  const bast = assertAcceptedBast(
    scope.id,
    await handymanBastRepository.findActiveBastByScopeId(undefined, scope.id),
  );

  try {
    return await withTransaction(async (client) => {
      const existing =
        await handymanServiceWarrantyRepository.findWarrantyByExecutionScopeId(
          client,
          scope.id,
        );
      if (existing) {
        const replay =
          await handymanServiceWarrantyRepository.findEventByIdempotency(
            client,
            existing.id,
            'START',
            key,
          );
        if (replay) {
          const coverages =
            await handymanServiceWarrantyRepository.listCoverages(
              client,
              existing.id,
            );
          return {
            warranty: existing,
            coverages,
            event: replay,
            replayed: true,
          };
        }
        throw handymanServiceWarrantyActiveConflictError(scope.id);
      }

      const warranty = await handymanServiceWarrantyRepository
        .createWarrantyFromAcceptedBast(client, {
          bastId: bast.id,
          startedByUserId: actorUuid,
        });
      const coverages: HandymanServiceWarrantyCoverageRecord[] = [];
      for (const coverageType of HANDYMAN_SERVICE_WARRANTY_COVERAGE_TYPES) {
        coverages.push(
          await handymanServiceWarrantyRepository.insertCoverage(client, {
            clientId: warranty.clientId,
            warrantyId: warranty.id,
            executionScopeId: warranty.executionScopeId,
            coverageType,
          }),
        );
      }
      const event = await handymanServiceWarrantyRepository.insertEvent(
        client,
        {
          clientId: warranty.clientId,
          warrantyId: warranty.id,
          executionScopeId: warranty.executionScopeId,
          bastId: warranty.bastId,
          eventType: 'START',
          idempotencyKey: key,
          actorUserId: actorUuid,
        },
      );
      return { warranty, coverages, event, replayed: false };
    });
  } catch (error) {
    const err = error as { code?: string };
    if (err.code === PG_UNIQUE_VIOLATION) {
      throw handymanServiceWarrantyActiveConflictError(scope.id);
    }
    throw error;
  }
}

/**
 * EXPIRE: the bounded PART 01 terminal transition (ACTIVE → EXPIRED),
 * recorded as an append-only fact. Only that transition exists in this
 * PART — claim/rework transitions arrive with PART 02+.
 */
export async function expireHandymanServiceWarranty(
  input: ExpireHandymanServiceWarrantyInput,
  actorUserId: string,
): Promise<HandymanServiceWarrantyCommandResult> {
  const warrantyUuid = ensureUuid(input.warrantyId, 'warrantyId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);

  const existing = await handymanServiceWarrantyRepository.findWarrantyById(
    getPool(),
    warrantyUuid,
  );
  if (!existing) throw handymanServiceWarrantyNotFoundError();
  if (!(await contextAccessService.canAccessClient(
    actorUuid,
    existing.clientId,
  ))) {
    throw handymanServiceWarrantyNotAuthorizedError();
  }

  return withTransaction(async (client) => {
    const warranty = await handymanServiceWarrantyRepository.findWarrantyById(
      client,
      warrantyUuid,
      true,
    );
    if (!warranty) throw handymanServiceWarrantyNotFoundError();
    const replay = await handymanServiceWarrantyRepository
      .findEventByIdempotency(client, warranty.id, 'EXPIRE', key);
    if (replay) {
      const coverages = await handymanServiceWarrantyRepository.listCoverages(
        client,
        warranty.id,
      );
      return { warranty, coverages, event: replay, replayed: true };
    }
    const next = nextHandymanServiceWarrantyStatus(warranty.status, 'EXPIRE');
    const updated = await handymanServiceWarrantyRepository
      .updateWarrantyStatus(client, warranty.id, next);
    const event = await handymanServiceWarrantyRepository.insertEvent(client, {
      clientId: updated.clientId,
      warrantyId: updated.id,
      executionScopeId: updated.executionScopeId,
      bastId: updated.bastId,
      eventType: 'EXPIRE',
      idempotencyKey: key,
      actorUserId: actorUuid,
    });
    const coverages = await handymanServiceWarrantyRepository.listCoverages(
      client,
      updated.id,
    );
    return { warranty: updated, coverages, event, replayed: false };
  });
}

/** Read helper — the scope's warranty, or null when not started. */
export async function findHandymanServiceWarrantyByScopeId(
  executionScopeId: string,
): Promise<HandymanServiceWarrantyRecord | null> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  return handymanServiceWarrantyRepository.findWarrantyByExecutionScopeId(
    getPool(),
    scopeUuid,
  );
}

/** Read helper — a warranty by id, or a bounded 404. */
export async function getHandymanServiceWarrantyById(
  warrantyId: string,
): Promise<HandymanServiceWarrantyRecord> {
  const warrantyUuid = ensureUuid(warrantyId, 'warrantyId');
  const warranty = await handymanServiceWarrantyRepository.findWarrantyById(
    getPool(),
    warrantyUuid,
  );
  if (!warranty) throw handymanServiceWarrantyNotFoundError();
  return warranty;
}
