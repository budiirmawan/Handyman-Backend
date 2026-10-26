import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import {
  assertBuildingScopedResourceAccess,
  buildingAccessDeniedError,
} from '../context-access';
import { handymanServiceRequestRepository } from '../handyman-requests';
import { permissionRepository } from '../permissions';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { handymanQuotationVersionNotFoundError } from './handyman-quotation.errors';
import type { HandymanQuotationRecord } from './handyman-quotation.types';

/**
 * CR-HM-SEC-01 PART 02 — quotation thread building-scope authority.
 *
 * The quotation row carries `clientId` + `handymanRequestId` but NO
 * `building_id`: a quotation thread's Building is the PARENT REQUEST's
 * `building_id` (server-derived from the immutable CR-HM-01 attribution
 * per CR-HM-02). Every quotation-scoped operation therefore traces the
 * thread to its parent request and enforces the reusable BE-02G guard
 * (`assertBuildingScopedResourceAccess`): explicit ACTIVE assignment to
 * that exact Building resolving under the thread's Client. No same-Client
 * shortcut, no client-wide privilege, no existence leak — a valid but
 * inaccessible Building is denied exactly like an unknown one.
 */
export async function assertQuotationThreadBuildingAccess(
  executor: Pick<PoolClient, 'query'>,
  quotation: Pick<HandymanQuotationRecord, 'clientId' | 'handymanRequestId'>,
  actorUserId: string,
): Promise<void> {
  const request = await handymanServiceRequestRepository.findById(
    executor,
    quotation.handymanRequestId,
  );
  if (!request) {
    // The parent request is the provenance root of the thread; without it
    // the thread cannot be building-scoped. Deny exactly like an
    // inaccessible Building (no existence leak).
    throw buildingAccessDeniedError();
  }
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: quotation.clientId,
    buildingId: request.buildingId,
  });
}

/**
 * CR-HM-MANUAL-QUOTATION-01 PART 03D — customer DRAFT-visibility law.
 *
 * A quotation version becomes the customer's commercial offer only when it is
 * ISSUED: until then it is an un-issued DRAFT that Operations may still be
 * pricing, re-cut (PART 03B revision) or abandon. The customer-facing reads are
 * therefore version-status aware: a CUSTOMER actor — an active User linked to
 * an active Tenant PIC of THIS thread's tenant company, i.e. the side that
 * would consent — can never read the lines or derived prices of a DRAFT, not
 * even by addressing the version id directly. The refusal is the ordinary
 * "no such version" answer, so an un-issued DRAFT is indistinguishable from an
 * unknown id and no status oracle is created for the customer lane.
 *
 * What this law deliberately does NOT do:
 *   - it never restricts Operations, Care or platform staff: the same
 *     un-issued DRAFT must stay readable (and addable) for the authors who are
 *     pricing it, so a permission/identity class other than this thread's
 *     customer side is untouched;
 *   - it never hides history: any version that WAS presented (ISSUED,
 *     SUPERSEDED, APPROVED, REJECTED, EXPIRED) stays readable by the customer,
 *     so superseded and approved quotation records remain auditable;
 *   - it adds no new permission, role, response schema or error code, and it
 *     runs strictly AFTER the thread's Building-scope guard, so an
 *     out-of-scope actor keeps getting the existing 403 without learning
 *     anything at all about the thread (no existence leak either way).
 */
/** Is this actor the CUSTOMER side of this thread's tenant company? */
async function isThreadCustomerSideActor(
  executor: Pick<PoolClient, 'query'>,
  input: {
    actorUserId: string;
    clientId: string;
    tenantCompanyId: string;
  },
): Promise<boolean> {
  const customerSide = await executor.query<{ hit: number }>(
    `SELECT 1 AS hit
       FROM tenant_pics tp
       JOIN tenant_companies tc
         ON tc.id = tp.tenant_company_id
        AND tc.client_id = $2
        AND tc.status = 'ACTIVE'
       JOIN users u
         ON u.id = tp.user_id
        AND u.status = 'ACTIVE'
      WHERE tp.user_id = $1
        AND tp.tenant_company_id = $3
        AND tp.status = 'ACTIVE'
      LIMIT 1`,
    [input.actorUserId, input.clientId, input.tenantCompanyId],
  );
  return customerSide.rows.length > 0;
}

