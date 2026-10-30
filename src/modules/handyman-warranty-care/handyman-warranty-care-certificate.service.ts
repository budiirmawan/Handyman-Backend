import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { resolveBuildingsForUser } from '../building-assignments';
import { isValidUuid } from '../clients';
import { careAuthorityDeniedError, HANDYMAN_CARE_BUILDING_PERMISSION } from '../handyman-care-authority';
import { permissionRepository } from '../permissions';
import { userRepository } from '../users';
import {
  listWarrantyCertificatesForCareLookup, readWarrantyCertificateForCareLookup,
  type WarrantyCertificateLookupScope,
} from '../handyman-warranty-certificates/handyman-warranty-certificate.service';

type Selection = { tenantCompanyId: string | null; requestId: string | null };
type LookupQuery = Selection & { limit: number; cursor: string | null };

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) throw AppError.validation(`A valid ${name} is required.`);
  return value.trim().toLowerCase();
}
function optionalUuid(value: unknown, name: string): string | null {
  return value === undefined ? null : uuid(value, name);
}
function parseQuery(query: Record<string, unknown>, body: unknown, list: boolean): LookupQuery {
  if (body != null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length))
    throw AppError.validation('GET endpoints do not accept a request body.');
  const allowed = list ? ['tenantCompanyId', 'requestId', 'limit', 'cursor'] : ['tenantCompanyId', 'requestId'];
  if (Object.keys(query).some(key => !allowed.includes(key))) throw AppError.validation('Unexpected lookup query parameter.');
  const tenantCompanyId = optionalUuid(query.tenantCompanyId, 'tenantCompanyId');
  const requestId = optionalUuid(query.requestId, 'requestId');
  if (!tenantCompanyId && !requestId) throw AppError.validation('tenantCompanyId or requestId is required.');
  let limit = 20;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^[1-9][0-9]*$/.test(query.limit) ||
        !Number.isSafeInteger(Number(query.limit)) || Number(query.limit) > 20)
      throw AppError.validation('limit must be an integer from 1 to 20.');
    limit = Number(query.limit);
  }
  return { tenantCompanyId, requestId, limit, cursor: optionalUuid(query.cursor, 'cursor') };
}

/** Use the same active-user, Care-permission and exact-assignment resolvers as
 * Building Care, but read them in the same snapshot as the certificate. */
async function resolveSelection(
  tx: PoolClient, actorUserId: string, buildingId: string, selection: Selection,
): Promise<WarrantyCertificateLookupScope> {
  const user = await userRepository.findById(actorUserId, tx);
  const permissions = await permissionRepository.listActivePermissionCodesForUser(actorUserId, tx);
  if (user?.status !== 'ACTIVE' || !permissions.includes(HANDYMAN_CARE_BUILDING_PERMISSION)) throw careAuthorityDeniedError();
  const assignment = (await resolveBuildingsForUser(actorUserId, tx)).find(entry => entry.building.id === buildingId);
  const clientId = assignment?.client?.id;
  if (!clientId) throw careAuthorityDeniedError();
  const lineage = await tx.query(`SELECT 1 FROM buildings b JOIN properties p ON p.id=b.property_id
    JOIN clients c ON c.id=p.client_id WHERE b.id=$1 AND c.id=$2
      AND b.status='ACTIVE' AND p.status='ACTIVE' AND c.status='ACTIVE'`, [buildingId, clientId]);
  if (!lineage.rowCount) throw careAuthorityDeniedError();

  let tenantCompanyId = selection.tenantCompanyId;
  if (selection.requestId) {
    // The existing complaint intake also scopes a request by its exact Client
    // and Building; historical tenancy need not still be active for that read.
    const request = (await tx.query<{ tenant_company_id: string }>(`SELECT r.tenant_company_id
      FROM handyman_service_requests r JOIN tenant_companies t ON t.id=r.tenant_company_id AND t.client_id=r.client_id
      WHERE r.id=$1 AND r.client_id=$2 AND r.building_id=$3
        AND ($4::uuid IS NULL OR r.tenant_company_id=$4)`,
    [selection.requestId, clientId, buildingId, tenantCompanyId])).rows[0];
    if (!request) throw AppError.notFound('Warranty request or tenant not found in this building.');
    tenantCompanyId = request.tenant_company_id;
  } else {
    // A tenant selection is valid only for an active effective Building
    // context or an actual historical request in this exact Building.
    const tenant = await tx.query(`SELECT t.id FROM tenant_companies t WHERE t.id=$1 AND t.client_id=$2 AND (
      (t.status='ACTIVE' AND EXISTS (SELECT 1 FROM tenant_building_contexts bc
        WHERE bc.tenant_company_id=t.id AND bc.building_id=$3 AND bc.status='ACTIVE'
          AND (bc.effective_from IS NULL OR bc.effective_from<=now())
          AND (bc.effective_until IS NULL OR bc.effective_until>=now())))
      OR EXISTS (SELECT 1 FROM handyman_service_requests r WHERE r.tenant_company_id=t.id
        AND r.client_id=$2 AND r.building_id=$3))`, [tenantCompanyId, clientId, buildingId]);
    if (!tenant.rowCount) throw AppError.notFound('Warranty request or tenant not found in this building.');
  }
  // parseQuery requires at least one selector; a matched request supplies the tenant.
  if (!tenantCompanyId) throw AppError.notFound('Warranty request or tenant not found in this building.');
  return { clientId, buildingId, tenantCompanyId, requestId: selection.requestId };
}

export async function listCareWarrantyCertificates(
  actorUserId: string, buildingInput: unknown, query: Record<string, unknown>, body: unknown,
) {
  const buildingId = uuid(buildingInput, 'buildingId'), selection = parseQuery(query, body, true);
  return withTransaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const scope = await resolveSelection(tx, actorUserId, buildingId, selection);
    return listWarrantyCertificatesForCareLookup(tx, scope, selection.limit, selection.cursor);
  });
}

export async function getCareWarrantyCertificate(
  actorUserId: string, buildingInput: unknown, certificateInput: unknown, query: Record<string, unknown>, body: unknown,
) {
  const buildingId = uuid(buildingInput, 'buildingId'), certificateId = uuid(certificateInput, 'certificateId');
  const selection = parseQuery(query, body, false);
  return withTransaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const scope = await resolveSelection(tx, actorUserId, buildingId, selection);
    return readWarrantyCertificateForCareLookup(tx, scope, certificateId);
  });
}
