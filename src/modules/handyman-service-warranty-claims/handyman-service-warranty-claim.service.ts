import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { canAccessBuildingScopedResource } from '../context-access';
import { handymanExecutionScopeNotFoundError }
  from '../handyman-quotations';
import { handymanScopeAssignmentRepository }
  from '../handyman-scope-assignments';
import {
  handymanServiceWarrantyNotFoundError,
  handymanServiceWarrantyRepository,
} from '../handyman-service-warranties';
import type { HandymanServiceWarrantyRecord }
  from '../handyman-service-warranties';
import {
  handymanServiceWarrantyClaimConflictError,
  handymanServiceWarrantyClaimEvidenceInvalidError,
  handymanServiceWarrantyClaimEvidenceRequiredError,
  handymanServiceWarrantyClaimNotAuthorizedError,
  handymanServiceWarrantyClaimNotFoundError,
  handymanServiceWarrantyClaimValidationError,
} from './handyman-service-warranty-claim.errors';
import {
  assertHandymanServiceWarrantyClaimIntakeEligible,
  nextHandymanServiceWarrantyClaimHeadStatus,
  nextHandymanServiceWarrantyClaimStatus,
} from './handyman-service-warranty-claim.lifecycle';
import { handymanServiceWarrantyClaimRepository }
  from './handyman-service-warranty-claim.repository';
import type {
  DecideHandymanServiceWarrantyClaimInput,
  HandymanServiceWarrantyClaimCommandResult,
  OpenHandymanServiceWarrantyClaimInput,
  SubmitHandymanServiceWarrantyClaimInput,
  WithdrawHandymanServiceWarrantyClaimInput,
} from './handyman-service-warranty-claim.types';

/**
 * CR-HM-15 PART 02 — CLAIM INTAKE / SUBMIT / DECIDE / WITHDRAW ONLY
 * (FROZEN governance `CR-HM-15_START_GOVERNANCE.md` §4/§5/§6/§8,
 * §8 row 02).
 *
 * A claim binds to an EXISTING service warranty on its ORIGINAL execution
 * scope: the scope, client and BAST anchors are read from the warranty
 * row inside the write transaction, never supplied by the caller. Intake
 * is gated on the ACTIVE warranty state, and at most one non-terminal
 * claim exists per warranty.
 *
 * Every command is one transaction + row lock + single-use idempotency
 * key, and the warranty HEAD moves only through the warranty module's own
 * writer (one code path for `handyman_service_warranties`), mirroring the
 * claim record — the head can never contradict the claim facts.
 *
 * ZERO rework execution (PART 03), ZERO chargeable additional-work
 * separation (PART 04), ZERO pricing/payment/settlement/entitlement,
 * ZERO FM/SaaS, ZERO HTTP. The original BAST, session, QC, evidence and
 * quotation history is READ-ONLY here.
 */

const NOTE_MAX = 2000;

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw handymanServiceWarrantyClaimValidationError(field);
  }
  return raw;
}

function ensureKey(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 200) {
    throw handymanServiceWarrantyClaimValidationError('idempotencyKey');
  }
  return raw;
}

function ensureNote(value: string | null | undefined, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length > NOTE_MAX) {
    throw handymanServiceWarrantyClaimValidationError(field);
  }
  return raw;
}

function ensureRequiredNote(
  value: string | null | undefined,
  field: string,
): string {
  const raw = ensureNote(value, field);
  if (raw.length === 0) {
    throw handymanServiceWarrantyClaimValidationError(field);
  }
  return raw;
}

function ensureOptionalUuid(
  value: string | null | undefined,
  field: string,
): string | null {
  if (value === null || value === undefined || value === '') return null;
  return ensureUuid(value, field);
}

/**
 * CR-HM-SEC-01 PART 06D-2 — the claim commands' access wall: the
 * BE-02G exact-Building check on the authoritative server-derived
 * scope building (migration 0395), resolved through the claim's /
 * warranty's ORIGINAL execution scope (the claim inherits it from its
 * warranty at creation), replacing the client-level canAccessClient
 * shortcut: a same-Client sibling Building assignment must not run
 * any claim command. The module's denial vocabulary (403
 * HANDYMAN_SERVICE_WARRANTY_CLAIM_NOT_AUTHORIZED) is unchanged, and
 * the wall stays in its original authorization position (after the
 * resource 404, before replay/mutation).
 */
async function assertClaimAuthority(
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
    throw handymanServiceWarrantyClaimNotAuthorizedError();
  }
}

/**
 * The bound evidence must be the claim's OWN: an evidence record of the
 * same client and ORIGINAL execution scope. The database re-proves it.
 */
