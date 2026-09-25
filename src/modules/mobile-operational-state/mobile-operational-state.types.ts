/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 04 — mobile operational-state
 * authority types.
 *
 * PART 04 PUBLISHES the mobile RN-10 operational-state READ and the
 * caller-specific `availableActions` token model that PART 02/03 reserved
 * for it (§15). It adds NO state machine, NO mutation command, and NO second
 * copy of operational-state facts: the view is the canonical PART 02
 * `AssetOperationalStateView` itself, and the action tokens are derived by a
 * PURE resolver from authoritative facts only.
 *
 * MUTATIONS REMAIN CANONICAL. There is deliberately no mobile mutation
 * endpoint in this PART (or anywhere): `MARK_*` and `RETURN_TO_SERVICE`
 * tokens point at the existing commands —
 *
 *   PATCH /assets/:assetId/operational-state
 *   POST  /assets/:assetId/operational-state/return-to-service
 *
 * and those commands revalidate permission, state, transition, version
 * (CAS), lifecycle terminality, and the PART 03 safety-risk clearance gate on
 * EVERY call. `availableActions` is a read-time capability SNAPSHOT: it never
 * grants, bypasses, or extends authority, and a previously-read token is
 * never accepted as mutation authority.
 */
import type {
  AssetOperationalState,
  AssetOperationalStateView,
} from '../asset-operational-state';

/**
 * The CLOSED RN-10 mobile action vocabulary.
 *
 * Exactly these five tokens belong to this contract — no more, no less.
 * Other mobile surfaces use different vocabularies (QR resolution offers
 * `VIEW_DETAILS` / `START_FINDING`, and the RN-10 tokens must NOT be added
 * there), and no generic tokens (`VIEW_DETAILS`, `START`, `COMPLETE`,
 * `CLOSE`, …) may leak into this one.
 *
 * The list order is the deterministic response order and mirrors the
 * lifecycle a field worker follows: observe a hazard, take the equipment
 * out of service in some form, and — only after the governed gate clears —
 * return it to service. No ordering among the three non-service states is
 * implied: they are peers (see the PART 02 transition table).
 */
export const MOBILE_ASSET_OPERATIONAL_ACTIONS = [
  'REPORT_UNSAFE_CONDITION',
  'MARK_OUT_OF_SERVICE',
  'MARK_ISOLATED',
  'MARK_SHUT_DOWN',
  'RETURN_TO_SERVICE',
] as const;

export type MobileAssetOperationalAction =
  (typeof MOBILE_ASSET_OPERATIONAL_ACTIONS)[number];

export function isMobileAssetOperationalAction(
  value: unknown,
): value is MobileAssetOperationalAction {
  return (
    typeof value === 'string' &&
    (MOBILE_ASSET_OPERATIONAL_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * Exact PART 02 mutation-target → mobile-token mapping.
 *
 * The three `MARK_*` tokens are the mobile names for the three generic
 * PART 02 transition targets. Nothing else maps to them: `RETURN_TO_SERVICE`
 * is NOT a fourth `MARK_*`, it is the PART 03 governed command with its own
 * gate, and `IN_SERVICE` has no token here at all.
 */
export const MOBILE_MARK_ACTION_BY_TARGET_STATE: {
  OUT_OF_SERVICE: MobileAssetOperationalAction;
  ISOLATED: MobileAssetOperationalAction;
  SHUT_DOWN: MobileAssetOperationalAction;
} = {
  OUT_OF_SERVICE: 'MARK_OUT_OF_SERVICE',
  ISOLATED: 'MARK_ISOLATED',
  SHUT_DOWN: 'MARK_SHUT_DOWN',
};

/**
 * The canonical PART 02 read model plus the caller-specific mobile
 * authority snapshot.
 *
 * The first eight fields ARE `AssetOperationalStateView`, produced by the
 * PART 02 `toOperationalStateView` — this PART never reconstructs
 * operational-state facts (state, version, actor, timestamp, reason,
 * lifecycle projection, allowed transitions) separately. Only
 * `availableActions` is new, and it is caller-specific: two callers reading
 * the same Asset in the same state can see different tokens because they
 * hold different permissions.
 *
 * `availableActions` is a read-time capability snapshot — see the module
 * header for why it is not a write authorization.
 */
export type MobileAssetOperationalStateView = AssetOperationalStateView & {
  /**
   * The RN-10 actions the CALLER may execute against this Asset right now,
   * derived from authoritative facts at read time. Mutating endpoints
   * revalidate everything; a token here is an affordance, never authority.
   */
  availableActions: MobileAssetOperationalAction[];
};

/**
 * The pure resolver's input — authoritative FACTS only.
 *
 * Every field is a fact the backend already establishes elsewhere:
 *
 *   - `assetStatus`              the BE-05E master lifecycle status read
 *                                from the authoritative `assets` row;
 *   - `operationalState`         the PART 02 state read from the same row;
 *   - `allowedTransitions`       the PART 02 backend-derived transition
 *                                list (already `[]` for a RETIRED Asset);
 *   - `callerPermissions`        the caller's effective ACTIVE permission
 *                                codes from the BE-01E resolver — the same
 *                                resolver the RBAC middleware uses;
 *   - `unresolvedSafetyRiskCount` the BE-21C SAFETY_RISK clearance count
 *                                from the PART 03 canonical seam.
 *
 * Deliberately ABSENT — the resolver has no channel for any of these, which
 * is what keeps them from ever influencing the tokens: role names, Work
 * Orders and priorities, `workType`, Finding severities or classifications,
 * equipment-profile status, QR match/mismatch, caller-supplied bodies.
 */
export type MobileActionResolverInput = {
  assetStatus: string;
  operationalState: AssetOperationalState;
  allowedTransitions: readonly AssetOperationalState[];
  callerPermissions: readonly string[];
  unresolvedSafetyRiskCount: number;
};
