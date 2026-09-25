/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 02 — Asset operational state types.
 *
 * The OPERATIONAL SAFETY STATE of an Asset: whether the physical unit may be
 * used right now. This is a second, INDEPENDENT axis from the BE-05E master
 * lifecycle (`assets.status`) and from the BE-05D technical sheet
 * (`equipment_profiles.status`).
 *
 *   assets.status                     ACTIVE | INACTIVE |
 *                                     UNDER_MAINTENANCE | RETIRED
 *                                     — is this asset current in the registry?
 *
 *   assets.operational_state          IN_SERVICE | OUT_OF_SERVICE |
 *                                     ISOLATED | SHUT_DOWN
 *                                     — may this equipment be used safely now?
 *
 * `status = 'ACTIVE'` with `operationalState = 'OUT_OF_SERVICE'` is a valid and
 * ordinary combination. The three names are deliberately different words for
 * deliberately different facts; nothing here renames, reuses, or overloads
 * `status`, and this axis is NEVER a way around master-lifecycle terminality
 * (a RETIRED Asset cannot move operational state at all).
 *
 * SCOPE OF PART 02
 * ----------------
 * The state machine and its management contract ONLY. Deliberately ABSENT:
 *   - any mobile mutation command (§15 — PART 04 owns caller-specific mobile
 *     authority),
 *   - any `availableActions` token (§15),
 *   - the RETURN_TO_SERVICE command (§14) — added by PART 03, in
 *     `returnAssetToService` below, as its own governed operation.
 *
 * IN_SERVICE is NOT a mutation target of the generic state assignment, and
 * `ASSET_OPERATIONAL_STATE_TRANSITIONS` contains no edge that leads back to it.
 * That absence is the machine stating the boundary: leaving a non-service state
 * goes through the PART-03 governed command — with its own permission,
 * clearance gate, approval, and audit — and never through a state assignment.
 */

export const ASSET_OPERATIONAL_STATES = [
  'IN_SERVICE',
  'OUT_OF_SERVICE',
  'ISOLATED',
  'SHUT_DOWN',
] as const;

export type AssetOperationalState = (typeof ASSET_OPERATIONAL_STATES)[number];

export function isAssetOperationalState(
  value: unknown,
): value is AssetOperationalState {
  return (
    typeof value === 'string' &&
    (ASSET_OPERATIONAL_STATES as readonly string[]).includes(value)
  );
}

/** The state every Asset starts in, and the only state it can leave freely. */
export const ASSET_OPERATIONAL_STATE_INITIAL = 'IN_SERVICE' as const;

/**
 * The states a PART-02 mutation may TARGET.
 *
 * Separate from `ASSET_OPERATIONAL_STATES` on purpose: the full vocabulary is
 * needed for reads and for the transition table's domain, but only these three
 * may appear in a PATCH body. `IN_SERVICE` is rejected at validation with a
 * dedicated explanation rather than a generic enum error, so a client that
 * attempts a return-to-service is told exactly why it cannot.
 */
export const ASSET_OPERATIONAL_STATE_MUTATION_TARGETS = [
  'OUT_OF_SERVICE',
  'ISOLATED',
  'SHUT_DOWN',
] as const;

export type AssetOperationalStateMutationTarget =
  (typeof ASSET_OPERATIONAL_STATE_MUTATION_TARGETS)[number];

export function isAssetOperationalStateMutationTarget(
  value: unknown,
): value is AssetOperationalStateMutationTarget {
  return (
    typeof value === 'string' &&
    (ASSET_OPERATIONAL_STATE_MUTATION_TARGETS as readonly string[]).includes(
      value,
    )
  );
}

/**
 * The explicit, closed transition table — a small lookup, not a workflow
 * engine, following the BE-05E / BE-21C precedent.
 *
 *   IN_SERVICE     → OUT_OF_SERVICE, ISOLATED, SHUT_DOWN
 *   OUT_OF_SERVICE → ISOLATED, SHUT_DOWN
 *   ISOLATED       → OUT_OF_SERVICE, SHUT_DOWN
 *   SHUT_DOWN      → OUT_OF_SERVICE, ISOLATED
 *
 * The three non-service states are PEERS. A technician who has isolated a unit
 * may discover it also needs to be shut down, and an asset that was shut down
 * may be isolated afterwards — neither ordering is "more severe", so no
 * severity ordering is imposed and every non-service → different non-service
 * edge is legal.
 *
 * Every entry lists ONLY non-service targets, so there is no path back to
 * IN_SERVICE in this table by construction (see PART 03).
 */
export const ASSET_OPERATIONAL_STATE_TRANSITIONS: Readonly<
  Record<AssetOperationalState, readonly AssetOperationalState[]>
> = {
  IN_SERVICE: ['OUT_OF_SERVICE', 'ISOLATED', 'SHUT_DOWN'],
  OUT_OF_SERVICE: ['ISOLATED', 'SHUT_DOWN'],
  ISOLATED: ['OUT_OF_SERVICE', 'SHUT_DOWN'],
  SHUT_DOWN: ['OUT_OF_SERVICE', 'ISOLATED'],
};