async function assertEvidenceBelongs(
  executor: Pick<PoolClient, 'query'>,
  evidenceRecordId: string,
  clientId: string,
  executionScopeId: string,
): Promise<void> {
  const evidence = await handymanServiceWarrantyClaimRepository
    .findEvidenceScope(executor, evidenceRecordId);
  if (!evidence) {
    throw handymanServiceWarrantyClaimEvidenceInvalidError(
      `evidence-not-found=${evidenceRecordId}`,
    );
  }
  if (evidence.clientId !== clientId
    || evidence.executionScopeId !== executionScopeId) {
    throw handymanServiceWarrantyClaimEvidenceInvalidError(
      `evidence-scope-mismatch=${evidenceRecordId}`,
    );
  }
}

/**
 * Loads the parent warranty INSIDE the write transaction (row-locked) and
 * re-proves the actor's client authority. The caller never supplies
 * client, scope or BAST identity: they are read from this row.
 */
async function lockWarrantyForClaim(
  client: Pick<PoolClient, 'query'>,
  warrantyId: string,
  actorUserId: string,
): Promise<HandymanServiceWarrantyRecord> {
  const warranty = await handymanServiceWarrantyRepository.findWarrantyById(
    client,
    warrantyId,
    true,
  );
  if (!warranty) throw handymanServiceWarrantyNotFoundError();
  await assertClaimAuthority(actorUserId, warranty.executionScopeId);
  return warranty;
}

/**
 * OPEN: intake of a CLAIM_DRAFT bound to an existing ACTIVE service
 * warranty and its original scope/BAST. The head does not move yet — a
 * draft claim is not a warranty state. Replay of the SAME key returns the
 * SAME claim; a NEW key while another non-terminal claim exists is a
 * bounded 409 (never a second open claim).
 */
