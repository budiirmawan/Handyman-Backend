export {
  captureHandymanTaxIdentity,
  closeHandymanTaxIdentity,
  decideHandymanTaxIdentityApproval,
  listHandymanTaxIdentityApprovalHistory,
  listHandymanTaxIdentityHistory,
  requireApprovedHandymanTaxIdentityAt,
  resolveHandymanTaxIdentityAt,
  submitHandymanTaxIdentityForApproval,
} from './handyman-tax-identity.service';
export type {
  ApprovedHandymanTaxIdentity,
  TaxIdentityApprovalCommand,
  TaxIdentityApprovalEvent,
  TaxIdentityDecisionCommand,
} from './handyman-tax-identity-approval.types';
export type {
  CaptureHandymanTaxIdentityInput,
  HandymanTaxIdentityOwner,
  HandymanTaxIdentitySnapshot,
  HandymanTaxIdentityView,
  IndividualResidency,
  PkpStatus,
  TaxIdentifierKind,
  TaxpayerKind,
} from './handyman-tax-identity.types';
