import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { handymanExecutionScopeNotFoundError }
  from '../handyman-quotations';
import { handymanScopeAssignmentRepository }
  from '../handyman-scope-assignments';
import {
  handymanBastActiveConflictError,
  handymanBastIllegalTransitionError,
  handymanBastNotFoundError,
  handymanBastScopeNotEligibleError,
  handymanBastValidationError,
} from './handyman-bast.errors';
import {
  assertHandymanBastSignature,
  nextHandymanBastStatus,
} from './handyman-bast.lifecycle';
import { toHandymanBastAcceptanceReadContract } from './handyman-bast.read-contract';
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
 * CR-HM-11 PART 01 — PREPARE / ISSUE / VOID only.
 * No ACCEPT/REJECT, no signature, no HTTP.
 */

export type HandymanBastPrepareInput = {
  executionScopeId: string;
  idempotencyKey: string;
};

export type HandymanBastTransitionInput = {
  bastId: string;
  idempotencyKey: string;
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
  return raw;
}

function ensureKey(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 200) {
    throw handymanBastValidationError('idempotencyKey');
  }
  return raw;
}

async function loadAuthorizedScope(
  executor: Pick<PoolClient, 'query'>,
  executionScopeId: string,
) {
  const scope = await handymanScopeAssignmentRepository.findScopeById(
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
    });
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
    const bast = await handymanBastRepository.createBast(client, {
      clientId: scope.clientId,
      executionScopeId,
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
): Promise<HandymanBastCommandResult> {
  const actor = ensureUuid(actorUserId, 'actorUserId');
  const bastId = ensureUuid(bastIdRaw, 'bastId');
  const idempotencyKey = ensureKey(idempotencyKeyRaw);

  return withTransaction(async (client) => {
    const bast = await handymanBastRepository.findBastById(client, bastId);
    if (!bast) {
      throw handymanBastNotFoundError();
    }
    // CR-HM-SEC-01 PART 05B — local-staff BAST lifecycle write: the
    // data-scope wall is the BE-02G building guard on the
    // authoritative server-derived scope building (migration 0395).
    // It runs BEFORE the replay path, so a same-Client sibling
    // Building actor can neither replay nor mutate; the eligibility
    // gate (`loadAuthorizedScope`) keeps its original position after
    // the replay short-circuit, preserving idempotent-replay
    // semantics exactly.
    const scope = await handymanScopeAssignmentRepository.findScopeById(
      client,
      bast.executionScopeId,
    );
    if (!scope) {
      throw handymanExecutionScopeNotFoundError();
    }
    await assertBuildingScopedResourceAccess(actor, {
      clientId: scope.clientId,
      buildingId: scope.buildingId,
    });
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
    const updated = await handymanBastRepository.updateBastStatus(
      client,
      bast.id,
      next,
    );
    const event = await handymanBastRepository.insertEvent(client, {
      clientId: bast.clientId,
      bastId: bast.id,
      executionScopeId: bast.executionScopeId,
      eventType: action,
      idempotencyKey,
      actorUserId: actor,
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
  );
}

export async function acceptHandymanBast(
  actorUserId: string,
  input: HandymanBastSignOffInput,
): Promise<HandymanBastCommandResult> {
  return applyCustomerSignOff(actorUserId, input, 'ACCEPT');
}

export async function rejectHandymanBast(
  actorUserId: string,
  input: HandymanBastSignOffInput,
): Promise<HandymanBastCommandResult> {
  return applyCustomerSignOff(actorUserId, input, 'REJECT');
}

async function applyCustomerSignOff(
  actorUserId: string,
  input: HandymanBastSignOffInput,
  action: 'ACCEPT' | 'REJECT',
): Promise<HandymanBastCommandResult> {
  const actor = ensureUuid(actorUserId, 'actorUserId');
  const bastId = ensureUuid(input.bastId, 'bastId');
  const idempotencyKey = ensureKey(input.idempotencyKey);
  const signatureDigest = assertHandymanBastSignature(
    action,
    input.signatureDigest,
  );
  let evidenceRecordId: string | null = null;
  if (input.evidenceRecordId != null && input.evidenceRecordId !== '') {
    evidenceRecordId = ensureUuid(input.evidenceRecordId, 'evidenceRecordId');
  }
  const rejectReason = typeof input.rejectReason === 'string'
    ? input.rejectReason.trim().slice(0, 2000)
    : null;

  return withTransaction(async (client) => {
    const bast = await handymanBastRepository.findBastById(client, bastId);
    if (!bast) {
      throw handymanBastNotFoundError();
    }
    // CR-HM-SEC-01 PART 05C-2 — customer sign-off (ACCEPT/REJECT) is
    // driven by a LOCAL Customer Care staff actor (route
    // `tenant_company.manage`; BM SSO principals have no session
    // userId and no path here — the customer signature is attested
    // data, the represented tenant stays server-resolved). The
    // data-scope wall is therefore the BE-02G building guard on the
    // authoritative server-derived scope building (migration 0395),
    // NOT the client-level canAccessClient shortcut: a same-Client
    // sibling Building assignment must not open the sign-off. The
    // guard keeps the wall's original slot — after the BAST
    // existence check, before the evidence binding, the idempotent
    // replay short-circuit, and the state transition.
    const scope = await handymanScopeAssignmentRepository.findScopeById(
      client,
      bast.executionScopeId,
    );
    if (!scope) {
      throw handymanExecutionScopeNotFoundError();
    }
    await assertBuildingScopedResourceAccess(actor, {
      clientId: scope.clientId,
      buildingId: scope.buildingId,
    });
    if (evidenceRecordId) {
      const ev = await client.query(
        `SELECT execution_scope_id
           FROM handyman_evidence_records
          WHERE id = $1`,
        [evidenceRecordId],
      );
      if (
        !ev.rows[0]
        || ev.rows[0].execution_scope_id !== bast.executionScopeId
      ) {
        throw handymanBastValidationError('evidenceRecordId');
      }
    }
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
      const existingSignOff =
        await handymanBastRepository.findSignOffByEventId(
          client,
          replay.id,
        );
      return {
        bast: current,
        event: replay,
        ...(existingSignOff ? { signOff: existingSignOff } : {}),
        replayed: true,
      };
    }
    const next = nextHandymanBastStatus(bast.status, action);
    const updated = await handymanBastRepository.updateBastStatus(
      client,
      bast.id,
      next,
    );
    const event = await handymanBastRepository.insertEvent(client, {
      clientId: bast.clientId,
      bastId: bast.id,
      executionScopeId: bast.executionScopeId,
      eventType: action as HandymanBastEventType,
      idempotencyKey,
      actorUserId: actor,
    });
    const signOff = await handymanBastRepository.insertSignOff(client, {
      clientId: bast.clientId,
      bastId: bast.id,
      eventId: event.id,
      executionScopeId: bast.executionScopeId,
      decision: action,
      signatureDigest,
      evidenceRecordId,
      rejectReason: action === 'REJECT' ? rejectReason : null,
    });
    return { bast: updated, event, signOff, replayed: false };
  });
}

/** Read helper — unused by HTTP in this PART. */
export async function getHandymanBastById(
  bastId: string,
): Promise<HandymanBastRecord> {
  const id = ensureUuid(bastId, 'bastId');
  const bast = await handymanBastRepository.findBastById(getPool(), id);
  if (!bast) throw handymanBastNotFoundError();
  return bast;
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