export async function openHandymanServiceWarrantyClaim(
  actorUserId: string,
  input: OpenHandymanServiceWarrantyClaimInput,
): Promise<HandymanServiceWarrantyClaimCommandResult> {
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const warrantyUuid = ensureUuid(input.warrantyId, 'warrantyId');
  const key = ensureKey(input.idempotencyKey);
  const claimNote = ensureNote(input.claimNote, 'claimNote');
  const evidenceRecordId = ensureOptionalUuid(
    input.evidenceRecordId,
    'evidenceRecordId',
  );

  const preflight = await handymanServiceWarrantyRepository.findWarrantyById(
    getPool(),
    warrantyUuid,
  );
  if (!preflight) throw handymanServiceWarrantyNotFoundError();
  await assertClaimAuthority(actorUuid, preflight.executionScopeId);
  if (evidenceRecordId) {
    await assertEvidenceBelongs(
      getPool(),
      evidenceRecordId,
      preflight.clientId,
      preflight.executionScopeId,
    );
  }

  return withTransaction(async (client) => {
    const warranty = await lockWarrantyForClaim(client, warrantyUuid, actorUuid);
    assertHandymanServiceWarrantyClaimIntakeEligible(warranty.status);
    const replay = await handymanServiceWarrantyClaimRepository
      .findClaimEventByWarrantyIdempotency(client, warranty.id, 'OPEN', key);
    if (replay) {
      const claim = await handymanServiceWarrantyClaimRepository
        .findClaimById(client, replay.claimId);
      if (!claim) throw handymanServiceWarrantyClaimNotFoundError();
      return {
        claim,
        event: replay,
        warrantyStatus: warranty.status,
        replayed: true,
      };
    }
    const open = await handymanServiceWarrantyClaimRepository
      .findOpenClaimByWarrantyId(client, warranty.id);
    if (open) {
      throw handymanServiceWarrantyClaimConflictError(
        `open-claim-exists=${open.id}`,
      );
    }
    const claim = await handymanServiceWarrantyClaimRepository.createClaim(
      client,
      {
        warrantyId: warranty.id,
        claimNote,
        evidenceRecordId,
        openedByUserId: actorUuid,
      },
    );
    const event = await handymanServiceWarrantyClaimRepository
      .insertClaimEvent(client, {
        clientId: claim.clientId,
        claimId: claim.id,
        warrantyId: claim.warrantyId,
        executionScopeId: claim.executionScopeId,
        bastId: claim.bastId,
        eventType: 'OPEN',
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    return {
      claim,
      event,
      warrantyStatus: warranty.status,
      replayed: false,
    };
  });
}

type ClaimAction = 'SUBMIT' | 'APPROVE' | 'REJECT' | 'WITHDRAW';

/**
 * Applies ONE state-gated claim transition and mirrors it on the warranty
 * head, in one transaction with the claim row locked.
 */
async function applyClaimAction(
  actorUserId: string,
  claimIdRaw: string,
  idempotencyKeyRaw: string,
  action: ClaimAction,
  options: {
    evidenceRecordId?: string | null;
    decisionNote?: string | null;
  },
): Promise<HandymanServiceWarrantyClaimCommandResult> {
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const claimId = ensureUuid(claimIdRaw, 'claimId');
  const key = ensureKey(idempotencyKeyRaw);
  const suppliedEvidence = ensureOptionalUuid(
    options.evidenceRecordId,
    'evidenceRecordId',
  );
  const decisionNote = action === 'REJECT'
    ? ensureRequiredNote(options.decisionNote, 'decisionNote')
    : action === 'APPROVE'
      ? ensureNote(options.decisionNote, 'decisionNote') || null
      : null;

  const existing = await handymanServiceWarrantyClaimRepository.findClaimById(
    getPool(),
    claimId,
  );
  if (!existing) throw handymanServiceWarrantyClaimNotFoundError();
  await assertClaimAuthority(actorUuid, existing.executionScopeId);

  return withTransaction(async (client) => {
    const warranty = await lockWarrantyForClaim(
      client,
      existing.warrantyId,
      actorUuid,
    );
    const claim = await handymanServiceWarrantyClaimRepository.findClaimById(
      client,
      claimId,
      true,
    );
    if (!claim) throw handymanServiceWarrantyClaimNotFoundError();

    const replay = await handymanServiceWarrantyClaimRepository
      .findClaimEventByIdempotency(client, claim.id, action, key);
    if (replay) {
      return {
        claim,
        event: replay,
        warrantyStatus: warranty.status,
        replayed: true,
      };
    }

    const evidenceRecordId = action === 'SUBMIT'
      ? (suppliedEvidence ?? claim.evidenceRecordId)
      : null;
    if (action === 'SUBMIT') {
      if (!evidenceRecordId) {
        throw handymanServiceWarrantyClaimEvidenceRequiredError();
      }
      if (suppliedEvidence) {
        await assertEvidenceBelongs(
          client,
          suppliedEvidence,
          claim.clientId,
          claim.executionScopeId,
        );
      }
    }

    const nextClaimStatus = nextHandymanServiceWarrantyClaimStatus(
      claim.status,
      action,
    );
    const nextHeadStatus = nextHandymanServiceWarrantyClaimHeadStatus(
      warranty.status,
      action,
    );

    const updated = await handymanServiceWarrantyClaimRepository
      .updateClaimStatus(
        client,
        claim.id,
        nextClaimStatus,
        evidenceRecordId,
        actorUuid,
        decisionNote,
      );
    if (nextHeadStatus !== warranty.status) {
      await handymanServiceWarrantyRepository.updateWarrantyStatus(
        client,
        warranty.id,
        nextHeadStatus,
      );
    }
    const event = await handymanServiceWarrantyClaimRepository
      .insertClaimEvent(client, {
        clientId: updated.clientId,
        claimId: updated.id,
        warrantyId: updated.warrantyId,
        executionScopeId: updated.executionScopeId,
        bastId: updated.bastId,
        eventType: action,
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    return {
      claim: updated,
      event,
      warrantyStatus: nextHeadStatus,
      replayed: false,
    };
  });
}

/** SUBMIT: CLAIM_DRAFT -> CLAIM_SUBMITTED (head ACTIVE -> CLAIM_OPEN). */
export async function submitHandymanServiceWarrantyClaim(
  actorUserId: string,
  input: SubmitHandymanServiceWarrantyClaimInput,
): Promise<HandymanServiceWarrantyClaimCommandResult> {
  return applyClaimAction(actorUserId, input.claimId, input.idempotencyKey,
    'SUBMIT', { evidenceRecordId: input.evidenceRecordId });
}

/** APPROVE: CLAIM_SUBMITTED -> CLAIM_APPROVED (head -> CLAIM_APPROVED). */
export async function approveHandymanServiceWarrantyClaim(
  actorUserId: string,
  input: DecideHandymanServiceWarrantyClaimInput,
): Promise<HandymanServiceWarrantyClaimCommandResult> {
  return applyClaimAction(actorUserId, input.claimId, input.idempotencyKey,
    'APPROVE', { decisionNote: input.decisionNote });
}

/** REJECT: CLAIM_SUBMITTED -> CLAIM_REJECTED (head -> CLAIM_REJECTED). */
export async function rejectHandymanServiceWarrantyClaim(
  actorUserId: string,
  input: DecideHandymanServiceWarrantyClaimInput,
): Promise<HandymanServiceWarrantyClaimCommandResult> {
  return applyClaimAction(actorUserId, input.claimId, input.idempotencyKey,
    'REJECT', { decisionNote: input.decisionNote });
}

/** WITHDRAW: CLAIM_SUBMITTED -> CLAIM_WITHDRAWN (head -> ACTIVE). */
export async function withdrawHandymanServiceWarrantyClaim(
  actorUserId: string,
  input: WithdrawHandymanServiceWarrantyClaimInput,
): Promise<HandymanServiceWarrantyClaimCommandResult> {
  return applyClaimAction(actorUserId, input.claimId, input.idempotencyKey,
    'WITHDRAW', {});
}
