import { getPool } from '../../database';
import type { MobilePermitWorkFeedRow } from './mobile-permit-work.types';

/**
 * CR-BE-RN20-PERMIT-FIELD-01 — field actor identity + field feed reads.
 *
 * FIELD ACTOR CHAIN (existing tables, existing ACTIVE semantics)
 * --------------------------------------------------------------
 *   permit_workers.status = 'ACTIVE'                 (BE-20H, 0209)
 *     → vendor_workforce_bindings.status = 'ACTIVE'  (BE-06F, 0060)
 *       → workforce_profiles.status = 'ACTIVE'       (BE-03C, 0024)
 *         AND workforce_profiles.user_id = <actor>   (UNIQUE (user_id))
 *
 * ACTIVE is the persisted status of each link — exactly the value each owning
 * module writes and filters on (`permit_worker_active_unique`,
 * `vendor_workforce_bindings_active_unique`, `workforce_profiles_status_check`).
 * Time-window eligibility (`permit_workers.valid_from/until`, binding
 * `effective_from/until`, validity VALID) is NOT identity: it remains the
 * existing START readiness concern (`WORKER_LIST_NOT_READY` / validity
 * blockers) and is never re-derived here.
 *
 * EXISTS SEMANTICS
 * ----------------
 * The chain is evaluated as `EXISTS (...)`, never joined into the row set. One
 * actor may legitimately hold several permit_workers rows on one application
 * (INACTIVE history, or ACTIVE rows through different vendor bindings); none of
 * that can multiply or select a "winning" worker row. No worker row is ever
 * selected — only the boolean fact that at least one ACTIVE chain resolves to
 * the caller.
 */
const FIELD_ACTOR_EXISTS = `
  EXISTS (
    SELECT 1
    FROM permit_workers pw
    JOIN vendor_workforce_bindings vwb
      ON vwb.id = pw.vendor_workforce_binding_id
    JOIN workforce_profiles wp
      ON wp.id = vwb.workforce_profile_id
    WHERE pw.permit_application_id = pa.id
      AND pw.status = 'ACTIVE'
      AND vwb.status = 'ACTIVE'
      AND wp.status = 'ACTIVE'
      AND wp.user_id = $ACTOR
  )
`;

/** True when at least one ACTIVE worker chain of the application is the actor. */
async function isFieldActor(
  permitApplicationId: string,
  actorUserId: string,
): Promise<boolean> {
  const result = await getPool().query<{ exists: boolean }>(
    `SELECT ${FIELD_ACTOR_EXISTS.replace('$ACTOR', '$2')} AS exists
     FROM permit_applications pa
     WHERE pa.id = $1`,
    [permitApplicationId, actorUserId],
  );
  return result.rows[0]?.exists === true;
}

/**
 * The field feed: every non-CANCELLED permit in the caller's accessible
 * Buildings whose lifecycle is READY (no row yet) or IN_PROGRESS and for which
 * the caller is a field actor.
 *
 * GRAIN PROOF — one row per `permits.id`:
 *   - permits → permit_applications is 1:1
 *     (`permit_applications_permit_unique UNIQUE (permit_id)`, 0204);
 *   - permit_applications → permit_work_lifecycles is 0..1
 *     (`permit_work_lifecycle_application_unique`, 0212), LEFT JOIN;
 *   - the validity window is the domain's own "latest validity" selector
 *     (`ORDER BY created_at DESC, id DESC LIMIT 1`, exactly as the BE-20H
 *     worker repository projects `permitValidityStatus`), LATERAL 0..1;
 *   - the worker chain is `EXISTS`, so it never fans out.
 * Nothing else is joined, so one permitId can appear at most once.
 *
 * `COALESCE(pwl.status, 'READY')` mirrors the lifecycle authority's own
 * derivation (`lifecycle?.status ?? 'READY'`); CANCELLED permits are excluded
 * by `p.status`, and a lifecycle row in CLOSED / CANCELLED is excluded by the
 * status filter. Building scope fails closed on an empty accessible set.
 */
async function listFieldFeed(
  actorUserId: string,
  accessibleBuildingIds: string[],
): Promise<MobilePermitWorkFeedRow[]> {
  if (accessibleBuildingIds.length === 0) return [];
  const result = await getPool().query<MobilePermitWorkFeedRow>(
    `SELECT
       p.id                          AS "permitId",
       pa.id                         AS "permitApplicationId",
       p.permit_number               AS "permitReference",
       p.building_id                 AS "buildingId",
       p.title,
       p.work_description            AS "workDescription",
       COALESCE(pwl.status, 'READY') AS status,
       pv.valid_from                 AS "validFrom",
       pv.valid_until                AS "validUntil"
     FROM permits p
     JOIN permit_applications pa ON pa.permit_id = p.id
     LEFT JOIN permit_work_lifecycles pwl
       ON pwl.permit_application_id = pa.id
     LEFT JOIN LATERAL (
       SELECT latest.valid_from, latest.valid_until
       FROM permit_validities latest
       WHERE latest.permit_application_id = pa.id
       ORDER BY latest.created_at DESC, latest.id DESC
       LIMIT 1
     ) pv ON TRUE
     WHERE p.building_id = ANY($1::uuid[])
       AND p.status <> 'CANCELLED'
       AND COALESCE(pwl.status, 'READY') IN ('READY', 'IN_PROGRESS')
       AND ${FIELD_ACTOR_EXISTS.replace('$ACTOR', '$2')}
     ORDER BY p.requested_at DESC, p.id`,
    [accessibleBuildingIds, actorUserId],
  );
  return result.rows;
}

export const mobilePermitWorkRepository = { isFieldActor, listFieldFeed };
