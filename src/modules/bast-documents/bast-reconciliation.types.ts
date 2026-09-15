export const BAST_RECONCILIATION_CLASSIFICATIONS = [
  'CANONICAL_ONLY',
  'LEGACY_ONLY',
  'LINKED_CONSISTENT',
  'DIVERGENT_CONTEXT',
  'DIVERGENT_LIFECYCLE',
  'DUPLICATE_NUMBER',
  'DUPLICATE_ACCEPTANCE_SCOPE',
  'CONTRADICTORY_SIGN_OFF',
  'MISSING_REFERENCE',
  'MISSING_VERSION',
  'CLOSED_BEFORE_ACCEPTED',
  'ORPHAN',
  'AMBIGUOUS_WORK_RELATIONSHIP',
  'CROSS_SCOPE_SECURITY_MISMATCH',
] as const;

export type BastReconciliationClassification =
  (typeof BAST_RECONCILIATION_CLASSIFICATIONS)[number];

export type BastReconciliationSeverity = 'INFO' | 'WARNING' | 'ERROR';

export type BastReconciliationItem = {
  classification: BastReconciliationClassification;
  severity: BastReconciliationSeverity;
  canonicalBastDocumentId: string | null;
  legacyVendorBastBindingId: string | null;
  bastNumber: string | null;
  message: string;
};

export type BastReconciliationInventory = {
  buildingId: string;
  generatedAt: string;
  readOnly: true;
  summary: {
    total: number;
    byClassification: Partial<Record<BastReconciliationClassification, number>>;
    bySeverity: Record<BastReconciliationSeverity, number>;
  };
  items: BastReconciliationItem[];
};
