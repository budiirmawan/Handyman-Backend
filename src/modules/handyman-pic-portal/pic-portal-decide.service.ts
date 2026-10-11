import { AppError } from '../../shared/errors';
import {
  handymanQuotationApprovalBindingRepository as bindings,
} from '../handyman-quotation-approval-bindings';
import {
  assertQuotationDecisionInput,
  picDecisionRefusedError,
  recordPicQuotationDecision,
  type HandymanQuotationDecisionResult,
} from '../handyman-quotations';
import {
  picWorkspaceResourceNotFound,
  withPicWorkspaceSession,
  type PicWorkspacePrincipal,
} from '../handyman-pic-session';
import {
  evaluatePicApprovalEligibility,
  type PicPortalDecisionRequestBody,
  type PicPortalEligibilityCode,
  type PublicPicPortalDecision,
  type PublicPicPortalDecisionWrite,
  type PublicPicPortalExecutionScope,
} from './pic-portal.types';
import {
  findCurrentOccupancyStatus,
  findDecisionByVersion,
  findVersionForCredential,
  type PicPortalDecisionRow,
  type PicPortalVersionRow,
} from './pic-portal.repository';

/**
 * W03 PART 03E — the Tenant PIC decision write (A01 §6.2/§9, §8 MC1′–MC3,
 * ADD-A B11/B16/B17/R-1.1).
 *
 * This file is the ONLY way a PIC records an APPROVE or REJECT, and it writes
 * through the existing authority rather than beside it: it resolves the target,
 * revalidates eligibility, and then calls `recordPicQuotationDecision` — the
 * same in-transaction engine the staff path used before it was soft-closed — so
 * "decision + lifecycle projection + Execution Scope + journal, atomically" is
 * still one implementation in this repository (E1/E3).
 *
 * Three orderings carry the whole design, and each is here for a reason:
 *
 *   1. ONE TRANSACTION, OWNED BY THE SESSION SEAM. `withPicWorkspaceSession`
 *      verifies the credential, runs this work, and re-verifies the session
 *      again before commit. Because the work shares that transaction, a
 *      revocation or a binding revoke that lands mid-flight cannot slip between
 *      the authorization and the write.
 *   2. LOCK FIRST, THEN JUDGE. The version is read through the credential
 *      predicate with `FOR UPDATE` — not `FOR SHARE` — so the ledger engine's own
 *      `FOR UPDATE` is a no-op re-lock instead of a lock upgrade that two
 *      concurrent PIC sessions could deadlock over. Everything after this line is
 *      evaluated against a row nobody else can change.
 *   3. JUDGE TWICE. Eligibility is evaluated before the write so a caller gets a
 *      typed 409 with the 03D reason vocabulary instead of a rolled-back insert,
 *      and the AUTHORITY half is evaluated again after it, under the locks, so a
 *      revoke that landed after the first pass still cannot produce a recorded
 *      decision. The second pass deliberately excludes the version-state half:
 *      we have just set that state ourselves, and judging our own projection with
 *      a rule written for the pre-decision snapshot would refuse every decision.
 *
 * Refusals are 409 `HANDYMAN_QUOTATION_DECISION_CONFLICT` — MC3, and C15 forbids
 * minting a code — including for a read-capable credential, because §9 gives this
 * route exactly 201/401/404/409 and "your credential may not decide" is a fact
 * the 03D eligibility read exists to explain. 404 is reserved for the thread that
 * is not this credential's at all, so the two stay distinguishable by cause and
 * a foreign id never becomes an existence signal.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DECISIONS = ['APPROVE', 'REJECT'] as const;

function assertVersionId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw AppError.validation('PIC decision validation failed.', [
      { field: 'quotationVersionId', message: 'quotationVersionId must be a UUID.' },
    ]);
  }
  return value.toLowerCase();
}

/**
 * The body whitelist (B11: `{decision}` and nothing else). The shared bearer seam
 * cannot do this for a POST — it refuses EVERY body, which is right for the three
 * GETs and impossible for this one — so the route enforces the same rule itself:
 * a key that is not `decision` is refused with the same 400 the reads use for a
 * query-string context, because in both cases the caller is trying to supply
 * context the credential is supposed to select.
 */
