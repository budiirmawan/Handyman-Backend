import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import {
  handymanCommercialAgreementActiveExistsError,
  handymanCommercialAgreementClientConflictError,
  handymanCommercialAgreementIllegalTransitionError,
  handymanCommercialAgreementNotFoundError,
  handymanCommercialAgreementNotEffectiveAtAsOfError,
  handymanCommercialAgreementValidationError,
  handymanCommercialAgreementVersionNotFoundError,
} from './handyman-commercial-agreement.errors';
import {
  assertHandymanAgreementSupersessionWindow,
  nextHandymanCommercialAgreementVersionStatus,
  parseHandymanAgreementTimestamp,
} from './handyman-commercial-agreement.lifecycle';
import { handymanCommercialAgreementRepository as repo }
  from './handyman-commercial-agreement.repository';
import type {
  HandymanCommercialAgreementEventRecord,
  HandymanCommercialAgreementRecord,
  HandymanCommercialAgreementVersionRecord,
} from './handyman-commercial-agreement.types';

/**
 * CR-HM-12 PART 01 — commercial agreement aggregate + versioning
 * commands ONLY (FROZEN `CR-HM-12_START_GOVERNANCE.md` §5/§10):
 * PREPARE / ACTIVATE / SUPERSEDE + the fail-closed as-of resolver.
 * NO pricing modes, NO material basis, NO BM fee rules, NO ledger,
 * NO HTTP. Every mutation runs in one transaction, serialized on the
 * agreement root row (0402/0401 FOR UPDATE family), and is
 * replay-safe on (agreement_id, event_type, idempotency_key).
 */

export type HandymanCommercialAgreementPrepareInput = {
  clientId: string;
  idempotencyKey: string;
};

export type HandymanCommercialAgreementActivateInput = {
  versionId: string;
  effectiveFrom: string;
  idempotencyKey: string;
};

export type HandymanCommercialAgreementSupersedeInput = {
  /** Currently ACTIVE version being closed. */
  versionId: string;
  /** DRAFT version that replaces it (must belong to same agreement). */
  replacementVersionId: string;
  /** Instant at which the replacement opens and the current closes. */
  effectiveFrom: string;
  idempotencyKey: string;
};

export type HandymanCommercialAgreementCommandResult = {
  agreement: HandymanCommercialAgreementRecord;
  version: HandymanCommercialAgreementVersionRecord;
  event: HandymanCommercialAgreementEventRecord;
  replayed: boolean;
};

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw handymanCommercialAgreementValidationError(field);
  }
  return raw;
}

function ensureKey(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 200) {
    throw handymanCommercialAgreementValidationError('idempotencyKey');
  }
  return raw;
}

export async function prepareHandymanCommercialAgreement(
  actorUserId: string,
  input: HandymanCommercialAgreementPrepareInput,
): Promise<HandymanCommercialAgreementCommandResult> {
  const actor = ensureUuid(actorUserId, 'actorUserId');
  const clientId = ensureUuid(input.clientId, 'clientId');
  const idempotencyKey = ensureKey(input.idempotencyKey);

  return withTransaction(async (client: PoolClient) => {
    const clientRow = await client.query(
      'SELECT id FROM clients WHERE id = $1 FOR UPDATE',
      [clientId],
    );
    if (clientRow.rows.length === 0) {
      throw handymanCommercialAgreementValidationError('clientId');
    }

    let agreement = await repo.findAgreementByClientId(client, clientId);
    if (!agreement) {
      agreement = await repo.createAgreement(client, {
        clientId,
        createdByUserId: actor,
      });
    }

    const replay = await repo.findEventByIdempotency(
      client,
      agreement.id,
      'PREPARE',
      idempotencyKey,
    );
    if (replay) {
      const version = await repo.findVersionById(client, replay.versionId);
      if (!version) {
        throw handymanCommercialAgreementVersionNotFoundError();
      }
      return { agreement, version, event: replay, replayed: true };
    }

    const versionNumber = await repo.nextVersionNumber(client, agreement.id);
    const version = await repo.insertVersion(client, {
      agreementId: agreement.id,
      versionNumber,
      createdByUserId: actor,
    });
    const event = await repo.insertEvent(client, {
      clientId,
      agreementId: agreement.id,
      versionId: version.id,
      eventType: 'PREPARE',
      idempotencyKey,
      actorUserId: actor,
    });
    return { agreement, version, event, replayed: false };
  });
}

