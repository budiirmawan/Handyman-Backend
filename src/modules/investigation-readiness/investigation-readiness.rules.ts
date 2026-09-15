import type {
  IncidentReadinessFacts,
  InvestigationBlocker,
} from './investigation-readiness.types';

/**
 * BE-21F — the readiness rules.
 *
 * A PURE function: facts in, blockers out. No database, no clock, no request
 * context. That is deliberate — readiness is the one part of BE-21F that
 * genuinely encodes policy, so it is isolated where it can be reasoned about
 * and tested exhaustively without fixtures.
 *
 * Every rule below answers the same question: can an investigator actually
 * start work on this Incident right now? A blocker is only justified if the
 * answer is genuinely no.
 */

/**
 * Evaluates all rules and returns EVERY blocker that applies.
 *
 * Blockers are accumulated rather than short-circuited: someone preparing an
 * Incident for investigation needs the full list of what to fix, not a
 * one-at-a-time drip feed that costs a round trip per problem.
 *
 * Order is stable and runs from most to least fundamental, so a UI can show
 * `blockers[0]` as the headline reason.
 */
export function evaluateReadinessBlockers(
  facts: IncidentReadinessFacts,
): InvestigationBlocker[] {
  const blockers: InvestigationBlocker[] = [];

  // 1. A withdrawn Incident describes nothing that happened. This is
  //    terminal: no amount of added detail makes it investigable.
  if (facts.status === 'CANCELLED') {
    blockers.push({
      code: 'INCIDENT_CANCELLED',
      message:
        'The Incident is CANCELLED, so there is nothing to investigate.',
    });
    // The remaining rules are about preparing for an investigation that can
    // still happen. Reporting "add a description" for a cancelled Incident
    // would invite pointless work, so this rule stands alone.
    return blockers;
  }

  // 2. The BE-21B/C/D detail row carries the category and occurrence time an
  //    investigation reasons from. Without it only the foundation exists and
  //    the investigator has no subject matter.
  if (!facts.hasTypeDetail) {
    blockers.push({
      code: 'TYPE_DETAIL_MISSING',
      message: `No ${facts.incidentType} detail record exists for this Incident.`,
    });
  }

  // 3. Title alone is a label. An investigation needs the narrative account
  //    of what happened.
  if (!facts.hasDescription) {
    blockers.push({
      code: 'DESCRIPTION_MISSING',
      message:
        'The Incident has no description, so there is no account to investigate.',
    });
  }

  // 4. Investigation follows containment. If nothing was ever done in
  //    response, the situation has not been stabilized and investigating is
  //    premature.
  if (facts.immediateActionCount === 0) {
    blockers.push({
      code: 'NO_IMMEDIATE_ACTION_RECORDED',
      message:
        'No immediate action has been recorded, so containment is unproven.',
    });
  } else if (facts.unsettledImmediateActionCount > 0) {
    // 5. Actions exist but some are still PLANNED or IN_PROGRESS: the
    //    response is live and the facts are still moving. `else if` is
    //    deliberate — "none recorded" and "some outstanding" are the same
    //    concern at different stages, and reporting both would be noise.
    blockers.push({
      code: 'IMMEDIATE_ACTION_UNSETTLED',
      message:
        `${facts.unsettledImmediateActionCount} immediate action(s) are still ` +
        'PLANNED or IN_PROGRESS and must be completed or cancelled first.',
    });
  }

  return blockers;
}

/**
 * Readiness is DEFINED as the absence of blockers.
 *
 * Deriving the boolean from the list — rather than computing it separately —
 * is what makes it impossible for the API to report `ready: true` alongside a
 * non-empty `blockers`.
 */
export function isReady(blockers: InvestigationBlocker[]): boolean {
  return blockers.length === 0;
}
