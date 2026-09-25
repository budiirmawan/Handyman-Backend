import { withTransaction } from '../../database';
import { assetNotFoundError } from '../assets';
import { recordAssetHistory, recordAssetHistoryInTransaction } from '../asset-history';
import { assetFailureRepository } from '../asset-failures';
import {
  assetOperationalStateAlreadyInServiceError,
  assetOperationalStateConflictError,
  assetOperationalStateRetiredError,
  assetOperationalStateTransitionNotAllowedError,
  assetOperationalStateUnchangedError,
  assetOperationalStateUnresolvedSafetyRiskError,
} from './asset-operational-state.errors';
import { assetOperationalStateRepository } from './asset-operational-state.repository';
import {
  ASSET_OPERATIONAL_STATE_IN_SERVICE,
  DIRECT_PRIVILEGED_COMMAND,
  SAFETY_RISK_GATE_CLEAR,
  isAllowedOperationalStateTransition,
  isReturnToServiceSourceState,
  operationalStateAllowedTransitions,
  type AssetOperationalStateRecord,
  type AssetOperationalStateView,
  type ReturnAssetToServiceInput,
  type TransitionAssetOperationalStateInput,
} from './asset-operational-state.types';

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 02 — Asset operational-state service.
 *
 * Owns the PART-02 state machine on the `assets` row. It does NOT own the
 * BE-05E lifecycle (`assets.status`), the BE-05D technical sheet
 * (`equipment_profiles.status`), Finding, or Work Order state: none of those
 * is read for anything other than the retired gate, and none is written.
 *
 * Even a successful transition writes to exactly two places: the operational
 * columns on the Asset row (including the version increment, actor, timestamp,
 * and reason, in ONE statement), and one append-only Asset history entry.
 */

function isRetired(record: AssetOperationalStateRecord): boolean {
  return record.assetStatus === 'RETIRED';
}

export function toOperationalStateView(
  record: AssetOperationalStateRecord,
): AssetOperationalStateView {
  return {
    assetId: record.assetId,
    assetStatus: record.assetStatus,
    operationalState: record.operationalState,
    version: record.operationalStateVersion,
    changedAt: record.operationalStateChangedAt
      ? record.operationalStateChangedAt.toISOString()
      : null,
    changedByUserId: record.operationalStateChangedByUserId,
    reason: record.operationalStateReason,
    allowedTransitions: operationalStateAllowedTransitions(
      record.operationalState,
      isRetired(record),
    ),
  };
}

/**
 * Canonical read. Returns the persisted state, its version, and the
 * backend-derived permitted transitions. A RETIRED Asset still READS: the
 * lifecycle closes mutation, not visibility, and the last persisted
 * operational state remains the truth about how the equipment was left.
 */
export async function getAssetOperationalState(
  assetId: string,
): Promise<AssetOperationalStateView> {
  const record = await assetOperationalStateRepository.findByAssetId(assetId);
  if (!record) throw assetNotFoundError();
  return toOperationalStateView(record);
}

/** The Asset's Building, for the caller's BE-02G access assertion. */
export async function resolveOperationalStateBuildingId(
  assetId: string,
): Promise<string> {
  const record = await assetOperationalStateRepository.findByAssetId(assetId);
  if (!record) throw assetNotFoundError();
  return record.buildingId;
}

/**
 * Transitions an Asset's operational state.
 *
 * Validation order (each failure deterministic and distinct):
 *   1. unknown Asset                        → 404 ASSET_NOT_FOUND
 *   2. RETIRED Asset                        → 409 ASSET_OPERATIONAL_STATE_RETIRED
 *   3. target === current                   → 409 ASSET_OPERATIONAL_STATE_UNCHANGED
 *   4. transition not in the PART-02 table  → 409
 *                                             ASSET_OPERATIONAL_STATE_TRANSITION_NOT_ALLOWED
 *      (in practice: an IN_SERVICE return attempt, already refused at the DTO)
 *   5. stale expectedVersion / concurrent
 *      change                              → 409 ASSET_OPERATIONAL_STATE_CONFLICT
 *
 * Step 5 is decided by the DATABASE, not by a check-then-act: the compare-and-
 * set UPDATE matches on `operational_state_version`, so two concurrent
 * transitions cannot both succeed. When the guarded UPDATE returns no row the
 * Asset is re-read and the failure is disambiguated — a RETIRED race is
 * reported as retired, anything else as a version conflict. A newer state is
 * never silently overwritten.
 *
 * The history entry is written AFTER the state change commits, using the
 * existing best-effort `recordAssetHistory` (which swallows write failures by
 * design, following the BE-01H audit precedent). It never rolls back a state
 * change that already succeeded. The PART-03 governed return-to-service command
 * deliberately does NOT use this path: there the audit row and the state change
 * must commit together (see `returnAssetToService`).
 */