export function parsePicDecisionBody(
  body: unknown,
): PicPortalDecisionRequestBody {
  const rejects = () => {
    throw AppError.validation('PIC decision validation failed.', [
      {
        field: 'body',
        message: 'This endpoint accepts a JSON object with exactly one key: decision.',
      },
    ]);
  };
  if (!body || typeof body !== 'object' || Array.isArray(body)) rejects();
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== 'decision') rejects();
  const decision = (body as { decision?: unknown }).decision;
  if (typeof decision !== 'string' || !(DECISIONS as readonly string[]).includes(decision)) {
    throw AppError.validation('PIC decision validation failed.', [
      { field: 'decision', message: 'decision must be APPROVE or REJECT.' },
    ]);
  }
  return { decision: decision as PicPortalDecisionRequestBody['decision'] };
}

function idempotencyKeyOf(header: string | undefined): string {
  const key = typeof header === 'string' ? header.trim() : '';
  if (key.length < 1 || key.length > 200) {
    throw AppError.validation('PIC decision validation failed.', [
      {
        field: 'idempotencyKey',
        message: 'Idempotency-Key header is required (1-200 characters).',
      },
    ]);
  }
  return key;
}

async function serverNow(
  tx: Parameters<typeof findDecisionByVersion>[0],
): Promise<Date> {
  const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  return clock.rows[0].now;
}

/** The facts the authority half is judged on, all read in THIS transaction. */
async function loadAuthorityFacts(
  tx: Parameters<typeof findDecisionByVersion>[0],
  principal: PicWorkspacePrincipal,
  version: PicPortalVersionRow,
) {
  const binding = await bindings.findActiveBinding(tx, version.quotationId);
  const picFacts = principal.tenantPicId
    ? await bindings.findTenantPicFacts(tx, principal.tenantPicId)
    : null;
  const statuses = await bindings.findTenantCompanyAndClientStatuses(
    tx,
    version.tenantCompanyId,
    version.clientId,
  );
  const now = await serverNow(tx);
  const occupancyStatus = await findCurrentOccupancyStatus(tx, {
    tenantCompanyId: version.tenantCompanyId,
    buildingId: version.buildingId,
    at: now,
  });
  return { now, binding, picFacts, statuses, occupancyStatus };
}

function projectDecision(
  result: HandymanQuotationDecisionResult,
): PublicPicPortalDecision {
  return {
    quotationDecisionId: result.id,
    decision: result.decision,
    decisionActorType: result.decisionActorType,
    decidedByTenantPicId: result.decidedByTenantPicId,
    decidedByPicSessionId: result.decidedByPicSessionId,
    approvalBindingId: result.approvalBindingId,
    decidedAt: result.decidedAt,
    // True by construction here: the engine's replay test (C2) refuses a replay by
    // any other PIC, so a row this surface returns is always this credential's
    // PIC's. A boolean keeps "was it me" from requiring the caller to compare ids.
    decidedByCaller: true,
  };
}

function projectExecutionScope(
  scope: HandymanQuotationDecisionResult['executionScope'],
): PublicPicPortalExecutionScope | null {
  if (!scope) return null;
  return {
    executionScopeId: scope.id,
    status: scope.status,
    quotationId: scope.quotationId,
    approvedQuotationVersionId: scope.approvedQuotationVersionId,
    handymanRequestId: scope.handymanRequestId,
    buildingId: scope.buildingId,
    spaceId: scope.spaceId,
    createdAt: scope.createdAt,
  };
}

/**
 * The after-the-lock half of the revalidation, plus the identity of the row that
 * was actually written. Throws the controlled 409 rather than reporting a
 * failure: everything below runs inside the decision transaction, so refusing
 * here rolls the decision, its projection, its scope and its journal back
 * together, which is exactly the atomicity F7/F8 promise needs and the reason a
 * `23505`/`23514` from the ledger guard is mapped to 409 instead of surfacing.
 */
