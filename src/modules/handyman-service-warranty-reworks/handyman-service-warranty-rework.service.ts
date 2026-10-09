import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { canAccessBuildingScopedResource } from '../context-access';
import { handymanExecutionScopeNotFoundError }
  from '../handyman-quotations';
import {
  handymanScopeAssignmentRepository,
  resolveHandymanAssignmentLead,
} from '../handyman-scope-assignments';
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
  handymanServiceWarrantyReworkConflictError,
  handymanServiceWarrantyReworkEvidenceInvalidError,
  handymanServiceWarrantyReworkEvidenceRequiredError,
  handymanServiceWarrantyReworkNotAuthorizedError,
  handymanServiceWarrantyReworkNotFoundError,
  handymanServiceWarrantyReworkNotEligibleError,
  handymanServiceWarrantyReworkQcInvalidError,
  handymanServiceWarrantyReworkValidationError,
} from './handyman-service-warranty-rework.errors';
import {
  assertHandymanServiceWarrantyReworkIntakeEligible,
  nextHandymanServiceWarrantyReworkHeadStatus,
  nextHandymanServiceWarrantyReworkStatus,
} from './handyman-service-warranty-rework.lifecycle';
import { handymanServiceWarrantyReworkRepository }
  from './handyman-service-warranty-rework.repository';
import type {
  CompleteHandymanServiceWarrantyReworkInput,
  HandymanServiceWarrantyReworkCommandResult,
  HandymanServiceWarrantyReworkRecord,
  HandymanServiceWarrantyReworkTransitionInput,
  ProposeHandymanServiceWarrantyReworkInput,
  VerifyHandymanServiceWarrantyReworkInput,
} from './handyman-service-warranty-rework.types';

/**
 * CR-HM-15 PART 03 — PROPOSE / ACCEPT / START / COMPLETE / VERIFY ONLY
 * (FROZEN governance `CR-HM-15_START_GOVERNANCE.md` §4/§5/§6/§8,
 * §8 row 03).
 *
 * Free warranty rework exists ONLY for an APPROVED claim: the rework
 * binds to that claim and, through it, to the SERVICE WARRANTY and its
 * ORIGINAL execution scope / BAST. Client, warranty, scope and BAST are
 * read from the claim row inside the write transaction — never supplied
 * by the caller.
 *
 * Verification reuses CR-HM-10 authority READ-ONLY: it binds an evidence
 * record of the same client and original execution scope and may consume
 * a QC run of that scope that already PASSED. Neither table is written
 * here, and no ownership transfers.
 *
 * Every command is one transaction + row lock + single-use idempotency
 * key, and the warranty HEAD moves only through the warranty module's own
 * writer, mirroring the rework record.
 *
 * ZERO chargeable additional-work financial execution (PART 04), ZERO
 * pricing/payment/settlement/ledger/entitlement, ZERO FM/SaaS, ZERO HTTP.
 * The original BAST, the warranty start boundary and the service history
 * are READ-ONLY here.
 */

const NOTE_MAX = 2000;

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw handymanServiceWarrantyReworkValidationError(field);
  }
  return raw;
}

function ensureKey(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 200) {
    throw handymanServiceWarrantyReworkValidationError('idempotencyKey');
  }
  return raw;
}

function ensureNote(value: string | null | undefined, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length > NOTE_MAX) {
    throw handymanServiceWarrantyReworkValidationError(field);
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
 * CR-HM-SEC-01 PART 06D-3 — the rework commands' access wall: the
 * BE-02G exact-Building check on the authoritative server-derived
 * scope building (migration 0395), resolved through the
 * rework -> claim/warranty -> executionScope chain (the claim and
 * the rework both carry the warranty's ORIGINAL execution scope),
 * replacing the client-level canAccessClient shortcut: a
 * same-Client sibling Building assignment must not run any rework
 * command. The module's denial vocabulary (403
 * HANDYMAN_SERVICE_WARRANTY_REWORK_NOT_AUTHORIZED) is unchanged, and
 * the wall stays in its original authorization position (after the
 * resource 404, before replay/mutation; the in-transaction re-proof
 * keeps its slot too).
 */
async function assertReworkAuthority(
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
    throw handymanServiceWarrantyReworkNotAuthorizedError();
  }
}