export async function transitionAssetOperationalState(
  assetId: string,
  input: TransitionAssetOperationalStateInput,
  actorUserId: string | null,
): Promise<AssetOperationalStateView> {
  const existing = await assetOperationalStateRepository.findByAssetId(assetId);
  if (!existing) throw assetNotFoundError();

  // Master lifecycle stays authoritative for terminal retirement. Checked
  // BEFORE anything else is decided, so no other error can mask it.
  if (isRetired(existing)) throw assetOperationalStateRetiredError();

  if (existing.operationalState === input.state) {
    throw assetOperationalStateUnchangedError(existing.operationalState);
  }

  if (
    !isAllowedOperationalStateTransition(existing.operationalState, input.state)
  ) {
    throw assetOperationalStateTransitionNotAllowedError(
      existing.operationalState,
      input.state,
    );
  }

  const updated = await assetOperationalStateRepository.transitionFrom(
    assetId,
    input.expectedVersion,
    input.state,
    input.reason,
    actorUserId,
  );

  if (!updated) {
    // The guarded UPDATE matched nothing. Re-read to report WHY, rather than
    // guessing: a concurrent retirement and a stale version are different
    // failures for the caller.
    const current = await assetOperationalStateRepository.findByAssetId(assetId);
    if (!current) throw assetNotFoundError();
    if (isRetired(current)) throw assetOperationalStateRetiredError();
    throw assetOperationalStateConflictError(input.expectedVersion, {
      operationalState: current.operationalState,
      version: current.operationalStateVersion,
    });
  }

  await recordAssetHistory({
    assetId,
    eventType: 'ASSET_OPERATIONAL_STATE_CHANGED',
    actorUserId,
    summary: `Asset operational state changed from ${existing.operationalState} to ${updated.operationalState}`,
    metadata: {
      fromState: existing.operationalState,
      toState: updated.operationalState,
      reason: input.reason,
      version: updated.operationalStateVersion,
      assetStatus: updated.assetStatus,
    },
  });

  return toOperationalStateView(updated);
}

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 03 — the governed RETURN_TO_SERVICE
 * command.
 *
 * Returns a non-service Asset to `IN_SERVICE`. It is NOT a state assignment:
 * the target is fixed by the command, the caller cannot name any state, and the
 * Authorization/clearance/audit obligations below are the price of the
 * authority. The generic PATCH is untouched and still cannot reach
 * `IN_SERVICE` — that is asserted from both sides (a DTO rejection in PART 02
 * and a transition-table proof in PART 03).
 *
 * WHY THE WHOLE THING IS ONE TRANSACTION (§12)
 * --------------------------------------------
 * Four facts must agree or none of them may happen: the Asset's state and
 * version, the SAFETY_RISK clearance verdict, the new `IN_SERVICE` row, and the
 * audit entry naming who authorized it. The row is read `FOR UPDATE` so the
 * verdict and the write it guards cannot straddle a concurrent change, and the
 * history insert is the FAIL-LOUD transactional variant — if the audit row
 * cannot be written, the state change rolls back with it. An Asset returned to
 * service without a record of the authorizing actor and the cleared gate is
 * precisely the outcome an RN-10 control must never produce, so this command
 * trades the best-effort audit used by ordinary Asset edits for a real one.
 *
 * VALIDATION ORDER — every branch is a distinct, deterministic refusal:
 *   1. unknown Asset                       → 404 ASSET_NOT_FOUND
 *   2. RETIRED Asset                       → 409 ASSET_OPERATIONAL_STATE_RETIRED
 *   3. already IN_SERVICE                  → 409
 *                                            ASSET_OPERATIONAL_STATE_ALREADY_IN_SERVICE
 *   4. not a non-service source state      → 409
 *                                            ASSET_OPERATIONAL_STATE_TRANSITION_NOT_ALLOWED
 *   5. unresolved SAFETY_RISK failures     → 409
 *                                            ASSET_OPERATIONAL_STATE_UNRESOLVED_SAFETY_RISK
 *   6. stale expectedVersion               → 409 ASSET_OPERATIONAL_STATE_CONFLICT
 *
 * Step 2 keeps master-lifecycle terminality absolute: operational state is
 * never a way around retirement, and a RETIRED Asset can never be reactivated
 * here. Step 3 is what makes a replay harmless — a duplicate of a successful
 * return finds the Asset already in service and is refused, so there is no
 * second transition and no need for an idempotency key. Step 5 reads BE-21C's
 * canonical failure state and NEVER resolves anything: clearing a hazard stays
 * an `asset_failure.manage` act on the existing BE-21C lifecycle.
 */
