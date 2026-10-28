import { assignmentResponseRepository, handymanAssignmentDeclinedError } from '../assignment-responses';
import { randomUUID } from 'node:crypto';
import { assertVerifiedManagedEvidenceReference } from '../handyman-field-evidence/handyman-field-evidence.service';
import { assertWarrantyReworkOperations } from './handyman-warranty-rework-authority';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { canAccessBuildingScopedResource } from '../context-access';
import { assertHandymanCustomerScopeAuthority }
  from '../handyman-tenant-decision-authority/handyman-customer-scope-authority';
import { handymanExecutionScopeNotFoundError }
  from '../handyman-quotations';
import {
  handymanScopeAssignmentRepository,
  resolveHandymanAssignmentLead,
} from '../handyman-scope-assignments';
import { handymanServiceWarrantyClaimRepository, readCoveredWarrantyClaimApproval }
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
  handymanServiceWarrantyReworkEvidenceRequiredError,
  handymanServiceWarrantyReworkNotAuthorizedError,
  handymanServiceWarrantyReworkNotFoundError,
  handymanServiceWarrantyReworkNotEligibleError,
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
 * Existing warranty rework lifecycle, extended prospectively with a separate
 * approved-claim child scope. START/COMPLETE use that scope's current Lead;
 * COMPLETE requires fresh verified evidence. Original scope, QC and BAST stay
 * untouched. New VERIFY/claim resolution is deliberately not implemented.
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
  executor?: PoolClient,
): Promise<void> {
  const scope = await handymanScopeAssignmentRepository.findScopeById(
    executor,
    executionScopeId,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  if (!(await canAccessBuildingScopedResource(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  }, executor))) {
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
 * uses the PART 03 personal request-PIC authority, not the crew chain.
 */
async function assertReworkLeadAction(
  executionScopeId: string,
  actorUserId: string,
  executor?: PoolClient,
): Promise<void> {
  const resolution = await resolveHandymanAssignmentLead(
    executionScopeId,
    actorUserId,
    executor,
  );
  if (!resolution || resolution.leadUserId !== actorUserId) {
    throw handymanServiceWarrantyReworkNotAuthorizedError();
  }
}

/**
 * Locks and re-proves the parent claim and warranty inside the write
 * transaction, together with the actor's client authority.
 */
async function lockClaimAndWarranty(
  client: PoolClient,
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
  await assertReworkAuthority(actorUserId, claim.executionScopeId, client);
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
  const originalScope = await handymanScopeAssignmentRepository.findScopeById(getPool(), claim.executionScopeId);
  if (!originalScope) throw handymanExecutionScopeNotFoundError();
  // Re-proved under transaction locks below; the original Lead remains a
  // valid proposer even when Operations has not delegated commercial access.

  return withTransaction(async (client) => {
    await client.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE', [claim.executionScopeId]);
    const leadNow=await resolveHandymanAssignmentLead(claim.executionScopeId,actorUuid,client).catch(()=>null);
    if (leadNow?.leadUserId!==actorUuid) await assertWarrantyReworkOperations(client,originalScope,actorUuid);
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
    if (!(await readCoveredWarrantyClaimApproval(client, locked.claim.id))) {
      throw handymanServiceWarrantyReworkNotEligibleError('missing-verified-warranty-assessment');
    }
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
    completionEvidenceReference?: string | null;
  } = {},
): Promise<HandymanServiceWarrantyReworkCommandResult> {
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const reworkId = ensureUuid(reworkIdRaw, 'reworkId');
  const key = ensureKey(idempotencyKeyRaw);
  const completionNote = action === 'COMPLETE'
    ? ensureNote(options.completionNote, 'completionNote') || null
    : null;
  // Authorization rechecks the current certificate while holding the same
  // scope lock used by certificate and completion mutations.
  const preflight = await handymanServiceWarrantyReworkRepository.findReworkById(getPool(), reworkId);
  if (!preflight) throw handymanServiceWarrantyReworkNotFoundError();

  return withTransaction(async (client) => {
    await client.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE', [preflight.executionScopeId]);
    const execution = (await client.query<{execution_scope_id:string}>(
      'SELECT execution_scope_id FROM handyman_warranty_rework_executions WHERE rework_id=$1', [reworkId])).rows[0];
    if (execution) await client.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE', [execution.execution_scope_id]);
    const rework = await handymanServiceWarrantyReworkRepository
      .findReworkById(client, reworkId, true);
    if (!rework) throw handymanServiceWarrantyReworkNotFoundError();
    const locked = await lockClaimAndWarranty(
      client,
      rework.claimId,
      rework.warrantyId,
      actorUuid,
    );

    // ACCEPT stays customer-side. START/COMPLETE belong to the child scope's
    // current Lead; no action derives authority from the original Lead.
    if (action === 'ACCEPT') {
      await assertHandymanCustomerScopeAuthority(client, rework.executionScopeId, actorUuid);
    } else if (action === 'VERIFY' && !execution) {
      await assertReworkLeadAction(rework.executionScopeId,actorUuid,client);
    } else {
      if (!execution) throw handymanServiceWarrantyReworkConflictError('rework-execution-scope-required');
      const assignment=await handymanScopeAssignmentRepository.findActiveAssignmentByScope(client,execution.execution_scope_id);
      if (!assignment) throw handymanServiceWarrantyReworkNotAuthorizedError();
      const response=await assignmentResponseRepository.findByAssignmentId(assignment.id,client);
      if (response?.responseStatus==='TIDAK_BISA') throw handymanAssignmentDeclinedError();
      await client.query('SELECT id FROM handyman_work_crews WHERE id=$1 FOR UPDATE',[assignment.handymanCrewId]);
      await assertReworkLeadAction(execution.execution_scope_id, actorUuid, client);
    }

    const replay = await handymanServiceWarrantyReworkRepository
      .findReworkEventByIdempotency(client, rework.id, action, key);
    if (replay) {
      if (replay.actorUserId !== actorUuid) {
        throw handymanServiceWarrantyReworkConflictError('idempotency-actor-mismatch');
      }
      if (action === 'COMPLETE') {
        const proof = (await client.query<{attachment_reference:string}>(`SELECT u.attachment_reference
          FROM handyman_warranty_rework_completions c JOIN handyman_field_evidence_uploads u ON u.id=c.evidence_upload_id
          WHERE c.rework_id=$1`, [rework.id])).rows[0];
        if (!proof || proof.attachment_reference !== options.completionEvidenceReference || rework.completionNote !== completionNote)
          throw handymanServiceWarrantyReworkConflictError('idempotency-completion-mismatch');
      }
      return {
        rework,
        event: replay,
        warrantyStatus: locked.warranty.status,
        claimStatus: locked.claim.status,
        replayed: true,
      };
    }

    // A historical DRAFT must not become authorized solely because its old
    // claim was approved before certificate-bound assessments existed.
    if (action === 'ACCEPT' && !(await readCoveredWarrantyClaimApproval(client, locked.claim.id))) {
      throw handymanServiceWarrantyReworkNotEligibleError('missing-verified-warranty-assessment');
    }
    if (action === 'VERIFY') throw handymanServiceWarrantyReworkConflictError('final-claim-resolution-not-implemented');
    if (action !== 'ACCEPT' && !(await readCoveredWarrantyClaimApproval(client, rework.claimId))) {
      throw handymanServiceWarrantyReworkNotEligibleError('missing-current-verified-warranty-assessment');
    }
    if (action === 'START' && execution) {
      const ready=(await client.query(`SELECT p.id,ua.id FROM handyman_execution_scopes s JOIN handyman_execution_scope_assignments a
          ON a.execution_scope_id=s.id AND a.status='ACTIVE'
        JOIN LATERAL (SELECT ar.* FROM handyman_arrival_verification_results ar
          WHERE ar.execution_scope_id=s.id AND ar.assignment_id=a.id AND ar.actor_user_id=$2
          ORDER BY ar.evaluated_at DESC,ar.id DESC LIMIT 1) ar ON ar.status='VERIFIED' AND ar.evaluated_at>=a.assigned_at
        JOIN handyman_permit_readiness p ON p.handyman_request_id=s.handyman_request_id AND p.client_id=s.client_id
          AND p.building_id=s.building_id AND p.space_id IS NOT DISTINCT FROM s.space_id AND p.status='ACTIVE'
          AND p.valid_from<=clock_timestamp() AND p.valid_until>clock_timestamp()
        JOIN handyman_unit_access_readiness ua ON ua.handyman_request_id=s.handyman_request_id AND ua.client_id=s.client_id
          AND ua.building_id=s.building_id AND ua.space_id IS NOT DISTINCT FROM s.space_id AND ua.status='ACTIVE'
          AND ua.access_window_start<=clock_timestamp() AND ua.access_window_end>clock_timestamp()
        WHERE s.id=$1 FOR SHARE OF p,ua`,[execution.execution_scope_id,actorUuid])).rows[0];
      if (!ready) throw handymanServiceWarrantyReworkConflictError('verified-arrival-and-current-permit-access-required');
    }
    if (action === 'COMPLETE') {
      if (!execution || !options.completionEvidenceReference) throw handymanServiceWarrantyReworkEvidenceRequiredError();
      const scope = await handymanScopeAssignmentRepository.findScopeById(client, execution.execution_scope_id);
      if (!scope) throw handymanExecutionScopeNotFoundError();
      const lead = await resolveHandymanAssignmentLead(scope.id, actorUuid, client);
      if (!lead || lead.leadUserId !== actorUuid) throw handymanServiceWarrantyReworkNotAuthorizedError();
      const evidence = await assertVerifiedManagedEvidenceReference(client, {
        clientId:scope.clientId, buildingId:scope.buildingId, handymanRequestId:scope.handymanRequestId,
        executionScopeId:scope.id,
      }, options.completionEvidenceReference, {requiredPurpose:'BEFORE_AFTER_WORK'});
      if (!evidence) throw handymanServiceWarrantyReworkEvidenceRequiredError();
      const proof = (await client.query<{arrival_id:string;session_id:string|null}>(`SELECT ar.id AS arrival_id,
        (SELECT w.id FROM handyman_work_sessions w WHERE w.execution_scope_id=$3 AND w.assignment_id=$4
          AND w.lead_user_id=$5 AND w.started_work_at>=r.started_at AND w.completed_at IS NOT NULL
          ORDER BY w.completed_at DESC LIMIT 1) AS session_id
        FROM handyman_service_warranty_reworks r JOIN handyman_field_evidence_uploads e ON e.id=$2
        JOIN LATERAL (SELECT ar2.* FROM handyman_arrival_verification_results ar2
          WHERE ar2.execution_scope_id=$3 AND ar2.assignment_id=$4 AND ar2.actor_user_id=$5
            AND ar2.evaluated_at<=r.started_at ORDER BY ar2.evaluated_at DESC,ar2.id DESC LIMIT 1) ar ON ar.status='VERIFIED'
        WHERE r.id=$1 AND e.execution_scope_id=$3 AND e.uploaded_by_user_id=$5 AND e.uploaded_by_role='PIC_PEKERJAAN'
          AND e.verified_at>=r.started_at AND NOT EXISTS (SELECT 1 FROM handyman_work_sessions w WHERE w.execution_scope_id=$3
            AND (w.completed_at IS NULL OR w.status NOT IN ('COMPLETED','CHECKED_OUT'))) FOR SHARE OF e`,
        [rework.id,evidence.id,scope.id,lead.assignmentId,actorUuid])).rows[0];
      if (!proof) throw handymanServiceWarrantyReworkConflictError('fresh-lead-arrival-and-evidence-required');
      await client.query(`INSERT INTO handyman_warranty_rework_completions
        (id,rework_id,execution_scope_id,session_id,arrival_result_id,assignment_id,lead_user_id,evidence_upload_id,evidence_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(),rework.id,scope.id,proof.session_id,proof.arrival_id,
        lead.assignmentId,actorUuid,evidence.id,evidence.sha256Checksum]);
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
        verificationEvidenceRecordId: null,
        verificationQcRunId: null,
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
    'COMPLETE', { completionNote: input.completionNote, completionEvidenceReference: input.evidenceReference });
}

/** Historic idempotent VERIFY may be read back; new claim resolution is blocked. */
export async function verifyHandymanServiceWarrantyRework(
  actorUserId: string,
  input: VerifyHandymanServiceWarrantyReworkInput,
): Promise<HandymanServiceWarrantyReworkCommandResult> {
  return applyReworkAction(actorUserId, input.reworkId, input.idempotencyKey,
    'VERIFY');
}

/**
 * The frozen PART 01/03 read surface for the rework family is the
 * guarded HTTP/API contract readers (06D-1) and the lifecycle
 * commands; the former actor-less read helpers were removed in
 * CR-HM-SEC-01 PART 07C-2C (dead/actor-less surface, 07C-1 class A).
 */