/**
 * CR-HM-SEC-01 PART 07B-2A — CR-HM-04 field-worker ACTION authority
 * (audited in PART 07B-1): the actor must be the scope's CURRENT
 * ACTIVE assignment's authoritative Crew Lead.
 * `resolveHandymanAssignmentLead` re-validates the ACTIVE assignment
 * and its CURRENT Lead validity chain (and re-proves the BE-02G
 * building wall); a Lead that went invalid after assignment, a
 * missing assignment, or a non-Lead actor fails CLOSED with the
 * module's existing 403 vocabulary (HANDYMAN_SERVICE_WARRANTY_REWORK_
 * NOT_AUTHORIZED). Applies ONLY to the field-worker commands
 * (PROPOSE / START / COMPLETE / VERIFY); the customer-side AUTHORIZE
 * keeps building-wall-only authority — its action authority is the
 * customer-side acceptance, not the crew chain.
 */
async function assertReworkLeadAction(
  executionScopeId: string,
  actorUserId: string,
): Promise<void> {
  const resolution = await resolveHandymanAssignmentLead(
    executionScopeId,
    actorUserId,
  );
  if (!resolution || resolution.leadUserId !== actorUserId) {
    throw handymanServiceWarrantyReworkNotAuthorizedError();
  }
}

/**
 * READ-ONLY CR-HM-10 reuse: the verification evidence must be the
 * rework's OWN evidence (same client + ORIGINAL execution scope), and a
 * consumed QC run must belong to that same scope and already have PASSED.
 */
async function assertVerificationSources(
  executor: Pick<PoolClient, 'query'>,
  evidenceRecordId: string,
  qcRunId: string | null,
  clientId: string,
  executionScopeId: string,
): Promise<void> {
  const evidence = await handymanServiceWarrantyReworkRepository
    .findEvidenceScope(executor, evidenceRecordId);
  if (!evidence) {
    throw handymanServiceWarrantyReworkEvidenceInvalidError(
      `evidence-not-found=${evidenceRecordId}`,
    );
  }
  if (evidence.clientId !== clientId
    || evidence.executionScopeId !== executionScopeId) {
    throw handymanServiceWarrantyReworkEvidenceInvalidError(
      `evidence-scope-mismatch=${evidenceRecordId}`,
    );
  }
  if (!qcRunId) return;
  const qc = await handymanServiceWarrantyReworkRepository
    .findQcRunScopeAndStatus(executor, qcRunId);
  if (!qc) {
    throw handymanServiceWarrantyReworkQcInvalidError(
      `qc-run-not-found=${qcRunId}`,
    );
  }
  if (qc.clientId !== clientId || qc.executionScopeId !== executionScopeId) {
    throw handymanServiceWarrantyReworkQcInvalidError(
      `qc-run-scope-mismatch=${qcRunId}`,
    );
  }
  if (qc.status !== 'PASSED') {
    throw handymanServiceWarrantyReworkQcInvalidError(
      `qc-run-not-passed=${qc.status}`,
    );
  }
}

/**
 * Locks and re-proves the parent claim and warranty inside the write
 * transaction, together with the actor's client authority.
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
    throw handymanServiceWarrantyReworkNotEligibleError(
      `claim-not-found=${claimId}`,
    );
  }
  await assertReworkAuthority(actorUserId, claim.executionScopeId);
  const warranty = await handymanServiceWarrantyRepository.findWarrantyById(
    client,
    warrantyId,
    true,
  );
  if (!warranty) throw handymanServiceWarrantyNotFoundError();
  return { claim, warranty };
}

/**
 * PROPOSE: create the SINGLE free rework of an APPROVED claim as
 * REWORK_DRAFT. The warranty head does NOT move yet — a proposed rework
 * is not an execution state. Replay of the SAME key returns the SAME
 * rework; a NEW key once a rework exists is a bounded 409.
 */
