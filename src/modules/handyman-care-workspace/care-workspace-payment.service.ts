import { AppError, ERROR_CODES } from '../../shared/errors';
import { parseRecordCustomerPaymentBody }
  from '../handyman-customer-ledger-api/handyman-customer-ledger-api.validation';
import { recordHandymanCustomerPayment, type HandymanCustomerPaymentRecord }
  from '../handyman-customer-payments';
import { handymanCustomerTransactionScopeNotFoundError }
  from '../handyman-customer-transactions';
import { handymanServiceRequestRepository }
  from '../handyman-requests/handyman-service-request.repository';
import { resolveCareWorkspacePrincipal, workspaceUnauthorized } from './care-workspace.service';

/**
 * CR-HM-CUSTOMER-PAYMENT-REPORT-01 PART 05 — Customer Care payment REPORT
 * through a live workspace session. Report only: the workspace has no
 * confirm/reject path, and the body admits no status, actor, or decision field.
 *
 * Reuses the existing payment engine (`recordHandymanCustomerPayment`); the
 * workspace never writes payment rows itself.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELECTION_KEYS = ['propertyId', 'tenantCompanyId', 'buildingId', 'spaceId'];
const BODY_KEYS = ['amount', 'channel', 'providerName', 'providerReference',
  'externalReference', 'idempotencyKey'];

const invalid = (message = 'Invalid care payment report request.') => AppError.validation(message);

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value.toLowerCase();
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

export async function reportCareWorkspacePayment(
  token: string,
  requestInput: unknown,
  query: unknown,
  body: unknown,
) {
  const principal = await resolveCareWorkspacePrincipal(token);
  const requestId = uuid(requestInput);
  const q = plainObject(query);
  if (Object.keys(q).some((k) => !SELECTION_KEYS.includes(k))) throw invalid();
  const selection = {
    propertyId: uuid(q.propertyId),
    tenantCompanyId: uuid(q.tenantCompanyId),
    buildingId: uuid(q.buildingId),
    spaceId: q.spaceId === undefined ? null : uuid(q.spaceId),
  };
  const raw = plainObject(body);
  if (Object.keys(raw).some((k) => !BODY_KEYS.includes(k))) {
    throw invalid('Care payment report accepts only amount, channel, references, and idempotencyKey.');
  }
  const parsed = parseRecordCustomerPaymentBody(raw);

  const projection = await handymanServiceRequestRepository
    .findWorkspaceProjectionById(principal, requestId, selection);
  if (!projection.authenticated) throw workspaceUnauthorized();
  if (!projection.item) {
    throw new AppError({
      code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND,
      message: 'Care workspace resource not found.',
      statusCode: 404,
    });
  }
  const executionScopeId = projection.item.executionScopeId;
  if (!executionScopeId) throw handymanCustomerTransactionScopeNotFoundError();

  const result = await recordHandymanCustomerPayment(
    {
      executionScopeId,
      amount: parsed.amount,
      channel: parsed.channel,
      providerName: parsed.providerName,
      providerReference: parsed.providerReference,
      externalReference: parsed.externalReference,
      idempotencyKey: parsed.idempotencyKey,
    },
    {
      kind: 'CARE_ACTOR',
      careActorId: principal.careActorId,
      workspaceSessionId: principal.sessionId,
      requestBuildingId: projection.item.buildingId,
    },
  );
  return toCarePaymentPublic(result.payment, result.replayed);
}

/** Minimal projection: no decision fields, no available actions, no user identity. */
function toCarePaymentPublic(payment: HandymanCustomerPaymentRecord, replayed: boolean) {
  return {
    id: payment.id,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    channel: payment.channel,
    providerName: payment.providerName,
    providerReference: payment.providerReference,
    externalReference: payment.externalReference,
    receivedAt: payment.receivedAt,
    recordedByActorType: payment.recordedByActorType,
    recordedByCareActorId: payment.recordedByCareActorId,
    createdAt: payment.createdAt,
    replayed,
  };
}
