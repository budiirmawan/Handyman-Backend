/**
 * CR-HM-FINANCE-BANK-RECEIPT-ATTESTATION-01 — Bank receipt attestation types.
 *
 * Immutable audit trail that Finance creates when verifying funds actually
 * entered the destination account. Each attestation is 1:1 with a payment.
 */

export type HandymanBankReceiptAttestationRecord = {
  id: string;
  clientId: string;
  transactionId: string;
  paymentId: string;
  destinationBankAccountId: string;
  bankTransactionId: string;
  amountCredited: string; // NUMERIC(18,2) canonical decimal string
  currency: string;
  bankCreditedAt: string; // ISO
  verifiedByUserId: string;
  verifiedAt: string; // ISO server time
  bankStatementEvidenceRef: string | null;
  createdAt: string;
};

export type HandymanBankReceiptAttestationInput = {
  destinationBankAccountId: string;
  bankTransactionId: string;
  amountCredited: string;
  bankCreditedAt: string;
  bankStatementEvidenceRef?: string | null;
};

export type ConfirmHandymanCustomerPaymentWithAttestationInput = {
  executionScopeId: string;
  paymentId: string;
  idempotencyKey: string;
  attestation: HandymanBankReceiptAttestationInput;
};