export async function proposeHandymanServiceWarrantyRework(
  actorUserId: string,
  input: ProposeHandymanServiceWarrantyReworkInput,
): Promise<HandymanServiceWarrantyReworkCommandResult> {
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const claimUuid = ensureUuid(input.claimId, 'claimId');
  const key = ensureKey(input.idempotencyKey);
  const scopeNote = ensureNote(input.scopeNote, 'scopeNote');

  const claim = await handymanServiceWarrantyClaimRepository.findClaimById(
    getPool(),
    claimUuid,
  );
  if (!claim) {
    throw handymanServiceWarrantyReworkNotEligibleError(
      `claim-not-found=${claimUuid}`,
    );
  }
  await assertReworkAuthority(actorUuid, claim.executionScopeId);
  // CR-HM-SEC-01 PART 07B-2A — PROPOSE is a field-worker (Lead)
  // command: CR-HM-04 Lead action authority on the claim's ORIGINAL
  // execution scope, after the resource 404 and the BE-02G building
  // wall, before the transaction, replay and mutation.
  await assertReworkLeadAction(claim.executionScopeId, actorUuid);

  return withTransaction(async (client) => {
    const locked = await lockClaimAndWarranty(
      client,
      claimUuid,
      claim.warrantyId,
      actorUuid,
    );
    const replay = await handymanServiceWarrantyReworkRepository
      .findReworkEventByClaimIdempotency(client, claimUuid, 'PROPOSE', key);
    if (replay) {
      const rework = await handymanServiceWarrantyReworkRepository
        .findReworkById(client, replay.reworkId);
      if (!rework) throw handymanServiceWarrantyReworkNotFoundError();
      return {
        rework,
        event: replay,
        warrantyStatus: locked.warranty.status,
        claimStatus: locked.claim.status,
        replayed: true,
      };
    }
    assertHandymanServiceWarrantyReworkIntakeEligible(
      locked.claim.status,
      locked.warranty.status,
    );
    const existing = await handymanServiceWarrantyReworkRepository
      .findReworkByClaimId(client, claimUuid);
    if (existing) {
      throw handymanServiceWarrantyReworkConflictError(
        `rework-exists=${existing.id}`,
      );
    }
    const rework = await handymanServiceWarrantyReworkRepository
      .createRework(client, {
        claimId: claimUuid,
        scopeNote,
        proposedByUserId: actorUuid,
      });
    const event = await handymanServiceWarrantyReworkRepository
      .insertReworkEvent(client, {
        clientId: rework.clientId,
        reworkId: rework.id,
        claimId: rework.claimId,
        warrantyId: rework.warrantyId,
        executionScopeId: rework.executionScopeId,
        bastId: rework.bastId,
        eventType: 'PROPOSE',
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    return {
      rework,
      event,
      warrantyStatus: locked.warranty.status,
      claimStatus: locked.claim.status,
      replayed: false,
    };
  });
}

type ReworkAction = 'ACCEPT' | 'START' | 'COMPLETE' | 'VERIFY';

/**
 * Applies ONE state-gated rework transition and mirrors it on the warranty
 * head, in one transaction with the rework row locked.
 */
async function applyReworkAction(
  actorUserId: string,
  reworkIdRaw: string,
  idempotencyKeyRaw: string,
  action: ReworkAction,
  options: {
    completionNote?: string | null;
    verificationEvidenceRecordId?: string | null;
    verificationQcRunId?: string | null;
  } = {},
): Promise<HandymanServiceWarrantyReworkCommandResult> {
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const reworkId = ensureUuid(reworkIdRaw, 'reworkId');
  const key = ensureKey(idempotencyKeyRaw);
  const completionNote = action === 'COMPLETE'
    ? ensureNote(options.completionNote, 'completionNote') || null
    : null;

  return withTransaction(async (client) => {
    const rework = await handymanServiceWarrantyReworkRepository
      .findReworkById(client, reworkId, true);
    if (!rework) throw handymanServiceWarrantyReworkNotFoundError();
    const locked = await lockClaimAndWarranty(
      client,
      rework.claimId,
      rework.warrantyId,
      actorUuid,
    );

    // CR-HM-SEC-01 PART 07B-2A — START / COMPLETE / VERIFY are
    // field-worker (crew Lead) commands: CR-HM-04 Lead action
    // authority on the rework's ORIGINAL execution scope, after the
    // in-transaction building re-proof and BEFORE the idempotent
    // replay lookup and any mutation (a replay can never bypass the
    // Lead check). AUTHORIZE (ACCEPT) is the customer-side decision
    // and stays free of the Lead check.
    if (action !== 'ACCEPT') {
      await assertReworkLeadAction(rework.executionScopeId, actorUuid);
    }

    const replay = await handymanServiceWarrantyReworkRepository
      .findReworkEventByIdempotency(client, rework.id, action, key);
    if (replay) {
      return {
        rework,
        event: replay,
        warrantyStatus: locked.warranty.status,
        claimStatus: locked.claim.status,
        replayed: true,
      };
    }

    let verificationEvidenceRecordId: string | null = null;
    let verificationQcRunId: string | null = null;
    if (action === 'VERIFY') {
      const suppliedEvidence = ensureOptionalUuid(
        options.verificationEvidenceRecordId,
        'evidenceRecordId',
      );
      if (!suppliedEvidence) {
        throw handymanServiceWarrantyReworkEvidenceRequiredError();
      }
      verificationEvidenceRecordId = suppliedEvidence;
      verificationQcRunId = ensureOptionalUuid(
        options.verificationQcRunId,
        'qcRunId',
      );
      await assertVerificationSources(
        client,
        verificationEvidenceRecordId,
        verificationQcRunId,
        rework.clientId,
        rework.executionScopeId,
      );
    }

    const nextReworkStatus = nextHandymanServiceWarrantyReworkStatus(
      rework.status,
      action,
    );
    const nextHeadStatus = nextHandymanServiceWarrantyReworkHeadStatus(
      locked.warranty.status,
      action,
    );

    const updated = await handymanServiceWarrantyReworkRepository
      .updateReworkStatus(client, rework.id, nextReworkStatus, actorUuid, {
        completionNote,
        verificationEvidenceRecordId,
        verificationQcRunId,
      });
    if (nextHeadStatus !== locked.warranty.status) {
      await handymanServiceWarrantyRepository.updateWarrantyStatus(
        client,
        locked.warranty.id,
        nextHeadStatus,
      );
    }
    const event = await handymanServiceWarrantyReworkRepository
      .insertReworkEvent(client, {
        clientId: updated.clientId,
        reworkId: updated.id,
        claimId: updated.claimId,
        warrantyId: updated.warrantyId,
        executionScopeId: updated.executionScopeId,
        bastId: updated.bastId,
        eventType: action,
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    return {
      rework: updated,
      event,
      warrantyStatus: nextHeadStatus,
      claimStatus: locked.claim.status,
      replayed: false,
    };
  });
}

/**
 * ACCEPT: REWORK_DRAFT -> REWORK_AUTHORIZED (customer-side acceptance of
 * the free rework scope). The head stays CLAIM_APPROVED.
 */
export async function authorizeHandymanServiceWarrantyRework(
  actorUserId: string,
  input: HandymanServiceWarrantyReworkTransitionInput,
): Promise<HandymanServiceWarrantyReworkCommandResult> {
  return applyReworkAction(actorUserId, input.reworkId, input.idempotencyKey,
    'ACCEPT');
}

/** START: REWORK_AUTHORIZED -> REWORK_IN_PROGRESS (head -> REWORK_IN_PROGRESS). */
export async function startHandymanServiceWarrantyRework(
  actorUserId: string,
  input: HandymanServiceWarrantyReworkTransitionInput,
): Promise<HandymanServiceWarrantyReworkCommandResult> {
  return applyReworkAction(actorUserId, input.reworkId, input.idempotencyKey,
    'START');
}

/** COMPLETE: REWORK_IN_PROGRESS -> REWORK_COMPLETE (head -> REWORK_COMPLETE). */
export async function completeHandymanServiceWarrantyRework(
  actorUserId: string,
  input: CompleteHandymanServiceWarrantyReworkInput,
): Promise<HandymanServiceWarrantyReworkCommandResult> {
  return applyReworkAction(actorUserId, input.reworkId, input.idempotencyKey,
    'COMPLETE', { completionNote: input.completionNote });
}

/**
 * VERIFY: REWORK_COMPLETE -> REWORK_VERIFIED — the verification pass that
 * closes the claim (rework executed again and verified). Binds the
 * verification evidence (same client + original scope) and optionally a
 * PASSED QC run of that scope, both consumed READ-ONLY from CR-HM-10. The
 * head keeps the frozen REWORK_COMPLETE value; no new head state is
 * invented.
 */
export async function verifyHandymanServiceWarrantyRework(
  actorUserId: string,
  input: VerifyHandymanServiceWarrantyReworkInput,
): Promise<HandymanServiceWarrantyReworkCommandResult> {
  return applyReworkAction(actorUserId, input.reworkId, input.idempotencyKey,
    'VERIFY', {
      verificationEvidenceRecordId: input.evidenceRecordId,
      verificationQcRunId: input.qcRunId,
    });
}

/** Read helper — a rework by id, or a bounded 404. */
export async function getHandymanServiceWarrantyReworkById(
  reworkId: string,
): Promise<HandymanServiceWarrantyReworkRecord> {
  const id = ensureUuid(reworkId, 'reworkId');
  const rework = await handymanServiceWarrantyReworkRepository.findReworkById(
    getPool(),
    id,
  );
  if (!rework) throw handymanServiceWarrantyReworkNotFoundError();
  return rework;
}

/** Read helper — the claim's free rework, or null when none exists. */
export async function findHandymanServiceWarrantyReworkByClaimId(
  claimId: string,
): Promise<HandymanServiceWarrantyReworkRecord | null> {
  const id = ensureUuid(claimId, 'claimId');
  return handymanServiceWarrantyReworkRepository.findReworkByClaimId(
    getPool(),
    id,
  );
}

/** Read helper — the warranty's free reworks, oldest first. */
export async function listHandymanServiceWarrantyReworks(
  warrantyId: string,
): Promise<HandymanServiceWarrantyReworkRecord[]> {
  const id = ensureUuid(warrantyId, 'warrantyId');
  return handymanServiceWarrantyReworkRepository.listReworksByWarrantyId(
    getPool(),
    id,
  );
}
