import { requireVerifiedCompletionForIssue } from '../handyman-completion-manifest/handyman-completion-manifest.service';
import { resolveCareWorkspacePrincipal } from '../handyman-care-workspace/care-workspace.service';
import { handymanExecutionScopeRepository } from '../handyman-quotations/handyman-execution-scope.repository';
import { assertCareConsentWriteFresh, verifyCareCommercialConsent, type CareDecisionChannel } from '../handyman-commercial-consent/commercial-consent.service';
import { bastCommercialTarget } from '../handyman-commercial-consent/commercial-consent.targets';
import { handymanServiceRequestRepository } from '../handyman-requests/handyman-service-request.repository';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { assertCurrentGuardedHandymanQcPass }
  from '../handyman-evidence-qc/handyman-qc-pass-gate';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { assertHandymanCustomerScopeAuthority }
  from '../handyman-tenant-decision-authority/handyman-customer-scope-authority';
import {
  HANDYMAN_BAST_CARE_CONSENT_PROTOCOL,
  HANDYMAN_BAST_CUSTOMER_CONSENT_METHOD,
  HANDYMAN_BAST_CUSTOMER_CONSENT_PROTOCOL,
  computeHandymanBastCustomerConsentDigest,
  readHandymanBastConsentEvidence,
  verifiedHandymanBastCustomerConsent,
  type HandymanBastCustomerConsentManifest,
} from './handyman-bast-customer-consent';
import { handymanExecutionScopeNotFoundError }
  from '../handyman-quotations';
import { handymanScopeAssignmentRepository }
  from '../handyman-scope-assignments';
import {
  handymanBastActiveConflictError,
  handymanBastIllegalTransitionError,
  handymanBastNotFoundError,
  handymanBastScopeNotEligibleError,
  handymanBastQcNotReadyError,
  handymanBastValidationError,
} from './handyman-bast.errors';
import {
  assertHandymanBastSignature,
  nextHandymanBastStatus,
} from './handyman-bast.lifecycle';
import { toHandymanBastAcceptanceReadContract, toHandymanBastArtifactReference } from './handyman-bast.read-contract';
import type { HandymanBastAcceptanceReadContract } from './handyman-bast.read-contract';
import { handymanBastRepository } from './handyman-bast.repository';
import type {
  HandymanBastEventRecord,
  HandymanBastEventType,
  HandymanBastPart01EventType,
  HandymanBastRecord,
  HandymanBastSignOffRecord,
} from './handyman-bast.types';

/**
 * Existing BAST lifecycle. PART 04 separates provider preparation/issuance
 * from authenticated personal-PIC customer consent; the additive verified Care
 * recording channel uses these same decision transactions.
 */

export type HandymanBastPrepareInput = {
  executionScopeId: string;
  idempotencyKey: string;
};

export type HandymanBastTransitionInput = {
  bastId: string;
  idempotencyKey: string;
  /**
   * CR-HM-BAST-HTTP-01 — VOID only: audit justification preserved inside the
   * append-only event chain (`metadata.voidReason`). Optional for in-process
   * callers (historical behaviour); the worker HTTP transport requires it.
   * Ignored for ISSUE.
   */
  voidReason?: string | null;
};

export type HandymanBastCommandResult = {
  bast: HandymanBastRecord;
  event: HandymanBastEventRecord;
  replayed: boolean;
  signOff?: HandymanBastSignOffRecord;
};

export type HandymanBastSignOffInput = {
  bastId: string;
  idempotencyKey: string;
  signatureDigest: string;
  evidenceRecordId?: string | null;
  rejectReason?: string | null;
};

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw handymanBastValidationError(field);
  }
  return raw.toLowerCase();
}

function ensureKey(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 200) {
    throw handymanBastValidationError('idempotencyKey');
  }
  return raw;
}

