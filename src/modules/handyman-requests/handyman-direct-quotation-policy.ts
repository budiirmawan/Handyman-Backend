import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { permissionDeniedError } from '../auth/auth.errors';
import { permissionService } from '../permissions';
import { userRepository } from '../users';
import type { ServiceInspectionPolicy } from '../service-catalog/service-catalog.types';
import type { CreateHandymanRequestTriageInput } from './handyman-request-triage.types';
import type { HandymanServiceRequestRecord } from './handyman-service-request.types';
import { handymanRequestTriageRepository } from './handyman-request-triage.repository';

export function directQuotationPolicyRequired(): AppError {
  return new AppError({ code: ERROR_CODES.HANDYMAN_DIRECT_QUOTATION_NOT_AUTHORIZED,
    statusCode: 409,
    message: 'Direct preparation requires the selected service to permit it and a persisted Operations scope-clarity decision.' });
}

/** Service-call protection too: HTTP admission is not the sole authority. */
async function assertActorPermission(actorUserId: string, permission: string) {
  const user = await userRepository.findById(actorUserId);
  if (user?.status !== 'ACTIVE' || !(await permissionService.resolvePermissionsForUser(actorUserId)).includes(permission)) {
    throw permissionDeniedError();
  }
}

/** Under the request lock, serialize policy sampling with catalog edits. */
export async function resolveTriagePolicy(
  tx: Pick<PoolClient, 'query'>,
  request: HandymanServiceRequestRecord,
  input: CreateHandymanRequestTriageInput,
  actorUserId: string,
) {
  const direct = input.triageDisposition === 'DIAGNOSIS';
  if (direct) await assertActorPermission(actorUserId, 'handyman.operations.request.triage');
  const result = await tx.query<{
    id: string; client_id: string; status: string;
    inspection_policy: ServiceInspectionPolicy; updated_at: Date;
  }>('SELECT id, client_id, status, inspection_policy, updated_at FROM service_catalog WHERE id = $1 FOR SHARE', [request.serviceCatalogId]);
  const service = result.rows[0];
  const usable = service?.status === 'ACTIVE' && service.client_id === request.clientId;
  // Missing, inactive, foreign or unconfigured services never imply permission.
  const policy = usable ? service.inspection_policy : 'INSPECTION_REQUIRED';
  const reason = typeof input.directQuotationReason === 'string' ? input.directQuotationReason.trim() : '';
  if (direct && (policy !== 'DIRECT_ALLOWED' || !usable)) throw directQuotationPolicyRequired();
  if (direct && (input.scopeClarityConfirmed !== true || reason.length < 20 || reason.length > 500 || reason.split(/\s+/u).length < 3)) {
    throw AppError.validation('Direct quotation requires explicit scope clarity and a meaningful exception reason.', [
      { field: 'scopeClarityConfirmed', message: 'Must be the boolean true for direct quotation.' },
      { field: 'directQuotationReason', message: 'Provide a specific reason (20-500 characters and at least three words); a triage note alone is insufficient.' },
    ]);
  }
  return {
    serviceInspectionPolicy: policy,
    policyServiceCatalogId: usable ? service.id : null,
    policyCatalogUpdatedAt: usable ? service.updated_at : null,
    scopeClarityConfirmed: direct ? true : null,
    directQuotationReason: direct ? reason : null,
  };
}

/** No current catalog re-evaluation: triage's immutable snapshot is authority.
 * Historical direct rows lacking provenance stay readable but cannot authorize
 * new diagnosis/DRAFT writes. Inspection rows continue through PART C unchanged.
 * Caller holds request lock and has already checked exact-Building access.
 */
export async function assertDirectQuotationAuthorization(
  tx: Pick<PoolClient, 'query'>,
  requestId: string,
  actorUserId: string,
): Promise<boolean> {
  const triage = await handymanRequestTriageRepository.findByRequest(tx, requestId);
  if (triage?.triageDisposition === 'INSPECTION_REQUIRED') return false;
  await assertActorPermission(actorUserId, 'tenant_company.manage');
  const result = await tx.query<{ allowed: boolean }>(
    'SELECT handyman_has_direct_quotation_authority($1) AS allowed', [requestId],
  );
  if (result.rows[0]?.allowed !== true) throw directQuotationPolicyRequired();
  return true;
}
