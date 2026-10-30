import { AppError, ERROR_CODES } from '../../shared/errors';
import { handymanServiceRequestRepository } from '../handyman-requests/handyman-service-request.repository';
import { toCustomerCarePublic } from '../handyman-requests/handyman-service-request.service';
import { resolveCareWorkspacePrincipal, workspaceUnauthorized } from './care-workspace.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => AppError.validation('Invalid care request detail query.');
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value.toLowerCase();
}

/** Credential authenticates only the care actor. Selected context and stored
 * request must match current grant/occupancy in the authorized projection. */
export async function getCareWorkspaceRequestDetail(token: string, requestInput: unknown, query: unknown, body?: unknown) {
  const principal = await resolveCareWorkspacePrincipal(token);
  const requestId = uuid(requestInput);
  if (!query || typeof query !== 'object' || Array.isArray(query) ||
      (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length))) throw invalid();
  const q = query as Record<string, unknown>;
  if (Object.keys(q).some(k => !['propertyId', 'tenantCompanyId', 'buildingId', 'spaceId'].includes(k))) throw invalid();
  const selection = { propertyId: uuid(q.propertyId), tenantCompanyId: uuid(q.tenantCompanyId),
    buildingId: uuid(q.buildingId), spaceId: q.spaceId === undefined ? null : uuid(q.spaceId) };
  const result = await handymanServiceRequestRepository.findWorkspaceProjectionById(principal, requestId, selection);
  if (!result.authenticated) throw workspaceUnauthorized();
  if (!result.item) throw new AppError({ code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND,
    message: 'Care workspace resource not found.', statusCode: 404 });
  if (result.receiptConflict || !result.finalReceipt) throw new AppError({
    code: ERROR_CODES.HANDYMAN_FINAL_RECEIPT_INTEGRITY_ERROR, statusCode: 409,
    message: 'Final Receipt discovery has ambiguous or conflicting invoice/request lineage.',
  });
  if (result.paymentReceiptConflict) throw new AppError({
    code: ERROR_CODES.HANDYMAN_TENANT_RECEIPT_INTEGRITY_ERROR, statusCode: 409,
    message: 'Payment Receipt discovery has ambiguous or conflicting payment/request lineage.',
  });
  return { ...toCustomerCarePublic(result.item), items: result.item.items ?? [],
    finalReceipt: result.finalReceipt, paymentReceipts: result.paymentReceipts };
}