/**
 * CR-HM-BAST-HTTP-01 — VOID audit reason. Stored as event metadata, never as
 * a document column and never a status authority. Blank/absent reasons stay
 * legal for in-process callers; malformed or oversized reasons are rejected
 * rather than silently truncated (audit text must not be distorted).
 */
function ensureVoidReasonMetadata(
  action: string,
  voidReason: string | null | undefined,
): Record<string, unknown> {
  if (action !== 'VOID') return {};
  if (voidReason === undefined || voidReason === null) return {};
  if (typeof voidReason !== 'string') {
    throw handymanBastValidationError('voidReason');
  }
  const raw = voidReason.trim();
  if (raw.length > 2000) {
    throw handymanBastValidationError('voidReason');
  }
  return raw.length > 0 ? { voidReason: raw } : {};
}

async function loadAuthorizedScope(
  executor: Pick<PoolClient, 'query'>,
  executionScopeId: string,
) {
  // Scope-row lock serializes PREPARE's active-document/idempotency check
  // with assignment changes and competing PREPARE requests. A duplicate key
  // waits here, then observes and replays the winner's DRAFT/event.
  const scope = await handymanScopeAssignmentRepository.lockScopeById(
    executor,
    executionScopeId,
  );
  if (!scope) {
    throw handymanExecutionScopeNotFoundError();
  }
  if (scope.status !== 'AUTHORIZED') {
    throw handymanBastScopeNotEligibleError();
  }
  return scope;
}

/** Scope → BAST throughout PREPARE/ISSUE/VOID/customer decisions and QC. */
async function lockBastContext(tx: PoolClient, bastId: string) {
  const parent = await handymanBastRepository.findBastById(tx, bastId);
  if (!parent) throw handymanBastNotFoundError();
  const scope = await handymanScopeAssignmentRepository.lockScopeById(tx, parent.executionScopeId);
  if (!scope) throw handymanExecutionScopeNotFoundError();
  const bast = await handymanBastRepository.findBastByIdForUpdate(tx, bastId);
  if (!bast) throw handymanBastNotFoundError();
  return { bast, scope };
}

async function requireCurrentQcPassForBast(
  tx: PoolClient,
  scope: { id: string; clientId: string; buildingId: string },
  expectedRunId?: string,
): Promise<string> {
  try {
    const decision = await assertCurrentGuardedHandymanQcPass(tx, scope,
      expectedRunId);
    return decision.runId;
  } catch (error) {
    if (error instanceof AppError
        && (error.code === ERROR_CODES.HANDYMAN_QC_PASS_BLOCKED
          || error.code === ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED)) {
      throw handymanBastQcNotReadyError();
    }
    throw error;
  }
}

export async function prepareHandymanBast(
  actorUserId: string,
  input: HandymanBastPrepareInput,
): Promise<HandymanBastCommandResult> {
  const actor = ensureUuid(actorUserId, 'actorUserId');
  const executionScopeId = ensureUuid(
    input.executionScopeId,
    'executionScopeId',
  );
  const idempotencyKey = ensureKey(input.idempotencyKey);

  return withTransaction(async (client) => {
    const scope = await loadAuthorizedScope(client, executionScopeId);
    // CR-HM-SEC-01 PART 05B — local-staff BAST lifecycle write: the
    // data-scope wall is the BE-02G building guard on the
    // authoritative server-derived scope building (migration 0395) —
    // no client-level shortcut. It runs BEFORE the active-BAST /
    // replay / conflict paths, so a same-Client sibling Building
    // actor learns nothing about existing BAST content.
    await assertBuildingScopedResourceAccess(actor, {
      clientId: scope.clientId,
      buildingId: scope.buildingId,
    }, client);
    const existing = await handymanBastRepository.findActiveBastByScopeId(
      client,
      executionScopeId,
    );
    if (existing) {
      const replay = await handymanBastRepository.findEventByIdempotency(
        client,
        existing.id,
        'PREPARE',
        idempotencyKey,
      );
      if (replay) {
        return { bast: existing, event: replay, replayed: true };
      }
      throw handymanBastActiveConflictError(executionScopeId);
    }
    // PREPARE is strictly downstream of the latest genuine Supervisor QC
    // PASS. This does not issue, sign or accept the BAST for the customer.
    const qcRunId = await requireCurrentQcPassForBast(client, scope);
    const latestBast = await handymanBastRepository.findLatestBastByScopeId(
      client,
      executionScopeId,
    );
    if (
      latestBast &&
      latestBast.status === 'REJECTED' &&
      latestBast.qcRunId === qcRunId
    ) {
      throw handymanBastQcNotReadyError();
    }
    const bast = await handymanBastRepository.createBast(client, {
      clientId: scope.clientId, executionScopeId, qcRunId,
    });
    const event = await handymanBastRepository.insertEvent(client, {
      clientId: scope.clientId,
      bastId: bast.id,
      executionScopeId,
      eventType: 'PREPARE',
      idempotencyKey,
      actorUserId: actor,
    });
    return { bast, event, replayed: false };
  });
}