export async function assertQuotationVersionCustomerVisibility(
  executor: Pick<PoolClient, 'query'> = getPool(),
  input: {
    quotation: Pick<HandymanQuotationRecord, 'clientId' | 'handymanRequestId'>;
    versionStatus: string;
    actorUserId: string;
  },
): Promise<void> {
  if (input.versionStatus !== 'DRAFT') return;
  const request = await handymanServiceRequestRepository.findById(
    executor,
    input.quotation.handymanRequestId,
  );
  if (!request) throw handymanQuotationVersionNotFoundError();
  if (!request.tenantCompanyId) return;
  if (
    await isThreadCustomerSideActor(executor, {
      actorUserId: input.actorUserId,
      clientId: input.quotation.clientId,
      tenantCompanyId: request.tenantCompanyId,
    })
  ) {
    // An un-issued DRAFT is not the customer's quotation yet.
    throw handymanQuotationVersionNotFoundError();
  }
}

/**
 * CR-HM-MANUAL-QUOTATION-01 PART 03E — Operations-only commercial write law.
 *
 * FROZEN business rule: only an explicitly authorized Handyman Operations
 * actor may create, price, revise and issue a quotation. A customer (Tenant
 * PIC) may NEVER touch quotation items, quantities, prices, discounts, DP or
 * commercial terms — not even on a DRAFT — and holding `tenant_company.manage`
 * does not change that, because the tenant-side manage permission is the
 * vocabulary BOTH sides carry: it authorizes the commercial SURFACE, this law
 * decides WHO may write commercial content on it.
 *
 * Two legs, evaluated in this order, on the service (so no route, internal
 * caller or future surface can bypass them):
 *
 *   1. CUSTOMER-SIDE EXCLUSION — the actor is an active User linked to an
 *      active Tenant PIC of the thread's own tenant company: refused. This is
 *      deliberately checked FIRST so a dual-role actor (a PIC who also holds
 *      `tenant_company.manage`) fails closed rather than being treated as
 *      Operations.
 *   2. OPERATIONS AUTHORITY — otherwise the actor must hold
 *      `tenant_company.manage`, the repository's existing vocabulary for an
 *      authorized Handyman commercial writer (the same code the quotation and
 *      unlisted-intake Operations routes already require, and the code
 *      `assertHandymanCustomerScopeAuthority` uses for the tenant side). An
 *      actor with no such grant is refused: no quotation write is implied by
 *      Building access, ownership, a Care permission or an internal call.
 *
 * What this law never touches: the customer's OWN commercial acts — the
 * APPROVE/REJECT decision on an ISSUED version (which stays PIC-personal and
 * is refused for every non-PIC actor, so Operations can never approve on the
 * customer's behalf) and the read/visibility law of PART 03D. It adds no new
 * permission, role, error code or response schema; refusals are 403
 * PERMISSION_DENIED, which the reused RBAC layer can already answer on these
 * operations.
 */
export async function assertHandymanQuotationPricingAuthority(
  context: {
    clientId: string;
    handymanRequestId: string;
    actorUserId: string;
    /** Supplied by callers that already hold the request row. */
    tenantCompanyId?: string | null;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<void> {
  let tenantCompanyId = context.tenantCompanyId;
  if (tenantCompanyId === undefined) {
    const request = await handymanServiceRequestRepository.findById(
      executor,
      context.handymanRequestId,
    );
    tenantCompanyId = request?.tenantCompanyId ?? null;
  }
  if (tenantCompanyId) {
    const customerSide = await isThreadCustomerSideActor(executor, {
      actorUserId: context.actorUserId,
      clientId: context.clientId,
      tenantCompanyId,
    });
    if (customerSide) {
      throw new AppError({
        statusCode: 403,
        code: ERROR_CODES.PERMISSION_DENIED,
        message:
          'Quotation items, quantities, prices, DP and commercial terms are authored by authorized Handyman Operations; a customer or Tenant PIC may not create, modify or issue a quotation (not even a DRAFT). Decide an issued quotation instead.',
      });
    }
  }
  const permissions = await permissionRepository.listActivePermissionCodesForUser(
    context.actorUserId,
    executor as never,
  );
  if (!permissions.includes('tenant_company.manage')) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.PERMISSION_DENIED,
      message:
        'Quotation commercial writes require an explicitly authorized Handyman Operations actor (tenant_company.manage with exact-Building access).',
    });
  }
}
