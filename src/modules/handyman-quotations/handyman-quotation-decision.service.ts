import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { buildingAccessDeniedError } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { handymanServiceRequestRepository } from '../handyman-requests';
import { assertQuotationThreadBuildingAccess }
  from './handyman-quotation-access';
import { handymanExecutionScopeRepository }
  from './handyman-execution-scope.repository';
import {
  buildExecutionScopeInput,
  handymanExecutionScopeConflictError,
  toPublicExecutionScope,
} from './handyman-execution-scope.service';
import type {
  HandymanExecutionScopeActor,
  PublicHandymanExecutionScope,
} from './handyman-execution-scope.types';
import { handymanQuotationRepository } from './handyman-quotation.repository';
import { handymanQuotationDecisionRepository }
  from './handyman-quotation-decision.repository';
import {
  handymanQuotationInvalidTransitionError,
  handymanQuotationNotFoundError,
  handymanQuotationVersionNotFoundError,
} from './handyman-quotation.errors';
import {
  HANDYMAN_QUOTATION_DECISIONS,
  type DecideHandymanQuotationInput,
  type HandymanQuotationDecision,
  type HandymanQuotationDecisionActor,
  type HandymanQuotationDecisionRecord,
  type PublicHandymanQuotationDecision,
} from './handyman-quotation-decision.types';

/**
 * CR-HM-06 PART 04 — customer approval / rejection service (FROZEN F6/F7/F8),
 * and its W03 PART 03E PIC extension (A01 §10.3 C1/C2, §8 MC1′–MC3,
 * ADD-A R-1.1/B11/B16).
 *
 * The frozen decision sequence is unchanged and remains the ONLY implementation
 * of it in this repository: lock the exact version → verify ISSUED + validity
 * against the server clock → derive customer context from the request lineage,
 * never from the caller → replay-or-conflict on key + fingerprint → immutable
 * decision insert → bounded lifecycle projection → APPROVE-only Execution Scope
 * → journal, all inside one transaction (F7/F8). What 03E changed is who may
 * enter it, and from where the actor is taken:
 *
 *   - A PIC enters through a credential and a binding, not through an identity.
 *     The `TENANT_PIC` arm is assembled by `handyman-pic-portal` from the
 *     workspace session and the thread's own ACTIVE binding; the decision body
 *     stays `{decision}` plus the idempotency header (ADD-A B11), so there is no
 *     field in which to name a PIC, a tenant or a binding.
 *   - A staff principal cannot record a new decision at all (§10.4 S1,
 *     owner-ratified). `decideHandymanQuotation` refuses before a transaction is
 *     opened, and the ledger's own INSERT guard independently refuses a `USER`
 *     row, so the soft-close is a controlled 403 on the surface with a DB floor
 *     underneath it — not a permission gap to provision around. Historical
 *     `USER` rows are untouched and stay readable (§6.3, A9).
 *   - Replay is actor-checked (C2). Same key + same fingerprint + same decision
 *     is no longer sufficient: the replaying principal must be the same actor for
 *     the same tenant, or the row is not the caller's to replay and the answer is
 *     409 without saying what the recorded decision was.
 *
 * MC1′ is evaluated here as well as in the guard, which is what MC2 asks for:
 * this service exists to return a proper error, the guard exists so no future
 * caller can bypass the rule. The two id namespaces are never compared to each
 * other directly — they meet only through `tenant_pics.user_id`, and an unlinked
 * PIC is the legitimate state MC4 records rather than a licence to skip the
 * check.
 */

function assertUuid(value: string | undefined, field: string): void {
  if (value === undefined || !isValidUuid(value)) {
    throw AppError.validation('Quotation decision validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
}

function decisionConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_DECISION_CONFLICT,
    message:
      'Conflicting replay or a second different decision for this quotation version.',
    statusCode: 409,
  });
}