async function applyPart01Transition(
  actorUserId: string,
  bastIdRaw: string,
  idempotencyKeyRaw: string,
  action: Exclude<HandymanBastPart01EventType, 'PREPARE'>,
  voidReason?: string | null,
): Promise<HandymanBastCommandResult> {
  const actor = ensureUuid(actorUserId, 'actorUserId');
  const bastId = ensureUuid(bastIdRaw, 'bastId');
  const idempotencyKey = ensureKey(idempotencyKeyRaw);
  // CR-HM-BAST-HTTP-01 — validate the VOID reason before any mutation so a
  // malformed reason can never half-apply; non-VOID actions ignore it.
  const voidReasonMetadata = ensureVoidReasonMetadata(action, voidReason);

  return withTransaction(async (client) => {
    const { bast, scope } = await lockBastContext(client, bastId);
    // Exact Building still precedes replay; provider lifecycle is unchanged.
    await assertBuildingScopedResourceAccess(actor, {
      clientId: scope.clientId,
      buildingId: scope.buildingId,
    }, client);
    const replay = await handymanBastRepository.findEventByIdempotency(
      client,
      bast.id,
      action,
      idempotencyKey,
    );
    if (replay) {
      const current = await handymanBastRepository.findBastById(
        client,
        bast.id,
      );
      if (!current) throw handymanBastNotFoundError();
      return { bast: current, event: replay, replayed: true };
    }
    await loadAuthorizedScope(client, bast.executionScopeId);
    const next = nextHandymanBastStatus(bast.status, action);
    let completion: Awaited<ReturnType<typeof requireVerifiedCompletionForIssue>> | undefined;
    if (action === 'ISSUE') {
      if (!bast.qcRunId) throw handymanBastQcNotReadyError();
      await requireCurrentQcPassForBast(client, scope, bast.qcRunId);
      completion = await requireVerifiedCompletionForIssue(client, scope, bast.qcRunId);
    }
    const updated = await handymanBastRepository.updateBastStatus(
      client,
      bast.id,
      next,
      bast.status,
      completion?.verificationId,
    );
    const event = await handymanBastRepository.insertEvent(client, {
      clientId: bast.clientId,
      bastId: bast.id,
      executionScopeId: bast.executionScopeId,
      eventType: action,
      idempotencyKey,
      actorUserId: actor,
      metadata: completion ? { ...voidReasonMetadata, completion } : voidReasonMetadata,
    });
    return { bast: updated, event, replayed: false };
  });
}

export async function issueHandymanBast(
  actorUserId: string,
  input: HandymanBastTransitionInput,
): Promise<HandymanBastCommandResult> {
  return applyPart01Transition(
    actorUserId,
    input.bastId,
    input.idempotencyKey,
    'ISSUE',
    // ISSUE never consumes a void reason (kept out of the ISSUE audit chain).
  );
}