async function assertRecordedDecisionIsCurrent(
  tx: Parameters<typeof findDecisionByVersion>[0],
  principal: PicWorkspacePrincipal,
  version: PicPortalVersionRow,
  input: { decision: PicPortalDecisionRequestBody['decision']; idempotencyKey: string },
  bindingId: string,
  result: HandymanQuotationDecisionResult,
): Promise<void> {
  const facts = await loadAuthorityFacts(tx, principal, version);
  const recorded: PicPortalDecisionRow | null = await findDecisionByVersion(
    tx,
    version.quotationVersionId,
  );
  const decidedAt = Date.parse(result.decidedAt);
  const windowFrom = facts.binding?.effectiveFrom?.getTime() ?? null;
  const windowUntil = facts.binding?.effectiveUntil?.getTime() ?? null;
  const callerPicUserId = facts.picFacts?.userId ?? null;
  const makerConflict =
    callerPicUserId !== null &&
    (callerPicUserId === version.quotationAuthorUserId ||
      callerPicUserId === version.versionAuthorUserId ||
      callerPicUserId === facts.binding?.grantedByUserId);
  if (
    !recorded ||
    recorded.quotationDecisionId !== result.id ||
    recorded.decision !== input.decision ||
    recorded.decisionActorType !== 'TENANT_PIC' ||
    recorded.decidedByTenantPicId !== principal.tenantPicId ||
    recorded.decidedByPicSessionId !== principal.sessionId ||
    recorded.approvalBindingId !== bindingId ||
    !facts.binding ||
    facts.binding.id !== bindingId ||
    facts.binding.tenantPicId !== principal.tenantPicId ||
    facts.binding.tenantCompanyId !== principal.tenantCompanyId ||
    (windowFrom !== null && windowFrom > decidedAt) ||
    (windowUntil !== null && windowUntil <= decidedAt) ||
    facts.picFacts?.status !== 'ACTIVE' ||
    facts.picFacts?.tenantCompanyId !== principal.tenantCompanyId ||
    facts.statuses.tenantStatus !== 'ACTIVE' ||
    facts.statuses.clientStatus !== 'ACTIVE' ||
    facts.occupancyStatus !== 'ACTIVE' ||
    makerConflict
  ) {
    throw picDecisionRefusedError();
  }
}

/**
 * `POST /handyman/pic/quotation-versions/:quotationVersionId/decision`.
 *
 * The caller supplies three things and no more: the bearer credential, the exact
 * version id, and `{decision}` plus `Idempotency-Key`. The tenant, the PIC, the
 * session and the binding it stands on are resolved server-side from the
 * credential (item 5), and an id that resolves to another tenant's version fails
 * with the uniform 404 of the read surface — the same predicate, so "not yours"
 * and "not there" stay one answer.
 */