/**
 * W03 PART 03E — the answer when a decision cannot be recorded against this
 * version for an authority reason: no ACTIVE binding, a lapsed binding window, a
 * binding conferring another PIC, a read-capable credential, lapsed occupancy,
 * maker-checker, or a thread whose presentation is no longer current.
 *
 * MC3 fixes the shape: reuse `HANDYMAN_QUOTATION_DECISION_CONFLICT`, because "a
 * decision that cannot be recorded against this version" is the same diagnostic
 * class as a replay or second-decision conflict, and a code per reason would
 * hand a caller a taxonomy to enumerate. The reason itself is available — that
 * is what 03D's eligibility read exists for, on the surface designed to carry
 * non-sensitive reasons.
 */
export function picDecisionRefusedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_DECISION_CONFLICT,
    message:
      'This Tenant PIC workspace session cannot record a decision against this quotation version.',
    statusCode: 409,
  });
}

/**
 * §10.4 S1 soft-close. `PERMISSION_DENIED` is an existing code: C15 forbids
 * minting a decide-specific one, and "your actor class is not the approving
 * class" is a policy fact about the caller, not a conflict about the version —
 * which is why the staff surface answers 403 while a PIC whose own facts do not
 * add up answers 409.
 */
export function staffApprovalForbiddenError(): AppError {
  return new AppError({
    code: ERROR_CODES.PERMISSION_DENIED,
    message:
      'Quotation approval is a Tenant PIC authority; a staff principal cannot record a new decision.',
    statusCode: 403,
  });
}

function decisionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_DECISION_NOT_FOUND,
    message: 'No decision exists for this quotation version.',
    statusCode: 404,
  });
}

/** sha256-hex fingerprint of the canonical decision payload (F7). */
function decisionFingerprint(
  quotationVersionId: string,
  decision: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([quotationVersionId, decision]))
    .digest('hex');
}

