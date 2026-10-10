import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { isValidUuid } from '../clients';
import { withTransaction } from '../../database';
import {
  assertQuotationThreadBuildingAccess,
  handymanQuotationRepository,
} from '../handyman-quotations';
import {
  computeRequestFingerprint,
  executeIdempotent,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from '../request-idempotency';
import { recordOperationalEvent } from '../operational-events';
import { handymanQuotationApprovalBindingRepository as repo } from './handyman-quotation-approval-binding.repository';
import {
  bindingFrozenByDecisionError,
  bindingGuardRefusalError,
  bindingLineageConflictError,
  bindingPinnedError,
  bindingConcurrentWriteError,
  bindingSelfAuthorityError,
  bindingTargetUnavailableError,
  bindingWindowInvalidError,
} from './handyman-quotation-approval-binding.errors';
import type {
  BindHandymanQuotationApprovalBindingInput,
  HandymanQuotationApprovalBindingRecord,
  HandymanQuotationApprovalBindingWriteData,
  PublicHandymanQuotationApprovalBinding,
  PublicHandymanQuotationApprovalBindingRead,
  PublicHandymanQuotationApprovalStatus,
  RevokeHandymanQuotationApprovalBindingInput,
} from './handyman-quotation-approval-binding.types';

/**
 * W03 PART 03B2 — the staff binding write path (ADD-A B1–B11, B13–B18,
 * R-1.2, MC1'; C21/C22; A01 §9 binding rows).
 *
 * WHAT A BINDING IS. An audited, revocable, occupancy-verified statement of
 * *who is entitled to consent* on a quotation thread. It is not approval (B9):
 * this module writes exactly two things — a row in the append-only binding
 * ledger and a row in `operational_events` — and it cannot reach a decision row
 * at all. `handyman_quotation_decisions` carries its own INSERT guard that
 * refuses every non-`TENANT_PIC` row, so "selecting the signer" can never
 * impersonate "someone consented", and the request's lineage `tenant_pic_id` is
 * read-only here (decision 6: never repurposed, never written).
 *
 * FAIL-CLOSED EVERYWHERE (MC4'). Inability to EVALUATE is a refusal: missing
 * lineage, missing PIC row, missing occupancy row, unresolved tenant, inactive
 * tenant/company. Nothing is inferred, defaulted, or inherited from a previous
 * binding. A PIC with no `users` link is a legitimate state and stays bindable
 * — the refusal is about overlap (MC1'), never about a missing link.
 *
 * SERVICE CHECKS + DB FLOOR, NOT SERVICE CHECKS INSTEAD OF THE FLOOR (B20).
 * The pre-checks below exist to hand a caller a stable HTTP code; the `0437`
 * guard re-enforces the same rules inside the same transaction. A check that
 * loses a race therefore still cannot produce an illegal row: the guard raises,
 * `bindingGuardRefusalError` maps the raise back onto the ratified envelope,
 * and the transaction rolls the ledger write, the journal row AND the
 * idempotency claim back together.
 *
 * IDEMPOTENCY rides the shared CR-BE-IDEMPOTENCY-CORE-01 substrate
 * (`request_idempotency_records`, `0349`): actor + server-defined operation key
 * + SHA-256(normalized `Idempotency-Key`) + canonical request fingerprint,
 * transaction-owning, success-only, no record on rollback, no new enumerable
 * error code (the substrate's own `IDEMPOTENCY_CONFLICT` 409 covers a
 * same-key/different-body replay). This is why 03B2 changes NO schema: `0437`
 * already carries the floor a binding needs (`binding_version` +
 * `…_one_per_version` + `…_one_active`), while minting an extra
 * `idempotency_key`/UNIQUE pair here is precisely the tightening ADD-A M6 /
 * A01 R6 forbid — BLK-7 stays its own measured migration.
 *
 * LOCK ORDER (M4): idempotency claim (own table) → quotation thread row →
 * binding rows. The ledger is never touched before the thread is locked, and
 * no session row exists in this PART.
 */

/** Server-defined idempotency operation namespaces (never caller-supplied). */
export const BIND_HANDYMAN_QUOTATION_APPROVAL_BINDING_OPERATION_KEY =
  'bindHandymanQuotationApprovalAuthority';
export const REVOKE_HANDYMAN_QUOTATION_APPROVAL_BINDING_OPERATION_KEY =
  'revokeHandymanQuotationApprovalBinding';

/** The dedicated binding authority (item 7). UNASSIGNED_BY_DEFAULT: a grant
 *  is a deliberate administrative act, and it rides ON TOP of
 *  `tenant_company.manage` (B8) — never instead of it. */
export const HANDYMAN_QUOTATION_APPROVAL_BINDING_MANAGE_PERMISSION =
  'handyman.quotation.approval.binding.manage';

/** Narrative fields are audit-only, bounded so no payload dump can ride. */
const NOTE_MAX_LENGTH = 500;

/** History rows the bounded read returns (ledger is small by design). */
const HISTORY_LIMIT = 20;

function assertUuid(value: string | undefined, field: string): string {
  if (value === undefined || !isValidUuid(value)) {
    throw AppError.validation(
      'Handyman quotation approval binding validation failed.',
      [{ field, message: `${field} must be a valid UUID.` }],
    );
  }
  return value;
}

function assertActor(actorUserId: string): string {
  assertUuid(actorUserId, 'actorUserId');
  return actorUserId;
}

function parseWindow(
  value: string | null | undefined,
  field: string,
): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw bindingWindowInvalidError(field);
  return new Date(ms);
}

