import type {
  ClosureBlocker,
  IncidentClosureFacts,
} from './incident-closure.types';

/**
 * BE-21K — the closure rules.
 *
 * A PURE function: facts in, blockers out. No database, no clock, no request
 * context. Closure policy is the one genuinely opinionated part of this PART,
 * so it is isolated where it can be reasoned about and tested exhaustively
 * without fixtures — the same shape BE-21F uses for investigation readiness.
 *
 * Every rule answers one question: is this Incident genuinely finished? A
 * blocker is only justified when the honest answer is no.
 */

/**
 * Evaluates all rules and returns EVERY blocker that applies.
 *
 * Blockers accumulate rather than short-circuit: someone trying to close an
 * Incident needs the full list of what remains, not one problem per round
 * trip. Order runs from most to least fundamental so a UI can show
 * `blockers[0]` as the headline reason.
 */
export function evaluateClosureBlockers(
  facts: IncidentClosureFacts,
): ClosureBlocker[] {
  const blockers: ClosureBlocker[] = [];

  // 1. Lifecycle first. These are terminal conditions — no amount of
  //    corrective-action work changes them — so each stands alone and the
  //    remaining rules are skipped. Reporting "2 actions unresolved" about an
  //    already-closed Incident would invite pointless work.
  if (facts.status === 'CLOSED') {
    blockers.push({
      code: 'INCIDENT_ALREADY_CLOSED',
      message: 'This Incident is already CLOSED; closure is final.',
    });
    return blockers;
  }
  if (facts.status === 'CANCELLED') {
    blockers.push({
      code: 'INCIDENT_CANCELLED',
      message:
        'This Incident was CANCELLED, so it cannot be closed as resolved.',
    });
    return blockers;
  }
  if (facts.status !== 'REPORTED') {
    blockers.push({
      code: 'INCIDENT_NOT_REPORTED',
      message: `An Incident in state ${facts.status} cannot be closed.`,
    });
    return blockers;
  }

  // 2. Closure asserts the Incident was RESOLVED. With no corrective action
  //    on record, nothing was ever done about it, so there is no remedy to
  //    have verified. Closing here would let an Incident be sealed by
  //    inaction — the loophole this rule exists to shut.
  if (facts.requiredActionCount === 0) {
    blockers.push({
      code: 'NO_CORRECTIVE_ACTION',
      message:
        'No corrective action has been recorded, so there is no remedy to close against.',
    });
    return blockers;
  }

  // 3. Required corrective actions still in flight. "Required" excludes
  //    REJECTED and CANCELLED proposals: a refused or called-off remedy is
  //    not work anyone still owes.
  if (facts.unresolvedActionCount > 0) {
    blockers.push({
      code: 'CORRECTIVE_ACTION_UNRESOLVED',
      message:
        `${facts.unresolvedActionCount} corrective action(s) are still ` +
        'PROPOSED, APPROVED, or IN_PROGRESS and must be completed first.',
    });
  }

  // 4. Rework is the strongest possible statement that the work is NOT done:
  //    a reviewer inspected it and sent it back. Reported separately from the
  //    generic unresolved count because the cause is different — this is
  //    failed work, not merely unfinished work — and the person closing needs
  //    to know a verifier already rejected it.
  if (facts.reworkRequiredCount > 0) {
    blockers.push({
      code: 'VERIFICATION_REWORK_REQUIRED',
      message:
        `${facts.reworkRequiredCount} corrective action(s) were returned for ` +
        'rework by verification and must be redone and re-verified.',
    });
  }

  // 5. A failed check that did not demand rework still means the remedy was
  //    never confirmed. BE-21J keeps REJECTED distinct from REWORK_REQUIRED,
  //    and closure honours that distinction rather than flattening both into
  //    "not approved".
  if (facts.rejectedVerificationCount > 0) {
    blockers.push({
      code: 'VERIFICATION_NOT_APPROVED',
      message:
        `${facts.rejectedVerificationCount} corrective action(s) have a ` +
        'REJECTED verification and were never confirmed.',
    });
  }

  // 6. A verification that is open has not decided anything yet. Closing mid-
  //    review would pre-empt the reviewer's decision.
  if (facts.pendingVerificationCount > 0) {
    blockers.push({
      code: 'VERIFICATION_PENDING',
      message:
        `${facts.pendingVerificationCount} corrective action(s) have a ` +
        'verification still in progress.',
    });
  }

  // 7. Completed but never verified. This is the rule that makes verification
  //    MEAN something at closure: without it, the doer's own claim of
  //    completion would be sufficient to seal the Incident, and BE-21J's
  //    independent confirmation would be decorative.
  //
  //    Guarded on the counts above so a single action is not reported twice —
  //    an action awaiting a pending decision, or already sent back for
  //    rework, is unverified for a reason ALREADY stated.
  const unexplainedUnverified =
    facts.unverifiedActionCount -
    facts.pendingVerificationCount -
    facts.reworkRequiredCount -
    facts.rejectedVerificationCount;
  if (unexplainedUnverified > 0) {
    blockers.push({
      code: 'CORRECTIVE_ACTION_UNVERIFIED',
      message:
        `${unexplainedUnverified} corrective action(s) are COMPLETED but have ` +
        'not been verified. Verification is required before closure.',
    });
  }

  return blockers;
}

/** Closeable exactly when nothing blocks it. */
export function isCloseable(blockers: ClosureBlocker[]): boolean {
  return blockers.length === 0;
}