function toPublicDecision(
  row: HandymanQuotationDecisionRecord,
): PublicHandymanQuotationDecision {
  return {
    id: row.id,
    clientId: row.clientId,
    quotationId: row.quotationId,
    quotationVersionId: row.quotationVersionId,
    decision: row.decision,
    tenantCompanyId: row.tenantCompanyId,
    tenantPicId: row.tenantPicId,
    // Actor class first, then the id of that class (§6.3): a consumer can tell
    // "a PIC signed this and a PIC has no user id" from "unknown actor", and a
    // null is never the only signal that a column was empty by design.
    decidedByUserId: row.decidedByUserId,
    decisionActorType: row.decisionActorType,
    decidedByTenantPicId: row.decidedByTenantPicId,
    decidedByPicSessionId: row.decidedByPicSessionId,
    approvalBindingId: row.approvalBindingId,
    idempotencyKey: row.idempotencyKey,
    decidedAt: row.decidedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The ledger guard (`0438`/`0442`) refuses an incoherent INSERT with a CHECK
 * violation, and a failed FK with 23503. A refusal of that floor is NOT a server
 * error: it is a decision that cannot be recorded, and a caller must be able to
 * tell that apart from an outage — which is the whole of 03E item 10, applied to
 * both surfaces. The DB text is deliberately not copied into the response.
 */
/**
 * Lock contention with a concurrent binding act is answered the same way, and
 * that needs its own sentence because it is the one place where two documented
 * lock orders meet.
 *
 * 03B's bind path locks the thread's ACTIVE binding BEFORE the PIC workspace
 * sessions it must revoke; the decide path runs inside the session seam, so it
 * holds the session lock and then takes `FOR SHARE` on that same binding (the
 * share lock is what closes ADD-A B11's revoke-race: without it, a revoke and a
 * decision could each commit against the other's stale read). Session → binding
 * against binding → session is a cycle, and Postgres resolves a cycle by
 * aborting one side with `40P01`.
 *
 * The resolution chosen is neither to drop the share lock (that would reopen the
 * race B11 names) nor to invert the seam (the session lock is what makes the
 * credential's authority stable across the write). A deadlock here means exactly
 * one thing to a caller — "a concurrent act on this thread's authority made this
 * decision unrecordable" — which is the conflict this route already answers, so it
 * is mapped to 409 and the transaction rolls back whole. The retry is safe by
 * construction: same key, same decision, and the version lock means only one of
 * the two racing submits can ever write.
 */
function asDecisionRefusal(error: unknown): unknown {
  const code = (error as { code?: string }).code;
  if (
    code === '23514' ||
    code === '23503' ||
    code === '40P01' ||
    code === '40001'
  ) {
    return picDecisionRefusedError();
  }
  return error;
}

/**
 * The input validation both arms share (F7): the decision vocabulary, and the
 * idempotency key as a required, trimmed, bounded header value. Exported for the
 * PIC route so a body is parsed the same way on both surfaces; it is not a hook
 * for a second write path.
 */
export function assertQuotationDecisionInput(
  input: DecideHandymanQuotationInput,
): { decision: HandymanQuotationDecision; idempotencyKey: string } {
  if (
    !(HANDYMAN_QUOTATION_DECISIONS as readonly string[]).includes(
      input.decision,
    )
  ) {
    throw AppError.validation('Quotation decision validation failed.', [
      { field: 'decision', message: 'decision must be APPROVE or REJECT.' },
    ]);
  }
  const idempotencyKey =
    typeof input.idempotencyKey === 'string'
      ? input.idempotencyKey.trim()
      : '';
  if (idempotencyKey.length < 1 || idempotencyKey.length > 200) {
    throw AppError.validation('Quotation decision validation failed.', [
      {
        field: 'idempotencyKey',
        message: 'idempotencyKey is required (1-200 characters).',
      },
    ]);
  }
  return { decision: input.decision, idempotencyKey };
}

/**
 * The authority half of a PIC decision, read UNDER the version lock rather than
 * trusted from the request. The binding must be ACTIVE, in force at this
 * instant, on THIS thread, for THIS tenant, and conferring exactly the signing
 * PIC; the PIC must be ACTIVE in that tenant. Every one of those clauses is
 * re-derived by the guard as well — this function exists so the caller gets a
 * controlled 409 instead of a rolled-back insert, and so the read of the
 * authority and the write of the decision cannot straddle two snapshots.
 */
function toEpochMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

async function loadPicDecisionAuthority(
  tx: PoolClient,
  args: {
    approvalBindingId: string;
    tenantPicId: string;
    tenantCompanyId: string;
    quotationId: string;
    quotationVersionId: string;
    now: Date;
  },
): Promise<void> {
  // The version row is already locked FOR UPDATE by the caller; this reads the
  // authorship half of MC1' from it rather than re-locking. `FOR SHARE OF b`
  // serializes against 03B's revoke (which takes the session lock and then the
  // binding FOR UPDATE), and that shared order is why no cycle exists: nothing
  // in this path takes a row lock on `tenant_pics` or `tenant_companies`, whose
  // own revocation triggers lock session rows and could otherwise meet this one
  // in the opposite direction.
  const result = await tx.query<
    Record<string, string | null> & {
      effective_from: Date | string | null;
      effective_until: Date | string | null;
    }
  >(
    `SELECT b.status, b.quotation_id, b.tenant_company_id, b.tenant_pic_id,
            b.effective_from, b.effective_until, b.granted_by_user_id,
            p.status AS pic_status, p.tenant_company_id AS pic_tenant,
            p.user_id AS pic_user,
            v.created_by_user_id AS version_author,
            q.created_by_user_id AS root_author
       FROM handyman_quotation_approval_bindings b
       JOIN handyman_quotation_versions v ON v.id = $2
       JOIN handyman_quotations q ON q.id = v.quotation_id
       LEFT JOIN tenant_pics p ON p.id = b.tenant_pic_id
      WHERE b.id = $1
      FOR SHARE OF b`,
    [args.approvalBindingId, args.quotationVersionId],
  );
  const row = result.rows[0];
  if (!row || row.status !== 'ACTIVE') throw picDecisionRefusedError();
  // Any lock wait inside this statement is resolved by `asDecisionRefusal` at the
  // caller: see the note there for why a `40P01` against a concurrent bind or
  // revoke is a conflict on this route and never a 500.
  const at = args.now.getTime();
  const from = toEpochMs(row.effective_from);
  const until = toEpochMs(row.effective_until);
  if ((from !== null && from > at) || (until !== null && until <= at)) {
    throw picDecisionRefusedError();
  }
  if (
    row.quotation_id !== args.quotationId ||
    row.tenant_company_id !== args.tenantCompanyId ||
    row.tenant_pic_id !== args.tenantPicId
  ) {
    throw picDecisionRefusedError();
  }
  if (row.pic_status !== 'ACTIVE' || row.pic_tenant !== args.tenantCompanyId) {
    throw picDecisionRefusedError();
  }
  // MC1′, service half (MC2): M = root author ∪ version author ∪ the user who
  // chose the signer; C = the signing PIC and its linked user.
  const checker = row.pic_user;
  if (
    checker !== null &&
    checker !== undefined &&
    (checker === row.root_author ||
      checker === row.version_author ||
      checker === row.granted_by_user_id)
  ) {
    throw picDecisionRefusedError();
  }
}

/**
 * The frozen write sequence, inside ONE transaction the caller owns.
 *
 * Every arm reaches the ledger through here, so there is exactly one
 * implementation of "insert decision → project lifecycle → create scope →
 * journal". A second copy would be a second authority for F8's atomicity, and
 * the point of 03E is that the PIC path rides the existing authority rather
 * than standing next to it.
 */
async function writeQuotationDecision(
  tx: PoolClient,
  args: {
    quotationVersionId: string;
    decision: HandymanQuotationDecision;
    idempotencyKey: string;
    actor: HandymanQuotationDecisionActor;
    /** Credential-named tenant; `null` on the staff arm, which never writes. */
    tenantCompanyId: string | null;
    /** Required for a PIC decision; the binding this decision stands on. */
    approvalBindingId: string | null;
    /** The thread root, for the PIC cross-checks. */
    quotationId: string;
    now: Date;
  },
): Promise<HandymanQuotationDecisionResult> {
  const fingerprint = decisionFingerprint(
    args.quotationVersionId,
    args.decision,
  );

  // 1) Exact version lock (F7) + lineage authority.
  const version = await handymanQuotationRepository.lockVersionById(
    tx,
    args.quotationVersionId,
  );
  if (!version) throw handymanQuotationVersionNotFoundError();
  const quotation = await handymanQuotationRepository.findQuotationById(
    tx,
    version.quotationId,
  );
  if (!quotation) throw handymanQuotationNotFoundError();

  // 2) One authoritative decision per version: replay or conflict.
  const existing = await handymanQuotationDecisionRepository
    .lockDecisionByVersion(tx, version.id);
  if (existing) {
    // C2: the replaying principal must be the actor the row belongs to.
    const sameActor =
      args.actor.kind === 'USER'
        ? existing.decisionActorType === 'USER' &&
          existing.decidedByUserId === args.actor.userId
        : existing.decisionActorType === 'TENANT_PIC' &&
          existing.decidedByTenantPicId === args.actor.tenantPicId &&
          existing.tenantCompanyId === args.tenantCompanyId;
    if (
      sameActor &&
      existing.idempotencyKey === args.idempotencyKey &&
      existing.requestFingerprint === fingerprint &&
      existing.decision === args.decision
    ) {
      // Replay-safe: the ORIGINAL authoritative facts, nothing new.
      const priorScope = await handymanExecutionScopeRepository
        .findScopeByApprovedVersion(tx, version.id);
      return {
        ...toPublicDecision(existing),
        executionScope: priorScope
          ? toPublicExecutionScope(priorScope)
          : null,
      };
    }
    throw decisionConflictError();
  }

  // 3) Eligibility: presentation state is server-authoritative (F6). Evaluated
  //    against the caller-supplied server instant, never a client clock.
  if (version.status !== 'ISSUED') {
    throw handymanQuotationInvalidTransitionError();
  }
  if (!version.validUntil || version.validUntil.getTime() <= args.now.getTime()) {
    throw handymanQuotationInvalidTransitionError();
  }

  // 4) Customer context from the authoritative request lineage only.
  const request = await handymanServiceRequestRepository.findById(
    tx,
    quotation.handymanRequestId,
  );
  if (!request) throw handymanQuotationNotFoundError();
  if (
    args.tenantCompanyId !== null &&
    request.tenantCompanyId !== args.tenantCompanyId
  ) {
    // Unreachable from the PIC route, which resolves the version through its own
    // credential predicate: a body carries no tenant field. It stays checked
    // here because the engine is exported, and the answer for an incoherent
    // context is the same controlled refusal a lapsed binding gets — never a 500
    // and never a statement about whose thread it is.
    throw picDecisionRefusedError();
  }

  // 5) PIC authority + maker-checker, under the lock this transaction holds.
  if (args.actor.kind === 'TENANT_PIC') {
    // Wrapped because the authority read is the statement that WAITS: it is the
    // `FOR SHARE OF b` that can lose a deadlock race against a concurrent bind or
    // revoke, and losing must be reported as the same controlled conflict.
    try {
      await loadPicDecisionAuthority(tx, {
        approvalBindingId: args.approvalBindingId as string,
        tenantPicId: args.actor.tenantPicId,
        tenantCompanyId: args.tenantCompanyId as string,
        quotationId: quotation.id,
        quotationVersionId: version.id,
        now: args.now,
      });
    } catch (error) {
      throw asDecisionRefusal(error);
    }
  }

  // 6) Immutable decision insert.
  let record: HandymanQuotationDecisionRecord;
  try {
    record = await handymanQuotationDecisionRepository.insertDecision(tx, {
      clientId: quotation.clientId,
      quotationId: quotation.id,
      quotationVersionId: version.id,
      decision: args.decision,
      tenantCompanyId: request.tenantCompanyId,
      tenantPicId: request.tenantPicId,
      actor: args.actor,
      idempotencyKey: args.idempotencyKey,
      requestFingerprint: fingerprint,
    });
  } catch (error) {
    // UNIQUE(version)/UNIQUE(idempotency_key) race: a concurrent first decision
    // or cross-version key reuse → conflict (F7). A CHECK/FK refusal from the
    // guard is a controlled refusal, not a server error.
    if ((error as { code?: string }).code === '23505') {
      throw decisionConflictError();
    }
    throw asDecisionRefusal(error);
  }

  const status = args.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  const projection = await handymanQuotationRepository.updateVersionLifecycle(
    tx,
    version.id,
    status,
    undefined,
  );
  if (!projection) throw handymanQuotationVersionNotFoundError();

  // PART 05 (F8/F9): APPROVE-only Execution Scope creation, same transaction.
  // REJECT never reaches this branch (E5), and E1's "only by an APPROVE" is why
  // no other code path may call `insertScope` at all.
  let scope: PublicHandymanExecutionScope | null = null;
  if (args.decision === 'APPROVE') {
    const scopeActor: HandymanExecutionScopeActor =
      args.actor.kind === 'USER'
        ? { kind: 'USER', userId: args.actor.userId }
        : {
            kind: 'TENANT_PIC',
            tenantPicId: args.actor.tenantPicId,
            picSessionId: args.actor.picSessionId,
          };
    const scopeInput = await buildExecutionScopeInput({
      clientId: quotation.clientId,
      handymanRequestId: request.id,
      channelAttributionId: request.channelAttributionId,
      quotationId: quotation.id,
      approvedQuotationVersionId: version.id,
      quotationDecisionId: record.id,
      tenantCompanyId: request.tenantCompanyId,
      tenantPicId: request.tenantPicId,
      derivedBuildingId: request.buildingId,
      derivedSpaceId: request.spaceId,
      actor: scopeActor,
      decisionTenantPicId: record.decidedByTenantPicId,
    });
    let scopeRow;
    try {
      scopeRow = await handymanExecutionScopeRepository.insertScope(
        tx,
        scopeInput,
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw handymanExecutionScopeConflictError();
      }
      throw asDecisionRefusal(error);
    }
    scope = toPublicExecutionScope(scopeRow);
    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        eventType: 'HANDYMAN_EXECUTION_SCOPE_CREATED',
        entityType: 'HANDYMAN_EXECUTION_SCOPE',
        entityId: scopeRow.id,
        // C12: a PIC approval journals with `actor_user_id = NULL`. Inventing a
        // staff actor to fill that column is the leak this amendment exists to
        // close, so the id is recorded in metadata instead.
        actorUserId: args.actor.kind === 'USER' ? args.actor.userId : null,
        summary: `Handyman execution scope created for quotation version ${version.versionNumber}.`,
        metadata: {
          executionScopeId: scopeRow.id,
          quotationId: quotation.id,
          quotationVersionId: version.id,
          versionNumber: version.versionNumber,
          decisionId: record.id,
          handymanRequestId: request.id,
          tenantCompanyId: request.tenantCompanyId,
          buildingId: scopeRow.buildingId,
          spaceId: scopeRow.spaceId,
          createdByActorType: scopeRow.createdByActorType,
          ...(scopeRow.createdByTenantPicId
            ? { createdByTenantPicId: scopeRow.createdByTenantPicId }
            : {}),
          ...(scopeRow.createdByPicSessionId
            ? { createdByPicSessionId: scopeRow.createdByPicSessionId }
            : {}),
        },
      },
      tx,
    );
  }

  // 7) Audit-only journal.
  await recordOperationalEvent(
    {
      clientId: quotation.clientId,
      eventType:
        args.decision === 'APPROVE'
          ? 'HANDYMAN_QUOTATION_APPROVED'
          : 'HANDYMAN_QUOTATION_REJECTED',
      entityType: 'HANDYMAN_QUOTATION_VERSION',
      entityId: version.id,
      actorUserId: args.actor.kind === 'USER' ? args.actor.userId : null,
      summary: `Handyman quotation version ${version.versionNumber} ${status.toLowerCase()} by customer decision.`,
      metadata: {
        quotationId: quotation.id,
        quotationVersionId: version.id,
        versionNumber: version.versionNumber,
        decisionId: record.id,
        decision: args.decision,
        handymanRequestId: quotation.handymanRequestId,
        tenantCompanyId: request.tenantCompanyId,
        tenantPicId: request.tenantPicId,
        // C12: actor class plus the two PIC ids, and nothing else — no token,
        // no name, no contact detail. Event type names are unchanged from
        // PART 04 on purpose; this PART does not widen the audit vocabulary.
        decisionActorType: record.decisionActorType,
        ...(record.decidedByTenantPicId
          ? { decidedByTenantPicId: record.decidedByTenantPicId }
          : {}),
        ...(record.decidedByPicSessionId
          ? { sessionId: record.decidedByPicSessionId }
          : {}),
        ...(record.approvalBindingId
          ? { approvalBindingId: record.approvalBindingId }
          : {}),
      },
    },
    tx,
  );
  return { ...toPublicDecision(record), executionScope: scope };
}

