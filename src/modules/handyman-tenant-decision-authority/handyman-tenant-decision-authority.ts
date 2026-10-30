import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * Production authority for personal customer decisions (commercial/BAST/warranty).
 *
 * Building access and RBAC are necessary outer guards, but neither proves
 * that a user represents the tenant on one particular request.  The request's
 * immutable tenant_pic_id is the explicit, request-level designation.  It is
 * valid only while that PIC, its company, and (when the request identifies a
 * space) the company's occupancy of that exact space are currently active.
 *
 * There is deliberately no role/permission fallback and no Customer Care or
 * administrator override.  The current schema has no delegation record, so
 * delegated decisions are fail-closed until such a policy is introduced.
 */
export async function assertHandymanTenantDecisionActor(
  executor: Pick<PoolClient, 'query'>,
  input: {
    actorUserId: string;
    handymanRequestId: string;
    clientId: string;
    tenantCompanyId: string;
    buildingId: string;
  },
): Promise<{ tenantPicId: string }> {
  // All callers use their decision transaction. Hold the current PIC identity
  // and ACTIVE account through decision/history insertion; a relink must wait,
  // or this locking read rechecks the changed identity after the relink commits.
  const result = await executor.query<{ tenant_pic_id: string }>(
    `SELECT r.tenant_pic_id
       FROM handyman_service_requests r
       JOIN tenant_companies tc
         ON tc.id = r.tenant_company_id
        AND tc.client_id = r.client_id
        AND tc.status = 'ACTIVE'
       JOIN tenant_pics tp
         ON tp.id = r.tenant_pic_id
        AND tp.tenant_company_id = r.tenant_company_id
        AND tp.user_id = $1
        AND tp.status = 'ACTIVE'
       JOIN users u ON u.id = tp.user_id AND u.status = 'ACTIVE'
      WHERE r.id = $2
        AND r.client_id = $3
        AND r.tenant_company_id = $4
        AND r.building_id = $5
        AND (
          r.space_id IS NULL
          OR EXISTS (
            SELECT 1
              FROM tenant_space_relationships tsr
             WHERE tsr.tenant_company_id = r.tenant_company_id
               AND tsr.building_id = r.building_id
               AND tsr.space_id = r.space_id
               AND tsr.status = 'ACTIVE'
               AND (tsr.effective_from IS NULL OR tsr.effective_from <= NOW())
               AND (tsr.effective_until IS NULL OR tsr.effective_until > NOW())
          )
        )
      FOR SHARE OF tp, u`,
    [
      input.actorUserId,
      input.handymanRequestId,
      input.clientId,
      input.tenantCompanyId,
      input.buildingId,
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN,
      message:
        'The authenticated user is not the active Tenant PIC authorized for this request.',
    });
  }
  return { tenantPicId: row.tenant_pic_id };
}
