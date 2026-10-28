import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { permissionRepository } from '../permissions';
import { parseRecordCustomerPaymentBody } from '../handyman-customer-ledger-api/handyman-customer-ledger-api.validation';
import { recordHandymanCustomerPayment } from '../handyman-customer-payments';
import { handymanCustomerPaymentConflictError } from '../handyman-customer-payments/handyman-customer-payment.errors';

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) throw AppError.validation(`Invalid ${field}.`);
  return value.toLowerCase();
}
type Invoice = { id: string; transaction_id: string; client_id: string; building_id: string };
async function authorizedInvoice(tx: PoolClient, actor: string, scope: string, invoice: string, permission: string): Promise<Invoice> {
  const row = (await tx.query<Invoice>(`SELECT id,transaction_id,client_id,building_id FROM handyman_official_invoices
    WHERE id=$1 AND execution_scope_id=$2`, [invoice, scope])).rows[0];
  if (!row) throw AppError.notFound('Official Handyman invoice not found.');
  const user = (await tx.query<{ status: string }>('SELECT status FROM users WHERE id=$1', [actor])).rows[0];
  const permissions = await permissionRepository.listActivePermissionCodesForUser(actor, tx);
  if (user?.status !== 'ACTIVE' || !permissions.includes(permission)) {
    throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403, message: 'Finance authority is required.' });
  }
  await assertBuildingScopedResourceAccess(actor, { clientId: row.client_id, buildingId: row.building_id }, tx);
  return row;
}

/** Finance may independently report an observed bank receipt without any
 * customer upload. This only records PENDING: the existing Finance confirm and
 * reconciliation commands remain separate explicit actions. */
export async function recordObservedOfficialInvoicePayment(actorInput: string, scopeInput: string, invoiceInput: string, body: unknown) {
  const actor = uuid(actorInput, 'actorUserId'), scope = uuid(scopeInput, 'executionScopeId'), invoice = uuid(invoiceInput, 'invoiceId');
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k =>
    !['amount', 'channel', 'obligationStage', 'providerName', 'providerReference', 'externalReference', 'idempotencyKey'].includes(k))) {
    throw AppError.validation('Only payment claim fields are accepted.');
  }
  const parsed = parseRecordCustomerPaymentBody(body);
  if (parsed.channel !== 'BANK_TRANSFER' || !parsed.externalReference) {
    throw AppError.validation('An observed bank transfer and its payment reference are required.');
  }
  const result = await recordHandymanCustomerPayment({ executionScopeId: scope, ...parsed }, actor, async tx => {
    const i = await authorizedInvoice(tx, actor, scope, invoice, 'handyman.finance.manage');
    // A pre-invoice idempotency replay must already have an explicit link;
    // do not silently reinterpret an old claim as a new observed receipt.
    const old = (await tx.query<{ linked: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM handyman_official_invoice_payment_links l WHERE l.payment_id=e.payment_id AND l.invoice_id=$3) AS linked
      FROM handyman_customer_payment_events e WHERE e.transaction_id=$1 AND e.event_type='RECORD_PAYMENT' AND e.idempotency_key=$2`,
    [i.transaction_id, parsed.idempotencyKey, i.id])).rows[0];
    if (old && !old.linked) throw handymanCustomerPaymentConflictError('payment-not-linked-to-official-invoice');
  });
  return { ...result, verificationStatus: result.payment.status === 'PENDING' ? 'PENDING_VERIFICATION' : result.payment.status };
}

/** Explicit, idempotent Finance reconciliation of an existing payment to the
 * one exact immutable invoice. No amount is copied and nothing is confirmed. */
export async function linkOfficialInvoicePayment(actorInput: string, scopeInput: string, invoiceInput: string, paymentInput: string) {
  const actor = uuid(actorInput, 'actorUserId'), scope = uuid(scopeInput, 'executionScopeId');
  const invoice = uuid(invoiceInput, 'invoiceId'), payment = uuid(paymentInput, 'paymentId');
  try {
    return await withTransaction(async tx => {
      const i = await authorizedInvoice(tx, actor, scope, invoice, 'handyman.finance.manage');
      await tx.query('SELECT id FROM handyman_customer_transactions WHERE id=$1 FOR UPDATE', [i.transaction_id]);
      const p = (await tx.query<{ id: string; status: string }>(`SELECT id,status FROM handyman_customer_payments
        WHERE id=$1 AND transaction_id=$2 AND client_id=$3 FOR UPDATE`, [payment, i.transaction_id, i.client_id])).rows[0];
      if (!p) throw AppError.notFound('Payment not found in this invoice transaction.');
      const existing = (await tx.query<{ invoice_id: string }>(
        'SELECT invoice_id FROM handyman_official_invoice_payment_links WHERE payment_id=$1', [payment])).rows[0];
      if (existing) {
        if (existing.invoice_id !== invoice) throw handymanCustomerPaymentConflictError('payment-already-linked-to-another-invoice');
        return { invoiceId: invoice, paymentId: payment, status: p.status, replayed: true };
      }
      await tx.query(`INSERT INTO handyman_official_invoice_payment_links(payment_id,invoice_id,linked_by_user_id)
        VALUES($1,$2,$3)`, [payment, invoice, actor]);
      return { invoiceId: invoice, paymentId: payment, status: p.status, replayed: false };
    });
  } catch (error) {
    if (!(error instanceof AppError) && ['23505', '23514', '40001', '40P01'].includes((error as { code?: string }).code ?? '')) {
      throw handymanCustomerPaymentConflictError('invoice-payment-binding-requires-unambiguous-reference-and-corrected-allocations');
    }
    throw error;
  }
}

/** A read-only, exact-scope projection. Only verified, linked and non-reversed
 * allocation facts contribute; excess and unlinked funds remain visible. */
export async function readOfficialInvoicePaymentStatus(actorInput: string, scopeInput: string, invoiceInput: string) {
  const actor = uuid(actorInput, 'actorUserId'), scope = uuid(scopeInput, 'executionScopeId'), invoice = uuid(invoiceInput, 'invoiceId');
  return withTransaction(async tx => {
    const i = await authorizedInvoice(tx, actor, scope, invoice, 'handyman.finance.read');
    const row = (await tx.query(`SELECT invoice_id AS "invoiceId", status, currency AS "currencyCode",
      invoice_total::text AS "invoiceTotal", applied_amount::text AS "appliedAmount", outstanding_amount::text AS "outstandingAmount",
      verified_received_amount::text AS "verifiedReceivedAmount", unallocated_verified_amount::text AS "unallocatedVerifiedAmount",
      excess_funds_amount::text AS "excessFundsAmount", unlinked_allocation_amount::text AS "unlinkedAllocationAmount",
      unlinked_verified_amount::text AS "unlinkedVerifiedAmount", unlinked_verified_count AS "unlinkedVerifiedCount"
      FROM handyman_official_invoice_payment_status WHERE invoice_id=$1 AND client_id=$2 AND building_id=$3`,
    [i.id, i.client_id, i.building_id])).rows[0];
    if (!row) throw AppError.notFound('Official Handyman invoice not found.');
    return row;
  });
}