/**
 * The result of a decision: the immutable decision row, plus the Execution Scope
 * its APPROVE created in the same transaction (PART 05 widening, F8/F9).
 */
export type HandymanQuotationDecisionResult =
  PublicHandymanQuotationDecision & {
    executionScope: PublicHandymanExecutionScope | null;
  };

/**
 * W03 PART 03E — the PIC decision write, run inside the credential's own
 * transaction (`withPicWorkspaceSession` in `handyman-pic-portal`).
 *
 * Taking the caller's `tx` rather than opening one is deliberate: the session
 * verification, the version lock, the eligibility revalidation and the ledger
 * write then share a single snapshot, so a revocation or a lapsed binding that
 * lands mid-flight cannot slip between them. The seam re-verifies the session
 * AFTER this function returns, still in the same transaction, which is R7's
 * authority-then-session ordering and 03E item 6 in one shape.
 */
export async function recordPicQuotationDecision(
  tx: PoolClient,
  args: {
    quotationVersionId: string;
    decision: HandymanQuotationDecision;
    idempotencyKey: string;
    tenantCompanyId: string;
    tenantPicId: string;
    picSessionId: string;
    approvalBindingId: string;
    quotationId: string;
    now: Date;
  },
): Promise<HandymanQuotationDecisionResult> {
  assertUuid(args.quotationVersionId, 'quotationVersionId');
  assertUuid(args.tenantCompanyId, 'tenantCompanyId');
  assertUuid(args.tenantPicId, 'tenantPicId');
  assertUuid(args.picSessionId, 'picSessionId');
  assertUuid(args.approvalBindingId, 'approvalBindingId');
  return writeQuotationDecision(tx, {
    quotationVersionId: args.quotationVersionId,
    decision: args.decision,
    idempotencyKey: args.idempotencyKey,
    tenantCompanyId: args.tenantCompanyId,
    approvalBindingId: args.approvalBindingId,
    quotationId: args.quotationId,
    now: args.now,
    actor: {
      kind: 'TENANT_PIC',
      tenantPicId: args.tenantPicId,
      picSessionId: args.picSessionId,
      approvalBindingId: args.approvalBindingId,
    },
  });
}

