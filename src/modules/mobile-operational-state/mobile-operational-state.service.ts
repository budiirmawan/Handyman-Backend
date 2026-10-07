/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 04 — mobile operational-state service.
 *
 * ONE READ, no writes. The endpoint is the mobile client's authoritative
 * RN-10 operational-state view: the canonical PART 02 read model, extended
 * with a caller-specific `availableActions` snapshot. Every fact it returns
 * comes from an existing authoritative seam:
 *
 *   - the PART 02 repository reads the operational columns off the
 *     authoritative `assets` row (the same row, the same projection);
 *   - `toOperationalStateView` builds the canonical read model, so the
 *     mobile response can never disagree with `GET /assets/:assetId/
 *     operational-state`;
 *   - the BE-01E permission resolver (`resolvePermissionsForUser`) supplies
 *     the caller's effective ACTIVE permission codes — the same resolver the
 *     RBAC middleware enforces with, so a token is offered only for a
 *     permission the caller actually holds;
 *   - the BE-02G context access service asserts Building isolation, in the
 *     same order as the PART 02 handlers (unknown Asset → 404 BEFORE any
 *     access assertion, so nothing about the Asset is disclosed to a caller
 *     who cannot reach it);
 *   - the PART 03 clearance seam
 *     (`assetFailureRepository.countUnresolvedSafetyRisk`) supplies the
 *     unresolved SAFETY_RISK count that gates `RETURN_TO_SERVICE`.
 *
 * Nothing here is a QR: QR remains identity resolution only (`targetType =
 * ASSET`), and this read takes an Asset id — a QR match/mismatch has no
 * channel into it, by construction.
 */
import { assetFailureRepository } from '../asset-failures';
import {
  assetOperationalStateRepository,
  isReturnToServiceSourceState,
  toOperationalStateView,
} from '../asset-operational-state';
import { assetNotFoundError } from '../assets';
import { contextAccessService } from '../context-access';
import { permissionService } from '../permissions';
import {
  MOBILE_MARK_ACTION_BY_TARGET_STATE,
  type MobileActionResolverInput,
  type MobileAssetOperationalAction,
  type MobileAssetOperationalStateView,
} from './mobile-operational-state.types';

/**
 * The permission codes the RN-10 mobile vocabulary maps to — the exact codes
 * the canonical commands enforce. Named as constants because the resolver
 * must be auditable: each token below means "the caller can execute THAT
 * command, and nothing more".
 */
const UNSAFE_REPORT_PERMISSION = 'asset_failure.report';
const OPERATIONAL_STATE_MANAGE_PERMISSION = 'asset_operational_state.manage';
const RETURN_TO_SERVICE_PERMISSION =
  'asset_operational_state.return_to_service';

/** The BE-05E terminal status that closes the operational axis. */
const RETIRED_ASSET_STATUS = 'RETIRED';

/**
 * The PURE, BOUNDED mobile action resolver.
 *
 * Input: authoritative facts (see `MobileActionResolverInput`). Output: the
 * caller's RN-10 tokens, in the closed vocabulary's deterministic order.
 *
 * The rules, exactly as the contract states them:
 *
 *   REPORT_UNSAFE_CONDITION
 *     iff the caller holds `asset_failure.report` AND the Asset is not
 *     RETIRED.
 *     The RETIRED condition is NOT invented: the executable PART 01
 *     unsafe-report command rejects a RETIRED Asset through the BE-21C
 *     record gate it reuses (`assetFailureAssetRetiredError` — "only a
 *     RETIRED (terminal) Asset is closed to new failure records"), so a
 *     token for a command the backend would refuse is not offered.
 *     `availableActions` reflects executable authority. Nothing else feeds
 *     the token — never CRITICAL priority, `workType`, Finding
 *     severity/classification, the Asset's operational state, or any QR.
 *
 *   MARK_OUT_OF_SERVICE / MARK_ISOLATED / MARK_SHUT_DOWN
 *     iff the caller holds `asset_operational_state.manage` AND the mapped
 *     PART 02 target state is in the canonical `allowedTransitions`.
 *     The transition table (not this resolver) decides which states are
 *     reachable: `IN_SERVICE` therefore offers all three, each non-service
 *     state offers exactly the OTHER two (peers — no severity ordering), and
 *     a RETIRED Asset offers none because the canonical list is `[]`.
 *
 *   RETURN_TO_SERVICE
 *     iff ALL of: the caller holds
 *     `asset_operational_state.return_to_service`; the Asset is NOT RETIRED;
 *     the operational state is one of the three non-service source states;
 *     AND the canonical unresolved SAFETY_RISK count is zero. The gate is
 *     evaluated at read time — it is a snapshot, and the PART 03 command
 *     re-evaluates it inside its transaction before it writes anything.
 *
 * No role names. No UI-text inference. No Work Order, Finding, QR, or
 * equipment-profile input. The function is total and side-effect free.
 */
