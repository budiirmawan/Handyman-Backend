import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { isValidUuid } from '../clients';
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
import { nextHandymanBastStatus } from './handyman-bast.lifecycle';
import { handymanBastRepository } from './handyman-bast.repository';
import type {
  HandymanBastEventRecord,
  HandymanBastPart01EventType,
  HandymanBastRecord,
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

/** Read helper — unused by HTTP in this PART. */
export async function getHandymanBastById(
  bastId: string,
): Promise<HandymanBastRecord> {
  const id = ensureUuid(bastId, 'bastId');
  const bast = await handymanBastRepository.findBastById(getPool(), id);
  if (!bast) throw handymanBastNotFoundError();
  return bast;
}