/** True when `from → to` is a PART-02 legal operational-state transition. */
export function isAllowedOperationalStateTransition(
  from: AssetOperationalState,
  to: AssetOperationalState,
): boolean {
  return ASSET_OPERATIONAL_STATE_TRANSITIONS[from].includes(to);
}

/**
 * The version a never-transitioned Asset carries. The compare-and-set token is
 * the CURRENT version the caller read; a successful transition increments it
 * exactly once.
 */
export const ASSET_OPERATIONAL_STATE_INITIAL_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* PART 03 — the governed return to service                                    */
/* -------------------------------------------------------------------------- */

/**
 * The single state a return-to-service command produces.
 *
 * Named as a constant, and still NOT a member of
 * `ASSET_OPERATIONAL_STATE_MUTATION_TARGETS`: the generic PATCH can never be
 * handed `IN_SERVICE`, in the DTO or in the transition table. Only the governed
 * command writes it, and only after its clearance gate passes.
 */
export const ASSET_OPERATIONAL_STATE_IN_SERVICE = 'IN_SERVICE' as const;

/**
 * The states a return-to-service command may start from — exactly the states a
 * generic PART-02 transition can produce.
 *
 * These are PEERS, exactly as in the PART-02 table: an Asset isolated for a
 * mechanical repair and an Asset shut down for a hazard both return to service
 * through this same command, with the same gate. No severity ordering is
 * implied by the order of this list.
 */
export const RETURN_TO_SERVICE_SOURCE_STATES = [
  'OUT_OF_SERVICE',
  'ISOLATED',
  'SHUT_DOWN',
] as const;

export type ReturnToServiceSourceState =
  (typeof RETURN_TO_SERVICE_SOURCE_STATES)[number];

export function isReturnToServiceSourceState(
  value: unknown,
): value is ReturnToServiceSourceState {
  return (
    typeof value === 'string' &&
    (RETURN_TO_SERVICE_SOURCE_STATES as readonly string[]).includes(value)
  );
}

/**
 * How the return was authorized — recorded verbatim in the authoritative
 * history entry.
 *
 * PART 03 introduces NO pending-approval workflow and NO second approver
 * entity: the authenticated holder of
 * `asset_operational_state.return_to_service` who executes the command IS the
 * authorizing reviewer, and the audit says exactly that. `DIRECT_PRIVILEGED_COMMAND`
 * is the honest name for it. It deliberately does NOT claim two-person
 * approval, and no reviewer/approver identity is ever accepted from the request
 * body — a client cannot assert who authorized a safety decision.
 */
export const DIRECT_PRIVILEGED_COMMAND = 'DIRECT_PRIVILEGED_COMMAND' as const;

export type ApprovalMode = typeof DIRECT_PRIVILEGED_COMMAND;

/** The outcome of the BE-21C safety-risk clearance gate, recorded in history. */
export const SAFETY_RISK_GATE_CLEAR = 'CLEAR' as const;

/**
 * Return-to-service input.
 *
 * Narrower than the PART-02 transition input: there is no `state` field at all,
 * because the target is not a parameter of this command — it IS the command
 * (§3), and `IN_SERVICE` therefore cannot be smuggled in as data. `reason` and
 * `expectedVersion` carry the same meaning and the same rules as PART 02.
 */
export type ReturnAssetToServiceInput = {
  reason: string;
  expectedVersion: number;
};

/**
 * Backend-resolved available transitions.
 *
 * `[]` when the Asset is RETIRED: the operational axis is closed because the
 * master lifecycle is terminal, and the empty list is the honest answer rather
 * than a state-specific one. The frontend consumes this and never recomputes
 * the table.
 */
export function operationalStateAllowedTransitions(
  state: AssetOperationalState,
  isRetired: boolean,
): AssetOperationalState[] {
  if (isRetired) return [];
  return [...ASSET_OPERATIONAL_STATE_TRANSITIONS[state]];
}

/** The row exactly as persisted on the authoritative `assets` row. */
export type AssetOperationalStateRecord = {
  assetId: string;
  /** Live BE-05E master lifecycle projection — read-only on this axis. */
  assetStatus: string;
  buildingId: string;
  operationalState: AssetOperationalState;
  operationalStateVersion: number;
  operationalStateChangedAt: Date | null;
  operationalStateChangedByUserId: string | null;
  operationalStateReason: string | null;
};

/**
 * Canonical read model. This is the OPERATIONAL-STATE read, deliberately
 * distinct from the mobile `availableActions` token list (PART 04): it states
 * what the state machine permits, not what the calling user is authorized to
 * do.
 */
export type AssetOperationalStateView = {
  assetId: string;
  /** BE-05E lifecycle projection, so an empty `allowedTransitions` is explicable. */
  assetStatus: string;
  operationalState: AssetOperationalState;
  version: number;
  changedAt: string | null;
  changedByUserId: string | null;
  reason: string | null;
  /** Backend-derived; never recomputed by the client. */
  allowedTransitions: AssetOperationalState[];
};

/**
 * Mutation input.
 *
 * `expectedVersion` is REQUIRED: there is no unconditional overwrite of safety
 * state. `reason` is required because an equipment state left with no stated
 * cause is not auditable.
 */
export type TransitionAssetOperationalStateInput = {
  state: AssetOperationalStateMutationTarget;
  reason: string;
  expectedVersion: number;
};