/**
 * Explicit customer decision (APPROVE | REJECT) against the exact ISSUED
 * version — the STAFF surface, soft-closed by W03 PART 03E per A01 §10.4 S1
 * (owner-ratified).
 *
 * The refusal lands after argument validation and before any query, so a staff
 * caller cannot use this path to probe a version's state, and cannot half-write
 * anything. `Deprecation` and the successor `Link` are set at the route so the
 * header is present on the refusal too; removal of the route is a later
 * housekeeping PART, and `GET` history stays open (C8).
 */
export async function decideHandymanQuotation(
  quotationVersionId: string,
  input: DecideHandymanQuotationInput,
  actorUserId: string,
): Promise<HandymanQuotationDecisionResult> {
  assertUuid(quotationVersionId, 'quotationVersionId');
  assertUuid(actorUserId, 'actorUserId');
  assertQuotationDecisionInput(input);
  throw staffApprovalForbiddenError();
}

/** Exact read of the immutable decision for a version (404 when none). */
export async function getHandymanQuotationDecision(
  quotationVersionId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationDecision> {
  assertUuid(quotationVersionId, 'quotationVersionId');
  assertUuid(actorUserId, 'actorUserId');
  const record = await handymanQuotationDecisionRepository
    .findDecisionByVersion(undefined, quotationVersionId);
  if (!record) throw decisionNotFoundError();
  // CR-HM-SEC-01 PART 02: building-scope authority traced through the
  // decision's quotation thread to the parent request's building_id
  // (BE-02G; no same-Client shortcut). A missing thread root is denied
  // exactly like an inaccessible Building (no existence leak).
  const quotation = await handymanQuotationRepository.findQuotationById(
    undefined,
    record.quotationId,
  );
  if (!quotation) throw buildingAccessDeniedError();
  await assertQuotationThreadBuildingAccess(
    undefined as never,
    quotation,
    actorUserId,
  );
  return toPublicDecision(record);
}