export async function voidHandymanBast(
  actorUserId: string,
  input: HandymanBastTransitionInput,
): Promise<HandymanBastCommandResult> {
  return applyPart01Transition(
    actorUserId,
    input.bastId,
    input.idempotencyKey,
    'VOID',
    input.voidReason,
  );
}

export async function acceptHandymanBast(
  actorUserId: string | CareDecisionChannel,
  input: HandymanBastSignOffInput,
): Promise<HandymanBastCommandResult> {
  return applyCustomerSignOff(actorUserId, input, 'ACCEPT');
}

export async function rejectHandymanBast(
  actorUserId: string | CareDecisionChannel,
  input: HandymanBastSignOffInput,
): Promise<HandymanBastCommandResult> {
  return applyCustomerSignOff(actorUserId, input, 'REJECT');
}

async function applyCustomerSignOff(
  channel: string | CareDecisionChannel,
  input: HandymanBastSignOffInput,
  action: 'ACCEPT' | 'REJECT',
): Promise<HandymanBastCommandResult> {
  const actor = typeof channel === 'string' ? ensureUuid(channel, 'actorUserId') : null;
  const bastId = ensureUuid(input.bastId, 'bastId');
  const idempotencyKey = ensureKey(input.idempotencyKey);
  const suppliedDigest = actor !== null ? assertHandymanBastSignature(action, input.signatureDigest).toLowerCase() : '';
  const evidenceRecordId = input.evidenceRecordId == null || input.evidenceRecordId === ''
    ? null : ensureUuid(input.evidenceRecordId, 'evidenceRecordId');
  if (input.rejectReason != null && typeof input.rejectReason !== 'string') {
    throw handymanBastValidationError('rejectReason');
  }
  const rejectReason = input.rejectReason?.trim() || null;
  if ((rejectReason?.length ?? 0) > 2000 || (action === 'ACCEPT' && rejectReason !== null)) {
    throw handymanBastValidationError('rejectReason');
  }

  const carePrincipal = typeof channel === 'string' ? null : await resolveCareWorkspacePrincipal(channel.workspaceToken);
  return withTransaction(async (client) => {
    const locked = await lockBastContext(client, bastId);
    const { bast } = locked;
    const scope = await handymanExecutionScopeRepository.findScopeById(client, bast.executionScopeId);
    if (!scope) throw handymanExecutionScopeNotFoundError();
    // Personal authority remains unchanged. The Care branch must produce a
    // separately verified, exact-target customer receipt, never a role override.
    let tenantPicId: string | null;
    let consent = null;
    if (typeof channel === 'string') {
      ({ tenantPicId } = await assertHandymanCustomerScopeAuthority(client, bast.executionScopeId, actor!));
    } else {
      const request = await handymanServiceRequestRepository.findById(client, scope.handymanRequestId);
      if (!request || request.clientId !== scope.clientId || request.tenantCompanyId !== scope.tenantCompanyId ||
          request.tenantPicId !== scope.tenantPicId || request.buildingId !== scope.buildingId || request.spaceId !== scope.spaceId) {
        throw handymanBastValidationError('bastId', 'BAST request identity mismatch.');
      }
      tenantPicId = request.tenantPicId;
      consent = await verifyCareCommercialConsent(client, channel, request, await bastCommercialTarget(client, bast, scope), action, carePrincipal!, rejectReason);
    }
    if (scope.clientId !== bast.clientId) throw handymanBastValidationError('bastId', 'BAST scope identity mismatch.');
    const replay = await handymanBastRepository.findEventByIdempotency(
      client, bast.id, action, idempotencyKey,
    );
    if (replay) {
      const existing = await handymanBastRepository.findSignOffByEventId(client, replay.id);
      if (!existing || replay.actorUserId !== actor ||
          (replay.actorCareActorId ?? null) !== (consent?.careActorId ?? null) ||
          (replay.commercialConsentId ?? null) !== (consent?.id ?? null) || existing.decision !== action ||
          existing.evidenceRecordId !== evidenceRecordId || existing.rejectReason !== rejectReason ||
          (suppliedDigest !== '' && suppliedDigest !== existing.signatureDigest) ||
          !verifiedHandymanBastCustomerConsent(bast, replay, existing)) {
        throw handymanBastIllegalTransitionError(bast.status, 'IDEMPOTENCY_PAYLOAD_OR_ACTOR_CONFLICT');
      }
      // Return only the original immutable receipt. No new QC/evidence fact is
      // asserted on replay, and a replacement PIC cannot adopt this receipt.
      return { bast, event: replay, signOff: existing, replayed: true };
    }
    const next = nextHandymanBastStatus(bast.status, action);
    if (scope.status !== 'AUTHORIZED') throw handymanBastScopeNotEligibleError();
    if (!bast.issuedAt || !bast.qcRunId) {
      throw handymanBastValidationError('bastId', 'An authoritative issued BAST/QC manifest is required.');
    }
    const issueEvents = (await handymanBastRepository.listEventsByBastId(client, bast.id))
      .filter((event) => event.eventType === 'ISSUE');
    if (issueEvents.length !== 1 || issueEvents[0]!.occurredAt.getTime() !== bast.issuedAt.getTime()) {
      throw handymanBastValidationError('bastId', 'The immutable issued BAST manifest is unavailable.');
    }
    if (action === 'ACCEPT') await requireCurrentQcPassForBast(client, scope, bast.qcRunId);
    const evidence = await readHandymanBastConsentEvidence(client, evidenceRecordId, bast);
    const issuedArtifact = toHandymanBastArtifactReference(bast);
    const manifest: HandymanBastCustomerConsentManifest = {
      ...(consent ? { protocol: HANDYMAN_BAST_CARE_CONSENT_PROTOCOL, actorUserId: null,
        tenantPicId, spaceId: scope.spaceId, careConsent: consent } : {
        protocol: HANDYMAN_BAST_CUSTOMER_CONSENT_PROTOCOL, actorUserId: actor!, tenantPicId: tenantPicId!,
      }),
      bastId: bast.id, executionScopeId: scope.id, approvedQuotationVersionId: scope.approvedQuotationVersionId,
      clientId: scope.clientId,
      handymanRequestId: scope.handymanRequestId, tenantCompanyId: scope.tenantCompanyId,
      buildingId: scope.buildingId,
      issuedArtifactRef: issuedArtifact.ref, issuedArtifactVersion: issuedArtifact.version,
      issueEventId: issueEvents[0]!.id, issuedAt: bast.issuedAt.toISOString(),
      qcRunId: bast.qcRunId, decision: action, rejectReason, evidence,
    };
    const signatureDigest = computeHandymanBastCustomerConsentDigest(manifest);
    // ACCEPT must confirm the exact manifest. REJECT may omit its digest, in
    // which case the backend calculates it; a supplied value must still match.
    if (!consent && (action === 'ACCEPT' || suppliedDigest !== '') && suppliedDigest !== signatureDigest) {
      throw handymanBastValidationError('signatureDigest', 'Digest must match the canonical issued BAST customer-consent manifest.');
    }
    if (consent) await assertCareConsentWriteFresh(client, consent, carePrincipal!);
    const updated = await handymanBastRepository.updateBastStatus(client, bast.id, next, bast.status);
    const event = await handymanBastRepository.insertEvent(client, {
      clientId: bast.clientId, bastId: bast.id, executionScopeId: bast.executionScopeId,
      eventType: action, idempotencyKey, actorUserId: actor,
      actorCareActorId: consent?.careActorId ?? null, commercialConsentId: consent?.id ?? null,
      metadata: { customerConsent: {
        method: consent?.method ?? HANDYMAN_BAST_CUSTOMER_CONSENT_METHOD, manifest, sha256Digest: signatureDigest,
      } },
    });
    const signOff = await handymanBastRepository.insertSignOff(client, {
      clientId: bast.clientId, bastId: bast.id, eventId: event.id,
      executionScopeId: bast.executionScopeId, decision: action, signatureDigest,
      evidenceRecordId, rejectReason,
    });
    return { bast: updated, event, signOff, replayed: false };
  });
}