export async function activateHandymanCommercialAgreementVersion(
  actorUserId: string,
  input: HandymanCommercialAgreementActivateInput,
): Promise<HandymanCommercialAgreementCommandResult> {
  const actor = ensureUuid(actorUserId, 'actorUserId');
  const versionId = ensureUuid(input.versionId, 'versionId');
  const idempotencyKey = ensureKey(input.idempotencyKey);
  const effectiveFrom = parseHandymanAgreementTimestamp(
    input.effectiveFrom,
    'effectiveFrom',
  );

  return withTransaction(async (client: PoolClient) => {
    const version = await repo.findVersionById(client, versionId);
    if (!version) {
      throw handymanCommercialAgreementVersionNotFoundError();
    }
    // Serialize on the agreement root: every mutation of one
    // agreement takes this lock first (single-lock ordering, no
    // deadlock pairs).
    const locked = await repo.findAgreementByClientId(
      client,
      version.clientId,
      true,
    );
    if (!locked || locked.id !== version.agreementId) {
      throw handymanCommercialAgreementNotFoundError();
    }

    const replay = await repo.findEventByIdempotency(
      client,
      version.agreementId,
      'ACTIVATE',
      idempotencyKey,
    );
    if (replay) {
      const current = await repo.findVersionById(client, versionId);
      if (!current || current.status !== 'ACTIVE') {
        throw handymanCommercialAgreementIllegalTransitionError(
          current?.status ?? 'DRAFT',
          'ACTIVATE',
        );
      }
      return {
        agreement: locked,
        version: current,
        event: replay,
        replayed: true,
      };
    }

    const nextStatus = nextHandymanCommercialAgreementVersionStatus(
      version.status,
      'ACTIVATE',
    );
    const active = await repo.findActiveVersion(client, version.agreementId);
    if (active) {
      throw handymanCommercialAgreementActiveExistsError(version.agreementId);
    }

    const updated = await repo.updateVersionLifecycle(client, versionId, {
      status: nextStatus,
      effectiveFrom,
    });
    const event = await repo.insertEvent(client, {
      clientId: version.clientId,
      agreementId: version.agreementId,
      versionId,
      eventType: 'ACTIVATE',
      idempotencyKey,
      actorUserId: actor,
    });
    return { agreement: locked, version: updated, event, replayed: false };
  });
}

export async function supersedeHandymanCommercialAgreementVersion(
  actorUserId: string,
  input: HandymanCommercialAgreementSupersedeInput,
): Promise<HandymanCommercialAgreementCommandResult> {
  const actor = ensureUuid(actorUserId, 'actorUserId');
  const versionId = ensureUuid(input.versionId, 'versionId');
  const replacementVersionId = ensureUuid(
    input.replacementVersionId,
    'replacementVersionId',
  );
  const idempotencyKey = ensureKey(input.idempotencyKey);
  const effectiveFrom = parseHandymanAgreementTimestamp(
    input.effectiveFrom,
    'effectiveFrom',
  );
  if (versionId === replacementVersionId) {
    throw handymanCommercialAgreementValidationError(
      'replacementVersionId',
    );
  }

  return withTransaction(async (client: PoolClient) => {
    const current = await repo.findVersionById(client, versionId);
    if (!current) {
      throw handymanCommercialAgreementVersionNotFoundError();
    }
    const locked = await repo.findAgreementByClientId(
      client,
      current.clientId,
      true,
    );
    if (!locked || locked.id !== current.agreementId) {
      throw handymanCommercialAgreementNotFoundError();
    }

    const replay = await repo.findEventByIdempotency(
      client,
      current.agreementId,
      'SUPERSEDE',
      idempotencyKey,
    );
    if (replay) {
      const replacement = await repo.findVersionById(
        client,
        replacementVersionId,
      );
      if (!replacement || replacement.status !== 'ACTIVE') {
        throw handymanCommercialAgreementIllegalTransitionError(
          replacement?.status ?? 'DRAFT',
          'SUPERSEDE',
        );
      }
      return {
        agreement: locked,
        version: replacement,
        event: replay,
        replayed: true,
      };
    }

    // Guards (frozen §5): the closed row must be the ACTIVE one; the
    // replacement must be a DRAFT sibling of the SAME agreement; the
    // window must move strictly forward.
    nextHandymanCommercialAgreementVersionStatus(current.status, 'SUPERSEDE');
    if (current.effectiveFrom === null) {
      throw handymanCommercialAgreementIllegalTransitionError(
        current.status,
        'SUPERSEDE',
      );
    }
    const replacement = await repo.findVersionById(
      client,
      replacementVersionId,
    );
    if (!replacement) {
      throw handymanCommercialAgreementVersionNotFoundError();
    }
    if (replacement.agreementId !== current.agreementId) {
      throw handymanCommercialAgreementClientConflictError(
        current.clientId,
      );
    }
    nextHandymanCommercialAgreementVersionStatus(
      replacement.status,
      'ACTIVATE',
    );
    assertHandymanAgreementSupersessionWindow(
      current.effectiveFrom,
      effectiveFrom,
    );

    await repo.updateVersionLifecycle(client, versionId, {
      status: 'SUPERSEDED',
      effectiveTo: effectiveFrom,
    });
    const activated = await repo.updateVersionLifecycle(
      client,
      replacementVersionId,
      { status: 'ACTIVE', effectiveFrom },
    );
    const event = await repo.insertEvent(client, {
      clientId: current.clientId,
      agreementId: current.agreementId,
      versionId,
      eventType: 'SUPERSEDE',
      idempotencyKey,
      actorUserId: actor,
    });
    return {
      agreement: locked,
      version: activated,
      event,
      replayed: false,
    };
  });
}

/**
 * Fail-closed as-of resolution (frozen §4.5/§5): resolve the EXACT
 * effective version at an instant or fail with a bounded conflict.
 * No implicit "current agreement"; DRAFT never resolves; SUPERSEDED
 * rows resolve only for their own historical window, which is what
 * lets PART 02+ consumers bind a version id and keep the binding
 * stable.
 */
export async function resolveHandymanCommercialAgreementAt(
  clientId: string,
  asOf: string,
): Promise<HandymanCommercialAgreementVersionRecord> {
  const client = ensureUuid(clientId, 'clientId');
  const instant = parseHandymanAgreementTimestamp(asOf, 'asOf');
  const version = await repo.resolveEffectiveVersionAt(
    getPool(),
    client,
    instant,
  );
  if (!version) {
    throw handymanCommercialAgreementNotEffectiveAtAsOfError(
      instant.toISOString(),
    );
  }
  return version;
}