export function resolveMobileAssetOperationalActions(
  input: MobileActionResolverInput,
): MobileAssetOperationalAction[] {
  const actions: MobileAssetOperationalAction[] = [];
  const holds = (code: string): boolean => input.callerPermissions.includes(code);

  if (
    holds(UNSAFE_REPORT_PERMISSION) &&
    input.assetStatus !== RETIRED_ASSET_STATUS
  ) {
    actions.push('REPORT_UNSAFE_CONDITION');
  }

  if (holds(OPERATIONAL_STATE_MANAGE_PERMISSION)) {
    const markTargets = Object.keys(
      MOBILE_MARK_ACTION_BY_TARGET_STATE,
    ) as (keyof typeof MOBILE_MARK_ACTION_BY_TARGET_STATE)[];
    for (const targetState of markTargets) {
      if (input.allowedTransitions.includes(targetState)) {
        actions.push(MOBILE_MARK_ACTION_BY_TARGET_STATE[targetState]);
      }
    }
  }

  if (
    holds(RETURN_TO_SERVICE_PERMISSION) &&
    input.assetStatus !== RETIRED_ASSET_STATUS &&
    isReturnToServiceSourceState(input.operationalState) &&
    input.unresolvedSafetyRiskCount === 0
  ) {
    actions.push('RETURN_TO_SERVICE');
  }

  return actions;
}

/**
 * The mobile RN-10 operational-state read.
 *
 * Validation order matches the PART 02 handlers exactly: unknown Asset →
 * 404 first (the repository reads the authoritative row), then the caller's
 * Building access → 403 `BUILDING_ACCESS_DENIED`. Holding
 * `asset_operational_state.read` never reaches another Building, and nothing
 * about the Asset is disclosed before both checks pass.
 */
export async function getMobileAssetOperationalState(
  assetId: string,
  userId: string,
): Promise<MobileAssetOperationalStateView> {
  const record = await assetOperationalStateRepository.findByAssetId(assetId);
  if (!record) throw assetNotFoundError();

  await contextAccessService.assertBuildingAccess(userId, record.buildingId);

  // The caller's authoritative permission facts and the PART 03 clearance
  // count are independent reads; the canonical view is a pure projection of
  // the row already read. None of the three is a QR, a Work Order, or a
  // Finding read.
  const [callerPermissions, unresolvedSafetyRiskCount] = await Promise.all([
    permissionService.resolvePermissionsForUser(userId),
    assetFailureRepository.countUnresolvedSafetyRisk(assetId),
  ]);

  const view = toOperationalStateView(record);
  const availableActions = resolveMobileAssetOperationalActions({
    assetStatus: record.assetStatus,
    operationalState: record.operationalState,
    allowedTransitions: view.allowedTransitions,
    callerPermissions,
    unresolvedSafetyRiskCount,
  });

  return { ...view, availableActions };
}

export const mobileOperationalStateService = {
  getMobileAssetOperationalState,
  resolveMobileAssetOperationalActions,
};