export async function returnAssetToService(
  assetId: string,
  input: ReturnAssetToServiceInput,
  actorUserId: string,
): Promise<AssetOperationalStateView> {
  return withTransaction(async (client) => {
    const existing = await assetOperationalStateRepository.findByAssetIdForUpdate(
      assetId,
      client,
    );
    if (!existing) throw assetNotFoundError();

    if (isRetired(existing)) throw assetOperationalStateRetiredError();

    if (existing.operationalState === ASSET_OPERATIONAL_STATE_IN_SERVICE) {
      throw assetOperationalStateAlreadyInServiceError();
    }

    // Defensive: the operational axis has four states and one of them is
    // IN_SERVICE, so anything reaching here is one of the three sources. Stated
    // explicitly rather than assumed, so a future state added to the machine
    // cannot silently inherit return-to-service authority.
    if (!isReturnToServiceSourceState(existing.operationalState)) {
      throw assetOperationalStateTransitionNotAllowedError(
        existing.operationalState,
        ASSET_OPERATIONAL_STATE_IN_SERVICE,
      );
    }

    // The safety-risk clearance gate. Evaluated on the SAME connection and in
    // the SAME transaction as the write it guards, and it fails CLOSED: any
    // unresolved SAFETY_RISK failure blocks, and the count is reported without
    // disclosing the records themselves.
    const blockingCount = await assetFailureRepository.countUnresolvedSafetyRisk(
      assetId,
      client,
    );
    if (blockingCount > 0) {
      throw assetOperationalStateUnresolvedSafetyRiskError(blockingCount);
    }

    const updated = await assetOperationalStateRepository.transitionFrom(
      assetId,
      input.expectedVersion,
      ASSET_OPERATIONAL_STATE_IN_SERVICE,
      input.reason,
      actorUserId,
      client,
    );

    if (!updated) {
      // The guarded UPDATE matched nothing. Under the row lock the only way
      // this happens is a stale `expectedVersion`, but a concurrent retirement
      // is re-checked rather than assumed away, and both are reported
      // deterministically without writing anything.
      const current = await assetOperationalStateRepository.findByAssetIdForUpdate(
        assetId,
        client,
      );
      if (!current) throw assetNotFoundError();
      if (isRetired(current)) throw assetOperationalStateRetiredError();
      throw assetOperationalStateConflictError(input.expectedVersion, {
        operationalState: current.operationalState,
        version: current.operationalStateVersion,
      });
    }

    // The approval facts are the COMMAND's own facts, not caller input: the
    // actor executing the command is the authorizing reviewer, the approval
    // timestamp is the canonical transition timestamp (the same instant the
    // state changed, taken from the row the UPDATE just wrote), and the mode
    // says honestly that this was a direct privileged command — no second
    // approver is claimed, and none was consulted.
    const approvedAt = updated.operationalStateChangedAt ?? new Date();

    await recordAssetHistoryInTransaction(
      {
        assetId,
        eventType: 'ASSET_RETURNED_TO_SERVICE',
        actorUserId,
        summary: `Asset returned to service from ${existing.operationalState}`,
        metadata: {
          fromState: existing.operationalState,
          toState: ASSET_OPERATIONAL_STATE_IN_SERVICE,
          reason: input.reason,
          version: updated.operationalStateVersion,
          assetStatus: updated.assetStatus,
          approvalMode: DIRECT_PRIVILEGED_COMMAND,
          approvedByUserId: actorUserId,
          approvedAt: approvedAt.toISOString(),
          safetyRiskGate: SAFETY_RISK_GATE_CLEAR,
        },
      },
      client,
    );

    return toOperationalStateView(updated);
  });
}

export const assetOperationalStateService = {
  getAssetOperationalState,
  resolveOperationalStateBuildingId,
  returnAssetToService,
  toOperationalStateView,
  transitionAssetOperationalState,
};