export type HandymanBastDetailView = {
  bast: HandymanBastRecord;
  acceptance: HandymanBastAcceptanceReadContract;
  events: HandymanBastEventRecord[];
  signOffs: HandymanBastSignOffRecord[];
};

export type HandymanExecutionScopeBastView = {
  executionScopeId: string;
  bast: HandymanBastRecord | null;
  acceptance: HandymanBastAcceptanceReadContract | null;
  events: HandymanBastEventRecord[];
  signOffs: HandymanBastSignOffRecord[];
};

export async function getHandymanBastCustomerCareDetail(
  bastId: string,
  actorUserId: string,
): Promise<HandymanBastDetailView> {
  const id = ensureUuid(bastId, 'bastId');
  const actor = ensureUuid(actorUserId, 'actorUserId');
  const bast = await handymanBastRepository.findBastById(getPool(), id);
  if (!bast) {
    throw handymanBastNotFoundError();
  }
  // CR-HM-SEC-01 PART 05A — the BAST record is Client-scoped only, so
  // the authoritative location is the server-derived execution scope
  // building (migration 0395); the data-scope wall is the BE-02G
  // building guard on that exact Building, not the client-level
  // canAccessClient shortcut (no same-Client sibling leak).
  const scope = await handymanScopeAssignmentRepository.findScopeById(
    getPool(),
    bast.executionScopeId,
  );
  if (!scope) {
    throw handymanExecutionScopeNotFoundError();
  }
  await assertBuildingScopedResourceAccess(actor, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  });
  const events = await handymanBastRepository.listEventsByBastId(
    getPool(),
    bast.id,
  );
  const signOffs = await handymanBastRepository.listSignOffsByBastId(
    getPool(),
    bast.id,
  );
  return {
    bast,
    acceptance: toHandymanBastAcceptanceReadContract(bast, events, signOffs),
    events,
    signOffs,
  };
}

