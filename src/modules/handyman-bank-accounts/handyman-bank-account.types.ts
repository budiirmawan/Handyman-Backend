/**
 * CR-HM-FINANCE-BANK-RECEIPT-ATTESTATION-01 — Destination bank account types.
 *
 * A configured payment destination is an OWNED bank account of the client
 * (optionally building-scoped). Finance manages them; the confirmation path
 * validates that the destination account belongs to the payment's client
 * (and building when scoped). No external bank API integration.
 */

export type HandymanBankAccountRecord = {
  id: string;
  clientId: string;
  buildingId: string | null;
  bankName: string;
  accountNumber: string;
  /** Masked for reads (last 4 visible); full value never exposed except to Finance with explicit need. */
  maskedAccountNumber: string;
  accountHolderName: string;
  displayName: string;
  currency: string;
  isActive: boolean;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/** Internal DB row with full account number (only service layer sees it). */
export type HandymanBankAccountRow = {
  id: string;
  clientId: string;
  buildingId: string | null;
  bankName: string;
  accountNumber: string;
  accountHolderName: string;
  displayName: string;
  currency: string;
  isActive: boolean;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateHandymanBankAccountInput = {
  clientId: string;
  buildingId?: string | null;
  bankName: string;
  accountNumber: string;
  accountHolderName: string;
  displayName: string;
  currency: string;
};

export type ListHandymanBankAccountsInput = {
  clientId: string;
  buildingId?: string | null;
  includeInactive?: boolean;
};

export function maskAccountNumber(accountNumber: string): string {
  const trimmed = accountNumber.trim();
  if (trimmed.length <= 4) return '****';
  return '****' + trimmed.slice(-4);
}
