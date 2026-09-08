import type { WorkOrderPriority } from '../work-orders';
import type { RecipientScope, RecipientSpec } from '../recipient-resolution';
/** CR-BE-SLA-02 PART 01 — escalation configuration vocabulary only; nothing here is executed. */
export const SLA_ESCALATION_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export const SLA_ESCALATION_OPERATIONAL_TYPES = ['WORK_ORDER'] as const;
export const SLA_ESCALATION_CLOCK_TYPES = ['RESPONSE', 'RESOLUTION', 'ANY'] as const;
/** Derived recipient targets are CONFIGURATION VOCABULARY ONLY in PART 01: stored and validated, never resolved. */
export const SLA_ESCALATION_DERIVED_TARGET_KINDS = ['WORK_ORDER_ASSIGNEE','WORK_ORDER_ASSIGNEE_SUPERVISOR','WORK_ORDER_CREATOR','BUILDING_ROLE','BUILDING_PERMISSION'] as const;
export type SlaEscalationStatus = (typeof SLA_ESCALATION_STATUSES)[number];
export type SlaEscalationOperationalType = (typeof SLA_ESCALATION_OPERATIONAL_TYPES)[number];
export type SlaEscalationClockType = (typeof SLA_ESCALATION_CLOCK_TYPES)[number];
export type SlaEscalationDerivedTargetKind = (typeof SLA_ESCALATION_DERIVED_TARGET_KINDS)[number];
export type SlaEscalationDerivedTarget = {kind:SlaEscalationDerivedTargetKind;roleCode?:string;permissionCode?:string};
/** BE-26C rule shape plus the derived-target extension; stored verbatim, expanded in a later PART. */
export type SlaEscalationRecipientRule = {specs:RecipientSpec[];derived?:SlaEscalationDerivedTarget[];scope?:RecipientScope};
export type SlaEscalationPolicyRecord = {
  id:string; clientId:string; buildingId:string|null; code:string; name:string; description:string|null;
  operationalType:SlaEscalationOperationalType; clockType:SlaEscalationClockType; workType:string|null; priority:WorkOrderPriority|null;
  status:SlaEscalationStatus; effectiveFrom:Date; effectiveTo:Date|null; createdAt:Date; updatedAt:Date;
};
export type PublicSlaEscalationPolicy = Omit<SlaEscalationPolicyRecord,'effectiveFrom'|'effectiveTo'|'createdAt'|'updatedAt'> & {effectiveFrom:string;effectiveTo:string|null;createdAt:string;updatedAt:string};
export type SlaEscalationLevelRecord = {id:string;policyId:string;level:number;offsetMinutes:number;templateKey:string;recipientRule:SlaEscalationRecipientRule;status:SlaEscalationStatus;createdAt:Date;updatedAt:Date};
export type PublicSlaEscalationLevel = Omit<SlaEscalationLevelRecord,'createdAt'|'updatedAt'> & {createdAt:string;updatedAt:string};
export type CreateSlaEscalationPolicyInput = {clientId:string;buildingId?:string;code:string;name:string;description?:string;operationalType:SlaEscalationOperationalType;clockType:SlaEscalationClockType;workType?:string;priority?:WorkOrderPriority;status?:SlaEscalationStatus;effectiveFrom:string;effectiveTo?:string};
export type UpdateSlaEscalationPolicyInput = Partial<Omit<CreateSlaEscalationPolicyInput,'clientId'|'buildingId'|'code'|'operationalType'>>;
export type SlaEscalationPolicyFilters = {buildingId?:string|null;status?:SlaEscalationStatus;clockType?:SlaEscalationClockType;priority?:WorkOrderPriority};
export type CreateSlaEscalationLevelInput = {policyId:string;level:number;offsetMinutes?:number;templateKey:string;recipientRule:SlaEscalationRecipientRule;status?:SlaEscalationStatus};
export type UpdateSlaEscalationLevelInput = Partial<Omit<CreateSlaEscalationLevelInput,'policyId'>>;