export async function getHandymanExecutionScopeBastCustomerCareView(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanExecutionScopeBastView> {
  const scopeId = ensureUuid(executionScopeId, 'executionScopeId');
  const actor = ensureUuid(actorUserId, 'actorUserId');
  const scope = await handymanScopeAssignmentRepository.findScopeById(
    getPool(),
    scopeId,
  );
  if (!scope) {
    throw handymanExecutionScopeNotFoundError();
  }
  // CR-HM-SEC-01 PART 05A — BE-02G building guard on the
  // authoritative server-derived scope building (migration 0395); the
  // client-level canAccessClient shortcut is NOT sufficient here — a
  // same-Client sibling Building assignment must not open the read.
  await assertBuildingScopedResourceAccess(actor, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  });
  const bast =
    (await handymanBastRepository.findActiveBastByScopeId(
      getPool(),
      scope.id,
    ))
    ?? (await handymanBastRepository.findLatestBastByScopeId(
      getPool(),
      scope.id,
    ));
  if (!bast) {
    return {
      executionScopeId: scope.id,
      bast: null,
      acceptance: null,
      events: [],
      signOffs: [],
    };
  }
  const events = await handymanBastRepository.listEventsByBastId(
    getPool(),
    bast.id,
  );
  const signOffs = await handymanBastRepository.listSignOffsByBastId(
    getPool(),
    bast.id,
  );
  return {
    executionScopeId: scope.id,
    bast,
    acceptance: toHandymanBastAcceptanceReadContract(bast, events, signOffs),
    events,
    signOffs,
  };
}
