import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { canAccessBuildingScopedResource } from '../context-access';
import { handymanExecutionScopeNotFoundError }
  from '../handyman-quotations';
import { handymanScopeAssignmentRepository }
  from '../handyman-scope-assignments';
import { handymanServiceWarrantyClaimRepository }
  from '../handyman-service-warranty-claims';
import type { HandymanServiceWarrantyClaimRecord }
  from '../handyman-service-warranty-claims';
import {
  handymanServiceWarrantyNotFoundError,
  handymanServiceWarrantyRepository,
} from '../handyman-service-warranties';
import type { HandymanServiceWarrantyRecord }
  from '../handyman-service-warranties';
import {
  handymanChargeableAdditionalWorkConflictError,
  handymanChargeableAdditionalWorkIllegalTransitionError,
  handymanChargeableAdditionalWorkNotAuthorizedError,
  handymanChargeableAdditionalWorkNotFoundError,
  handymanChargeableAdditionalWorkNotEligibleError,
  handymanChargeableAdditionalWorkValidationError,
} from './handyman-chargeable-additional-work.errors';
import {
  assertHandymanChargeableAdditionalWorkFreeReworkSeparated,
  assertHandymanChargeableAdditionalWorkIntakeEligible,
  nextHandymanChargeableAdditionalWorkHeadStatus,
  nextHandymanChargeableAdditionalWorkStatus,
} from './handyman-chargeable-additional-work.lifecycle';
import { handymanChargeableAdditionalWorkRepository }
  from './handyman-chargeable-additional-work.repository';
import type {
  HandymanChargeableAdditionalWorkCommandResult,
  HandymanChargeableAdditionalWorkDecisionInput,
  HandymanChargeableAdditionalWorkRecord,
  HandymanChargeablePaymentTriggerFact,
  ProposeHandymanChargeableAdditionalWorkInput,
} from './handyman-chargeable-additional-work.types';

/**
 * CR-HM-15 PART 04 — chargeable additional-work separation, PROPOSE /
 * ACCEPT / REJECT ONLY (FROZEN governance
 * `CR-HM-15_START_GOVERNANCE.md` §4/§5/§6/§8, §8 row 04, blocker B8).
 *
 * The chargeable path is a SEPARATE record family for an APPROVED claim
 * (free scope not taken) or a REJECTED claim ("chargeable path
 * available"). It binds to the claim and, through it, to the service
 * warranty and ORIGINAL execution scope — client, warranty, scope and
 * BAST are read from the claim row inside the write transaction and are
 * never supplied by the caller. The original claim, warranty, BAST and
 * free-rework rows are READ-ONLY here and their history is preserved.
 *
 * The free rework can never be converted into chargeable work: a referral
 * is refused while a free rework is authorized, in progress, complete or
 * verified, and — symmetrically — the free rework of a claim can never
 * leave REWORK_DRAFT once a chargeable referral exists (SQL firewall in
 * migration 0422). The two paths are mutually exclusive per claim.
 *
 * Acceptance emits the separation fact + the CR-HM-13 payment trigger
 * fact. NO amount, price, currency, ledger, payment, settlement or
 * entitlement is ever computed or stored here, the warranty HEAD is never
 * mutated by this module, and there is no FM/SaaS coupling and no HTTP.
 */

const NOTE_MAX = 2000;

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw handymanChargeableAdditionalWorkValidationError(field);
  }
  return raw;
}

function ensureKey(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 200) {
    throw handymanChargeableAdditionalWorkValidationError('idempotencyKey');
  }
  return raw;
}

function ensureNote(value: string | null | undefined, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length > NOTE_MAX) {
    throw handymanChargeableAdditionalWorkValidationError(field);
  }
  return raw;
}