function boundedNarrative(
  value: string | null | undefined,
  field: string,
  required: boolean,
): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    if (required) {
      throw AppError.validation(
        'Handyman quotation approval binding validation failed.',
        [
          {
            field,
            message: `${field} is required (1-${NOTE_MAX_LENGTH} characters).`,
          },
        ],
      );
    }
    return null;
  }
  if (text.length > NOTE_MAX_LENGTH) {
    throw AppError.validation(
      'Handyman quotation approval binding validation failed.',
      [
        {
          field,
          message: `${field} must be at most ${NOTE_MAX_LENGTH} characters.`,
        },
      ],
    );
  }
  return text;
}

function assertIdempotencyKey(key: string): string {
  const value = typeof key === 'string' ? key.trim() : '';
  if (
    value.length < 1 ||
    value.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    /[\r\n\0]/.test(value)
  ) {
    throw AppError.validation(
      'Handyman quotation approval binding validation failed.',
      [
        {
          field: 'idempotencyKey',
          message: `Idempotency-Key is required (1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters, no control characters).`,
        },
      ],
    );
  }
  return value;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function toPublicBinding(
  record: HandymanQuotationApprovalBindingRecord,
): PublicHandymanQuotationApprovalBinding {
  // `authorityEndsAt` is the EFFECTIVE end of the conferred authority: the
  // revocation instant wins when it came first (B16 kills the effect, B14
  // forbids rewriting the window); otherwise the stated `effective_until`.
  // Server-derived, never caller-set.
  const endsAt =
    record.revokedAt &&
    (!record.effectiveUntil ||
      record.revokedAt.getTime() < record.effectiveUntil.getTime())
      ? record.revokedAt
      : record.effectiveUntil;
  return {
    id: record.id,
    quotationId: record.quotationId,
    handymanRequestId: record.handymanRequestId,
    clientId: record.clientId,
    tenantCompanyId: record.tenantCompanyId,
    buildingId: record.buildingId,
    spaceId: record.spaceId,
    tenantPicId: record.tenantPicId,
    bindingVersion: record.bindingVersion,
    supersedesBindingId: record.supersedesBindingId,
    status: record.status,
    effectiveFrom: record.effectiveFrom.toISOString(),
    effectiveUntil: iso(record.effectiveUntil),
    authorityEndsAt: iso(endsAt),
    grantedByUserId: record.grantedByUserId,
    grantedAt: record.grantedAt.toISOString(),
    revokedByUserId: record.revokedByUserId,
    revokedAt: iso(record.revokedAt),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Every eligibility-shaped refusal funnels through ONE envelope and ONE log
 * line, so a caller learns nothing it can enumerate with.
 *
 * `reason` is an operator-facing machine label (`errorCode`) and never reaches
 * the response. The log payload is the shared `LogFields` allowlist on purpose:
 * actor + thread id + reason only — no PIC id (the named person is not needed
 * to diagnose a refusal, and `logger` redacts nothing by key), no name, no
 * e-mail, no phone. Refusals write NOTHING: no ledger row, no journal row, no
 * idempotency record (the substrate stores successes only), so a refused bind
 * leaves no trace to clean up and a corrected retry with the same key works.
 */
function refuse(
  reason: string,
  input: { quotationId: string; actorUserId: string },
): AppError {
  logger.warn('Handyman quotation approval binding refused', {
    operation: 'handyman.quotation.approvalBinding.write',
    result: 'refused',
    errorCode: reason,
    resourceType: 'HANDYMAN_QUOTATION_APPROVAL_BINDING',
    resourceId: input.quotationId,
    actorUserId: input.actorUserId,
  });
  return bindingTargetUnavailableError();
}

/** A race the ledger (not the service) caught: translate, never rethrow 500. */
function translateLedgerError(error: unknown): unknown {
  const candidate = error as {
    code?: string;
    message?: string;
    constraint?: string;
  };
  if (candidate?.code === '23505') {
    // `…_one_active` / `…_one_per_version`: the thread's head moved under us.
    return bindingPinnedError();
  }
  if (candidate?.code === '23514' && typeof candidate.message === 'string') {
    return bindingGuardRefusalError(candidate.message);
  }
  return error;
}

type BindingExecutor = Parameters<typeof repo.insertBinding>[0];

/**
 * The two ledger writes, each wrapped in the guard-error translation so a
 * refusal raised by `0437` (the floor, B20) surfaces as the ratified envelope
 * instead of a raw 23514 rendering as 500.
 */
async function insertUnderGuard(
  tx: BindingExecutor,
  input: Parameters<typeof repo.insertBinding>[1],
): Promise<HandymanQuotationApprovalBindingRecord> {
  try {
    return await repo.insertBinding(tx, input);
  } catch (error) {
    throw translateLedgerError(error);
  }
}

async function revokeUnderGuard(
  tx: BindingExecutor,
  id: string,
  revokedByUserId: string,
): Promise<HandymanQuotationApprovalBindingRecord | null> {
  try {
    return await repo.revokeBinding(tx, { id, revokedByUserId });
  } catch (error) {
    throw translateLedgerError(error);
  }
}

/**
 * Shared eligibility resolution for bind and revoke: thread → lineage →
 * BE-02G wall → live B3/B4/B5 basis. Queries are SEQUENTIAL on purpose: they
 * share one transaction client, and a `pg` client serializes its own queries.
 */
async function resolveBindingContext(
  tx: BindingExecutor,
  input: {
    quotationId: string;
    actorUserId: string;
    at: Date;
    /**
     * `true` (bind) demands the full B3/B4/B5 basis a new authority needs.
     * `false` (revoke) skips it: B15 makes revocation unconditional up to the
     * B18 freeze precisely because a lost occupancy, a suspended tenant, or a
     * dead PIC is the REASON to revoke — refusing the revocation in exactly
     * that situation would keep a stale authority live. The caller-authority
     * wall (BE-02G) is enforced either way.
     */
    requireBasis: boolean;
  },
) {
  const quotation = await handymanQuotationRepository.lockQuotationById(
    tx,
    input.quotationId,
  );
  if (!quotation) throw refuse('THREAD_NOT_FOUND', input);

  const lineage = await repo.findThreadLineage(tx, quotation.handymanRequestId);
  if (!lineage) {
    // Without its lineage root a thread cannot be tenant-scoped at all.
    throw refuse('LINEAGE_NOT_FOUND', input);
  }

  // B8 authority wall: the exact-Building BE-02G assignment over the thread's
  // OWN building_id (server-derived, never caller-supplied context). The
  // `tenant_company.manage` half is route-enforced; the dedicated binding code
  // rides on top of it. `handyman-quotation-access.ts` denies a valid but
  // inaccessible Building exactly like an unknown one.
  await assertQuotationThreadBuildingAccess(
    tx as never,
    quotation,
    input.actorUserId,
  );

  let occupancyAuthorityId: string | null = null;
  let spaceAuthorityId: string | null = null;
  if (input.requireBasis) {
    const tenant = await repo.findTenantCompanyAndClientStatuses(
      tx,
      lineage.tenantCompanyId,
      lineage.clientId,
    );
    if (
      tenant.tenantStatus !== 'ACTIVE' ||
      tenant.clientStatus !== 'ACTIVE' ||
      tenant.tenantClient !== lineage.clientId
    ) {
      throw refuse('TENANT_OR_CLIENT_INACTIVE', input);
    }

    occupancyAuthorityId = await repo.findLiveOccupancyAuthorityId(tx, {
      tenantCompanyId: lineage.tenantCompanyId,
      buildingId: lineage.buildingId,
      at: input.at,
    });
    if (!occupancyAuthorityId) throw refuse('OCCUPANCY_MISSING', input);
  }

  if (input.requireBasis && lineage.spaceId) {
    spaceAuthorityId = await repo.findLiveSpaceAuthorityId(tx, {
      tenantCompanyId: lineage.tenantCompanyId,
      buildingId: lineage.buildingId,
      spaceId: lineage.spaceId,
      at: input.at,
    });
    if (!spaceAuthorityId) throw refuse('SPACE_AUTHORITY_MISSING', input);
  }

  return { quotation, lineage, occupancyAuthorityId, spaceAuthorityId };
}

/** B1/B2/MC1'/R-1.2 — the refusals only a BIND has to answer. */
async function assertPicBindable(
  tx: BindingExecutor,
  context: Awaited<ReturnType<typeof resolveBindingContext>>,
  input: {
    quotationId: string;
    actorUserId: string;
    tenantPicId: string;
  },
): Promise<void> {
  const pic = await repo.findTenantPicFacts(tx, input.tenantPicId);
  if (!pic) throw refuse('PIC_NOT_FOUND', input);
  // B1 + B2 in ONE answer: "no such PIC", "another tenant's PIC" and "PIC not
  // ACTIVE" are indistinguishable by design (A01 §9 uniform 404).
  if (
    pic.status !== 'ACTIVE' ||
    pic.tenantCompanyId !== context.lineage.tenantCompanyId
  ) {
    throw refuse('PIC_INELIGIBLE', input);
  }
  // MC1' (granter side): no self-binding through a PIC link.
  if (pic.userId && pic.userId === input.actorUserId) {
    throw bindingSelfAuthorityError();
  }
  // R-1.2: a binding may never contradict the BM-attested lineage PIC.
  if (
    context.lineage.requestTenantPicId &&
    context.lineage.requestTenantPicId !== input.tenantPicId
  ) {
    throw bindingLineageConflictError();
  }
}

/**
 * Grant (or re-grant) the approval authority of one quotation thread.
 *
 * Re-binding an already-bound thread is legal only while no version of the
 * thread is ISSUED-and-undecided (B13) and the thread carries no decision
 * (B18): the prior ACTIVE row is revoked and a `max + 1` row naming it as
 * `supersedes` is inserted in the SAME transaction (B14) — never an UPDATE in
 * place, never two ACTIVE rows.
 */
export async function bindHandymanQuotationApprovalBinding(
  input: BindHandymanQuotationApprovalBindingInput,
  actorUserId: string,
): Promise<{
  status: number;
  data: HandymanQuotationApprovalBindingWriteData;
}> {
  assertUuid(input.quotationId, 'quotationId');
  assertUuid(input.tenantPicId, 'tenantPicId');
  const actor = assertActor(actorUserId);
  const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
  const effectiveUntil = parseWindow(
    input.effectiveUntil ?? null,
    'effectiveUntil',
  );
  const note = boundedNarrative(input.note ?? null, 'note', false);

  const requestFingerprint = computeRequestFingerprint({
    quotationId: input.quotationId,
    tenantPicId: input.tenantPicId,
    effectiveUntil: iso(effectiveUntil),
    note,
  });

  const executed = await executeIdempotent({
    actorUserId: actor,
    operationKey: BIND_HANDYMAN_QUOTATION_APPROVAL_BINDING_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) => {
      const at = new Date();
      if (effectiveUntil && effectiveUntil.getTime() <= at.getTime()) {
        throw bindingWindowInvalidError('effectiveUntil');
      }
      const context = await resolveBindingContext(client, {
        quotationId: input.quotationId,
        actorUserId: actor,
        at,
        requireBasis: true,
      });
      await assertPicBindable(client, context, {
        quotationId: input.quotationId,
        actorUserId: actor,
        tenantPicId: input.tenantPicId,
      });

      if (await repo.hasAnyDecision(client, input.quotationId)) {
        throw bindingFrozenByDecisionError();
      }

      const active = await repo.findActiveBinding(client, input.quotationId, {
        forUpdate: true,
      });
      if (active && active.tenantPicId === input.tenantPicId) {
        // The authority is already exactly what is being asked for: return the
        // live row and mint no new version (B14). This is not the idempotency
        // replay path — the substrate covers same-key replays; this covers a
        // new key that restates the current state.
        return {
          responseStatus: 201,
          responseBody: {
            binding: toPublicBinding(active),
            alreadyBound: true,
          },
        };
      }
      if (active && (await repo.hasIssuedUndecidedVersion(client, input.quotationId))) {
        // B13 pin: never swap the entitled approver under a live presentation.
        throw bindingPinnedError();
      }

      // A bind path that reached here has a live occupancy row: the read is
      // defensive, not a second opinion — `null` means the basis moved between
      // the check and the write, and the transaction must not proceed.
      const occupancyAuthorityId = context.occupancyAuthorityId;
      if (!occupancyAuthorityId) {
        throw refuse('OCCUPANCY_MISSING', {
          quotationId: input.quotationId,
          actorUserId: actor,
        });
      }

      // B14 order matters and the ledger enforces it: a superseding row may
      // only name the thread's highest row AFTER that row is REVOKED, which is
      // why the revoke below precedes the INSERT in the same transaction —
      // never an UPDATE in place, and never two ACTIVE rows.
      const head = await repo.findBindingHead(client, input.quotationId);
      if (active) {
        const revoked = await revokeUnderGuard(client, active.id, actor);
        if (!revoked) throw bindingPinnedError();
      }
      const record = await insertUnderGuard(client, {
        quotationId: context.quotation.id,
        handymanRequestId: context.lineage.requestId,
        clientId: context.lineage.clientId,
        tenantCompanyId: context.lineage.tenantCompanyId,
        buildingId: context.lineage.buildingId,
        spaceId: context.lineage.spaceId,
        tenantPicId: input.tenantPicId,
        bindingVersion: (head?.bindingVersion ?? 0) + 1,
        supersedesBindingId: head ? head.id : null,
        effectiveFrom: at,
        effectiveUntil,
        occupancyAuthorityId,
        spaceAuthorityId: context.spaceAuthorityId,
        grantedByUserId: actor,
      });

      await recordOperationalEvent(
        {
          clientId: record.clientId,
          eventType: 'HANDYMAN_QUOTATION_APPROVAL_BOUND',
          entityType: 'HANDYMAN_QUOTATION_APPROVAL_BINDING',
          entityId: record.id,
          actorUserId: actor,
          buildingId: record.buildingId,
          summary: `Handyman quotation approval authority bound (version ${record.bindingVersion}).`,
          // Identities + window + the operator narrative. No PIC name, e-mail
          // or phone: the ledger keeps ids, so does the journal.
          metadata: {
            quotationId: record.quotationId,
            handymanRequestId: record.handymanRequestId,
            tenantCompanyId: record.tenantCompanyId,
            buildingId: record.buildingId,
            spaceId: record.spaceId,
            tenantPicId: record.tenantPicId,
            bindingId: record.id,
            bindingVersion: record.bindingVersion,
            supersedesBindingId: record.supersedesBindingId,
            effectiveFrom: record.effectiveFrom.toISOString(),
            effectiveUntil: iso(record.effectiveUntil),
            note,
          },
        },
        client,
      );

      return {
        responseStatus: 201,
        responseBody: {
          binding: toPublicBinding(record),
          alreadyBound: false,
        },
      };
    },
  });

  const data = (executed.responseBody ?? {}) as Omit<
    HandymanQuotationApprovalBindingWriteData,
    'replayed'
  >;
  return {
    status: executed.responseStatus,
    data: {
      binding: data.binding,
      alreadyBound: data.alreadyBound,
      replayed: executed.replayed,
    },
  };
}

/**
 * Revoke the thread's live binding. Always permitted up to the B18 freeze
 * (B15 — safety outranks the B13 pin, and revocation is the one mutation the
 * guard allows), and idempotent in effect: a thread whose newest row is already
 * REVOKED returns that row and writes nothing; a never-bound thread answers
 * the uniform 404.
 */
export async function revokeHandymanQuotationApprovalBinding(
  input: RevokeHandymanQuotationApprovalBindingInput,
  actorUserId: string,
): Promise<{
  status: number;
  data: HandymanQuotationApprovalBindingWriteData;
}> {
  assertUuid(input.quotationId, 'quotationId');
  const actor = assertActor(actorUserId);
  const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
  const reason = boundedNarrative(input.reason, 'reason', true);
  const effectiveUntil = parseWindow(
    input.effectiveUntil ?? null,
    'effectiveUntil',
  );

  const requestFingerprint = computeRequestFingerprint({
    quotationId: input.quotationId,
    reason,
    effectiveUntil: iso(effectiveUntil),
  });

  const executed = await executeIdempotent({
    actorUserId: actor,
    operationKey: REVOKE_HANDYMAN_QUOTATION_APPROVAL_BINDING_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) => {
      const at = new Date();
      // B15: no B3/B4/B5 basis is demanded of a revocation — only the caller's
      // own authority wall, which the route + BE-02G already enforce.
      await resolveBindingContext(client, {
        quotationId: input.quotationId,
        actorUserId: actor,
        at,
        requireBasis: false,
      });
      const active = await repo.findActiveBinding(client, input.quotationId, {
        forUpdate: true,
      });
      if (!active) {
        const head = await repo.findBindingHead(client, input.quotationId);
        if (!head) throw bindingTargetUnavailableError();
        return {
          responseStatus: 200,
          responseBody: {
            binding: toPublicBinding(head),
            alreadyRevoked: true,
          },
        };
      }
      if (await repo.hasAnyDecision(client, input.quotationId)) {
        throw bindingFrozenByDecisionError();
      }
      // A stated cutoff may only TIGHTEN: never in the future, never before
      // the binding began. It is journal-recorded; the ledger's `revoked_at`
      // stays the authoritative instant because 0437's revoke-only UPDATE
      // permits no window edit (B14/B15).
      if (
        effectiveUntil &&
        (effectiveUntil.getTime() > at.getTime() ||
          effectiveUntil.getTime() < active.effectiveFrom.getTime())
      ) {
        throw bindingWindowInvalidError('effectiveUntil');
      }

      const revoked = await revokeUnderGuard(client, active.id, actor);
      if (!revoked) {
        // The row was locked FOR UPDATE above, so this is unreachable except
        // through a concurrent transition that already completed; 409 tells the
        // caller to reload rather than pretending the target does not exist.
        throw bindingConcurrentWriteError();
      }

      await recordOperationalEvent(
        {
          clientId: revoked.clientId,
          eventType: 'HANDYMAN_QUOTATION_APPROVAL_BINDING_REVOKED',
          entityType: 'HANDYMAN_QUOTATION_APPROVAL_BINDING',
          entityId: revoked.id,
          actorUserId: actor,
          buildingId: revoked.buildingId,
          summary: `Handyman quotation approval authority revoked (version ${revoked.bindingVersion}).`,
          metadata: {
            quotationId: revoked.quotationId,
            handymanRequestId: revoked.handymanRequestId,
            tenantCompanyId: revoked.tenantCompanyId,
            bindingId: revoked.id,
            bindingVersion: revoked.bindingVersion,
            tenantPicId: revoked.tenantPicId,
            revokedAt: iso(revoked.revokedAt),
            // Tighten-only statement of intent; authority ended at `revokedAt`.
            statedEffectiveUntil: iso(effectiveUntil),
            reason,
          },
        },
        client,
      );

      return {
        responseStatus: 200,
        responseBody: {
          binding: toPublicBinding(revoked),
          alreadyRevoked: false,
        },
      };
    },
  });

  const data = (executed.responseBody ?? {}) as Omit<
    HandymanQuotationApprovalBindingWriteData,
    'replayed'
  >;
  return {
    status: executed.responseStatus,
    data: {
      binding: data.binding,
      alreadyRevoked: data.alreadyRevoked,
      replayed: executed.replayed,
    },
  };
}

/**
 * Bounded staff read of the same fact (C21): ids, status, window, granter id —
 * never a PIC name. `approvalStatus` is RE-RESOLVED live (B16/B17): the
 * snapshotted `occupancy_authority_id` / `space_authority_id` are evidence of
 * what justified the binding, so their current state is looked up on every
 * call rather than trusted as authority.
 */
export async function getHandymanQuotationApprovalBinding(input: {
  quotationId: string;
  actorUserId: string;
}): Promise<PublicHandymanQuotationApprovalBindingRead> {
  const quotationId = assertUuid(input.quotationId, 'quotationId');
  const actorUserId = assertActor(input.actorUserId);

  return withTransaction(async (tx) => {
    const quotation = await handymanQuotationRepository.findQuotationById(
      tx,
      quotationId,
    );
    if (!quotation) throw bindingTargetUnavailableError();
    const lineage = await repo.findThreadLineage(tx, quotation.handymanRequestId);
    if (!lineage) throw bindingTargetUnavailableError();
    // Same wall as the write path (BE-02G over the thread's own Building).
    await assertQuotationThreadBuildingAccess(tx as never, quotation, actorUserId);

    const active = await repo.findActiveBinding(tx, quotationId);
    const current = active ?? (await repo.findBindingHead(tx, quotationId));
    const at = new Date();

    let occupancyStatus: PublicHandymanQuotationApprovalStatus['occupancyStatus'] =
      'MISSING';
    let spaceStatus: PublicHandymanQuotationApprovalStatus['spaceStatus'] =
      lineage.spaceId ? 'MISSING' : 'NOT_APPLICABLE';
    let pic: Awaited<ReturnType<typeof repo.findTenantPicFacts>> = null;
    if (current) {
      occupancyStatus = await repo.readAuthorityStatus(tx, {
        table: 'tenant_building_contexts',
        authorityId: current.occupancyAuthorityId,
        tenantCompanyId: lineage.tenantCompanyId,
        buildingId: lineage.buildingId,
        at,
      });
      if (current.spaceAuthorityId) {
        spaceStatus = await repo.readAuthorityStatus(tx, {
          table: 'tenant_space_relationships',
          authorityId: current.spaceAuthorityId,
          tenantCompanyId: lineage.tenantCompanyId,
          buildingId: lineage.buildingId,
          at,
        });
      }
      pic = await repo.findTenantPicFacts(tx, current.tenantPicId);
    }
    const pinned = await repo.hasIssuedUndecidedVersion(tx, quotationId);
    const frozen = await repo.hasAnyDecision(tx, quotationId);
    const history = await repo.listBindingHistory(tx, quotationId, HISTORY_LIMIT);

    const windowCoversNow =
      !!current &&
      current.effectiveFrom.getTime() <= at.getTime() &&
      (!current.effectiveUntil ||
        current.effectiveUntil.getTime() >= at.getTime());
    const picLive =
      !!current &&
      !!pic &&
      pic.status === 'ACTIVE' &&
      pic.tenantCompanyId === lineage.tenantCompanyId;

    return {
      quotationId,
      binding: current ? toPublicBinding(current) : null,
      approvalStatus: {
        bindingStatus: current ? current.status : 'NONE',
        bindingId: current?.id ?? null,
        bindingVersion: current?.bindingVersion ?? null,
        tenantPicId: current?.tenantPicId ?? null,
        grantedAt: iso(current?.grantedAt),
        effectiveFrom: iso(current?.effectiveFrom),
        effectiveUntil: iso(current?.effectiveUntil),
        occupancyStatus: current ? occupancyStatus : 'MISSING',
        spaceStatus: current ? spaceStatus : spaceStatus,
        // One live answer for "gone", "closed", "other tenant": the read must
        // not enumerate a PIC the caller may not address.
        picStatus: picLive ? 'ACTIVE' : 'MISSING',
        pinned,
        frozen,
        // B16's exact conjunction, computed live — the same predicate 03C's
        // decision path will re-evaluate at decision time.
        eligibleForApproval:
          !!current &&
          current.status === 'ACTIVE' &&
          windowCoversNow &&
          occupancyStatus === 'ACTIVE' &&
          (spaceStatus === 'ACTIVE' || spaceStatus === 'NOT_APPLICABLE') &&
          picLive &&
          !frozen,
      },
      history: history.map((record) => ({
        id: record.id,
        bindingVersion: record.bindingVersion,
        status: record.status,
        tenantPicId: record.tenantPicId,
        grantedAt: record.grantedAt.toISOString(),
        revokedAt: iso(record.revokedAt),
      })),
    };
  });
}