export async function submitPicQuotationDecision(
  token: string,
  quotationVersionIdInput: unknown,
  body: unknown,
  idempotencyKeyHeader: string | undefined,
): Promise<PublicPicPortalDecisionWrite> {
  const quotationVersionId = assertVersionId(quotationVersionIdInput);
  const parsed = parsePicDecisionBody(body);
  // Same validation as the staff surface, so the vocabulary and the key bounds are
  // one definition and cannot drift between the two.
  const { decision, idempotencyKey } = assertQuotationDecisionInput({
    decision: parsed.decision,
    idempotencyKey: idempotencyKeyOf(idempotencyKeyHeader),
  });

  return withPicWorkspaceSession(token, async (tx, principal) => {
    // Rule 3 at the write: `canDecide` is derived from the credential by the
    // session seam itself, so a read-only admission is refused before a row is
    // locked and before any thread state is reported through an error channel.
    if (!principal.canDecide || principal.tenantPicId === null) {
      throw picDecisionRefusedError();
    }

    const version = await findVersionForCredential(tx, principal, quotationVersionId, {
      lock: 'update',
    });
    if (!version) throw picWorkspaceResourceNotFound();

    // The binding is READ here, not locked: the decision engine takes
    // `FOR SHARE OF b` after it holds the version lock, which is the same
    // session → binding order 03B's revoke uses. Locking the binding before the
    // version would invert that order for no additional safety, because the
    // ledger guard re-reads the binding at INSERT time anyway.
    const pre = await loadAuthorityFacts(tx, principal, version);
    const existing = await findDecisionByVersion(tx, version.quotationVersionId);

    // Item 6's first half, and note WHERE it runs: after the version is already
    // locked `FOR UPDATE` by the read above, so nothing a writer could change
    // between "eligible" and "written" is invisible to this evaluation. The one
    // deliberate exception: when a decision row
    // already exists, `ALREADY_DECIDED` must not pre-empt the engine's replay
    // test, because F7's replay is the SAME decision returned unchanged and it is
    // still valid after the window closes. Refusing here would turn a retry over
    // a lost response into a 409 for a decision the caller itself recorded.
    if (!existing) {
      const reasons: PicPortalEligibilityCode[] = evaluatePicApprovalEligibility({
        now: pre.now,
        canDecide: principal.canDecide,
        callerPicId: principal.tenantPicId,
        callerPicUserId: pre.picFacts?.userId ?? null,
        lineageRequestPicId: version.lineageTenantPicId,
        tenantStatus: pre.statuses.tenantStatus,
        clientStatus: pre.statuses.clientStatus,
        occupancyStatus: pre.occupancyStatus,
        binding: pre.binding
          ? {
              tenantPicId: pre.binding.tenantPicId,
              grantedByUserId: pre.binding.grantedByUserId,
              effectiveFrom: pre.binding.effectiveFrom,
              effectiveUntil: pre.binding.effectiveUntil,
            }
          : null,
        version: {
          status: version.status,
          validUntil: version.validUntil,
          decisionRecorded: false,
          rootAuthorUserId: version.quotationAuthorUserId,
          versionAuthorUserId: version.versionAuthorUserId,
        },
      });
      if (reasons.length > 0) {
        // MC3/C15: the reason codes belong to the eligibility read, where they are
        // safe to show. The write answers one conflict code and names nothing,
        // because "which precondition failed" is itself a fact about a thread a
        // caller might not be entitled to.
        throw picDecisionRefusedError();
      }
    }

    // Resolved here rather than defaulted inside the engine, because this is the
    // one case the pre-lock evaluation does not cover: when a decision row already
    // exists we deliberately skip that evaluation (see above), and an
    // unbound-but-already-decided thread must answer the conflict class, not a
    // validation error from a missing argument. In practice B18 keeps the binding
    // that authorized a recorded decision ACTIVE forever, so a legitimate replay
    // always finds its row; anything else is a thread this credential cannot
    // decide either.
    const approvalBindingId = pre.binding?.id;
    if (approvalBindingId === undefined) throw picDecisionRefusedError();

    const result = await recordPicQuotationDecision(tx, {
      quotationVersionId: version.quotationVersionId,
      decision,
      idempotencyKey,
      tenantCompanyId: principal.tenantCompanyId,
      tenantPicId: principal.tenantPicId,
      picSessionId: principal.sessionId,
      approvalBindingId,
      quotationId: version.quotationId,
      now: pre.now,
    });

    // A replay wrote nothing, so there is nothing to re-validate — and re-running
    // the window check against the original decision would revoke a caller's
    // right to read back its own answer.
    const replayed =
      existing !== null && existing.quotationDecisionId === result.id;
    if (!replayed) {
      await assertRecordedDecisionIsCurrent(
        tx,
        principal,
        version,
        { decision, idempotencyKey },
        approvalBindingId,
        result,
      );
    }

    return {
      decision: projectDecision(result),
      executionScope: projectExecutionScope(result.executionScope),
    };
  });
}