/**
 * CR-HM-SEC-01 PART 06D-4B — the chargeable commands' access wall
 * (audited READ-ONLY in PART 06D-4A): the BE-02G exact-Building
 * check on the authoritative server-derived scope building
 * (migration 0395), resolved through the claim's ORIGINAL execution
 * scope (the claim — and the work — carry the warranty's scope),
 * replacing the client-level canAccessClient shortcut: a same-Client
 * sibling Building assignment must not run any chargeable command.
 * Fail-closed on a missing scope. The module's denial vocabulary
 * (403 HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_AUTHORIZED) is
 * unchanged, and the wall stays in its original authorization
 * position (after the resource 404, before replay/mutation; the
 * in-transaction re-proof keeps its slot too).
 */
async function assertChargeableAuthority(
  actorUserId: string,
  executionScopeId: string,
): Promise<void> {
  const scope = await handymanScopeAssignmentRepository.findScopeById(
    undefined,
    executionScopeId,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  if (!(await canAccessBuildingScopedResource(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  }))) {
    throw handymanChargeableAdditionalWorkNotAuthorizedError();
  }
}

/**
 * Locks and re-proves the parent claim and warranty inside the write
 * transaction, together with the actor's client authority. Both rows stay
 * READ-ONLY: the head is never written by this module.
 */
async function lockClaimAndWarranty(
  client: Pick<PoolClient, 'query'>,
  claimId: string,
  warrantyId: string,
  actorUserId: string,
): Promise<{
  claim: HandymanServiceWarrantyClaimRecord;
  warranty: HandymanServiceWarrantyRecord;
}> {
  const claim = await handymanServiceWarrantyClaimRepository.findClaimById(
    client,
    claimId,
  );
  if (!claim) {
    throw handymanChargeableAdditionalWorkNotEligibleError(
      `claim-not-found=${claimId}`,
    );
  }
  await assertChargeableAuthority(actorUserId, claim.executionScopeId);
  const warranty = await handymanServiceWarrantyRepository.findWarrantyById(
    client,
    warrantyId,
    true,
  );
  if (!warranty) throw handymanServiceWarrantyNotFoundError();
  return { claim, warranty };
}

/**
 * PROPOSE: create the SINGLE separated chargeable referral of a claim as
 * CHARGEABLE_PROPOSED. The warranty head is not touched — a proposal is
 * not an authorization, not a warranty state and not a money state.
 * Replay of the SAME key returns the SAME referral; a NEW key once a
 * referral exists is a bounded 409.
 */
