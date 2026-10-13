import { AppError, ERROR_CODES } from '../../shared/errors';
import { resolveCareWorkspacePrincipal, workspaceUnauthorized } from './care-workspace.service';
import { parseCareHandymanPaymentProofSelection } from './care-workspace-payment-proof.service';
import { careWorkspaceOperationalRepository } from './care-workspace-operational.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requestUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw AppError.validation('Invalid Care request identifier.');
  }
  return value.toLowerCase();
}

/** Selected-request read model only; no lifecycle decisions or write APIs. */
export async function getCareWorkspaceOperationalProjection(
  token: string,
  requestInput: unknown,
  query: unknown,
  body?: unknown,
) {
  const principal = await resolveCareWorkspacePrincipal(token);
  const requestId = requestUuid(requestInput);
  if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0)) {
    throw AppError.validation('Care read projections do not accept a request body.');
  }
  const selection = parseCareHandymanPaymentProofSelection(query);
  const result = await careWorkspaceOperationalRepository.readOperationalProjection(
    principal, requestId, selection);
  if (!result?.authenticated) throw workspaceUnauthorized();
  if (!result.data) throw new AppError({
    code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND,
    message: 'Care workspace resource not found.', statusCode: 404,
  });
  return { ...result.data, evaluatedAt: result.evaluatedAt };
}