export async function proposeHandymanChargeableAdditionalWork(
  actorUserId: string,
  input: ProposeHandymanChargeableAdditionalWorkInput,
): Promise<HandymanChargeableAdditionalWorkCommandResult> {
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const claimUuid = ensureUuid(input.claimId, 'claimId');
  const key = ensureKey(input.idempotencyKey);
  const scopeNote = ensureNote(input.scopeNote, 'scopeNote');

  const claim = await handymanServiceWarrantyClaimRepository.findClaimById(
    getPool(),
    claimUuid,
  );
  if (!claim) {
    throw handymanChargeableAdditionalWorkNotEligibleError(
      `claim-not-found=${claimUuid}`,
    );
  }
  await assertChargeableAuthority(actorUuid, claim.executionScopeId);

  return withTransaction(async (client) => {
    const locked = await lockClaimAndWarranty(
      client,
      claimUuid,
      claim.warrantyId,
      actorUuid,
    );
    const replay = await handymanChargeableAdditionalWorkRepository
      .findWorkEventByClaimIdempotency(client, claimUuid, 'PROPOSE', key);
    if (replay) {
      const work = await handymanChargeableAdditionalWorkRepository
        .findWorkById(client, replay.workId);
      if (!work) throw handymanChargeableAdditionalWorkNotFoundError();
      const paymentTrigger = work.paymentTriggerEmittedAt
        ? await handymanChargeableAdditionalWorkRepository
          .findPaymentTriggerEventForWork(client, work.id)
        : null;
      return {
        work,
        event: replay,
        paymentTrigger,
        warrantyStatus: locked.warranty.status,
        claimStatus: locked.claim.status,
        replayed: true,
      };
    }
    assertHandymanChargeableAdditionalWorkIntakeEligible(
      locked.claim.status,
      locked.warranty.status,
    );
    // BLOCKER B8: the free rework family is consulted READ-ONLY and a
    // free rework that was accepted or executed can never become
    // chargeable additional work.
    const freeReworkStatus = await handymanChargeableAdditionalWorkRepository
      .findFreeReworkStatusForClaim(client, claimUuid);
    assertHandymanChargeableAdditionalWorkFreeReworkSeparated(
      freeReworkStatus,
    );
    const existing = await handymanChargeableAdditionalWorkRepository
      .findWorkByClaimId(client, claimUuid);
    if (existing) {
      throw handymanChargeableAdditionalWorkConflictError(
        `chargeable-work-exists=${existing.id}`,
      );
    }
    const work = await handymanChargeableAdditionalWorkRepository.createWork(
      client,
      {
        claimId: claimUuid,
        scopeNote,
        proposedByUserId: actorUuid,
      },
    );
    const event = await handymanChargeableAdditionalWorkRepository
      .insertWorkEvent(client, {
        clientId: work.clientId,
        workId: work.id,
        claimId: work.claimId,
        warrantyId: work.warrantyId,
        executionScopeId: work.executionScopeId,
        bastId: work.bastId,
        eventType: 'PROPOSE',
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    return {
      work,
      event,
      paymentTrigger: null,
      warrantyStatus: locked.warranty.status,
      claimStatus: locked.claim.status,
      replayed: false,
    };
  });
}

type ChargeableDecision = 'ACCEPT' | 'REJECT';

/**
 * Applies ONE customer decision to a proposed chargeable referral. ACCEPT
 * authorizes the separated chargeable scope, appends the CR-HM-13 payment
 * trigger fact in the same transaction and stamps the trigger instant;
 * REJECT closes the referral with no trigger. The warranty head is
 * asserted UNCHANGED (it is not a chargeable or billing state).
 */
async function applyChargeableDecision(
  actorUserId: string,
  input: HandymanChargeableAdditionalWorkDecisionInput,
  action: ChargeableDecision,
): Promise<HandymanChargeableAdditionalWorkCommandResult> {
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const workUuid = ensureUuid(input.workId, 'workId');
  const key = ensureKey(input.idempotencyKey);

  return withTransaction(async (client) => {
    const work = await handymanChargeableAdditionalWorkRepository.findWorkById(
      client,
      workUuid,
      true,
    );
    if (!work) throw handymanChargeableAdditionalWorkNotFoundError();
    const locked = await lockClaimAndWarranty(
      client,
      work.claimId,
      work.warrantyId,
      actorUuid,
    );
    const replay = await handymanChargeableAdditionalWorkRepository
      .findWorkEventByIdempotency(client, work.id, action, key);
    if (replay) {
      const paymentTrigger = await handymanChargeableAdditionalWorkRepository
        .findPaymentTriggerEventForWork(client, work.id);
      const current = await handymanChargeableAdditionalWorkRepository
        .findWorkById(client, work.id);
      if (!current) throw handymanChargeableAdditionalWorkNotFoundError();
      return {
        work: current,
        event: replay,
        paymentTrigger,
        warrantyStatus: locked.warranty.status,
        claimStatus: locked.claim.status,
        replayed: true,
      };
    }
    // The claim/warranty pair is re-proved: nothing can have moved the
    // claim or the head under a live referral.
    assertHandymanChargeableAdditionalWorkIntakeEligible(
      locked.claim.status,
      locked.warranty.status,
    );
    if (work.status !== 'CHARGEABLE_PROPOSED') {
      throw handymanChargeableAdditionalWorkIllegalTransitionError(
        work.status,
        action,
      );
    }
    const status = nextHandymanChargeableAdditionalWorkStatus(
      work.status,
      action,
    );
    // The head is asserted EXACTLY unchanged: a chargeable decision is
    // never a warranty state (financial execution stays downstream).
    const headAfter = nextHandymanChargeableAdditionalWorkHeadStatus(
      locked.warranty.status,
      action,
    );
    if (headAfter !== locked.warranty.status) {
      throw handymanChargeableAdditionalWorkIllegalTransitionError(
        locked.warranty.status,
        action,
      );
    }
    const decided = await handymanChargeableAdditionalWorkRepository
      .updateWorkDecision(client, work.id, status, actorUuid);
    const event = await handymanChargeableAdditionalWorkRepository
      .insertWorkEvent(client, {
        clientId: decided.clientId,
        workId: decided.id,
        claimId: decided.claimId,
        warrantyId: decided.warrantyId,
        executionScopeId: decided.executionScopeId,
        bastId: decided.bastId,
        eventType: action,
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    let paymentTrigger = null;
    if (action === 'ACCEPT') {
      paymentTrigger = await handymanChargeableAdditionalWorkRepository
        .insertWorkEvent(client, {
          clientId: decided.clientId,
          workId: decided.id,
          claimId: decided.claimId,
          warrantyId: decided.warrantyId,
          executionScopeId: decided.executionScopeId,
          bastId: decided.bastId,
          eventType: 'PAYMENT_TRIGGER',
          idempotencyKey: key,
          actorUserId: actorUuid,
        });
    }
    return {
      work: decided,
      event,
      paymentTrigger,
      warrantyStatus: locked.warranty.status,
      claimStatus: locked.claim.status,
      replayed: false,
    };
  });
}

/** Customer-side ACCEPT: authorize the separated chargeable scope. */
export async function acceptHandymanChargeableAdditionalWork(
  actorUserId: string,
  input: HandymanChargeableAdditionalWorkDecisionInput,
): Promise<HandymanChargeableAdditionalWorkCommandResult> {
  return applyChargeableDecision(actorUserId, input, 'ACCEPT');
}

/** Customer-side REJECT: close the referral with no chargeable work. */
export async function rejectHandymanChargeableAdditionalWork(
  actorUserId: string,
  input: HandymanChargeableAdditionalWorkDecisionInput,
): Promise<HandymanChargeableAdditionalWorkCommandResult> {
  return applyChargeableDecision(actorUserId, input, 'REJECT');
}

export async function getHandymanChargeableAdditionalWorkById(
  workIdRaw: string,
): Promise<HandymanChargeableAdditionalWorkRecord> {
  const workId = ensureUuid(workIdRaw, 'workId');
  const work = await handymanChargeableAdditionalWorkRepository.findWorkById(
    getPool(),
    workId,
  );
  if (!work) throw handymanChargeableAdditionalWorkNotFoundError();
  return work;
}

export async function findHandymanChargeableAdditionalWorkByClaimId(
  claimIdRaw: string,
): Promise<HandymanChargeableAdditionalWorkRecord | null> {
  const claimId = ensureUuid(claimIdRaw, 'claimId');
  return handymanChargeableAdditionalWorkRepository.findWorkByClaimId(
    getPool(),
    claimId,
  );
}

export async function listHandymanChargeableAdditionalWorks(
  warrantyIdRaw: string,
): Promise<HandymanChargeableAdditionalWorkRecord[]> {
  const warrantyId = ensureUuid(warrantyIdRaw, 'warrantyId');
  return handymanChargeableAdditionalWorkRepository.listWorksByWarrantyId(
    getPool(),
    warrantyId,
  );
}

/**
 * The outbound CR-HM-13 seam, READ-ONLY: the emitted payment trigger fact
 * of an authorized chargeable scope, or null when the scope was never
 * authorized. CR-HM-13 owns pricing, ledger, payment and settlement.
 */
export async function getHandymanChargeablePaymentTrigger(
  workIdRaw: string,
): Promise<HandymanChargeablePaymentTriggerFact | null> {
  const workId = ensureUuid(workIdRaw, 'workId');
  const work = await handymanChargeableAdditionalWorkRepository.findWorkById(
    getPool(),
    workId,
  );
  if (!work) throw handymanChargeableAdditionalWorkNotFoundError();
  return handymanChargeableAdditionalWorkRepository.findPaymentTriggerForWork(
    getPool(),
    workId,
  );
}
