import type { WorkOrderPriority } from '../work-orders';
import { HANDYMAN_SLA_SUBJECT_TYPES, type HandymanSlaSubjectType } from './handyman-sla-subjects';
export const SLA_DEFINITION_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
/** CR-HM-16 PART 01: shared engine subject-type registry — Work Order (FM v1 consumer) + closed Handyman subject vocabulary. */
export const SLA_OPERATIONAL_TYPES = ['WORK_ORDER', ...HANDYMAN_SLA_SUBJECT_TYPES] as const;
export type SlaDefinitionStatus = (typeof SLA_DEFINITION_STATUSES)[number];
export type SlaOperationalType = 'WORK_ORDER' | HandymanSlaSubjectType;
export type SlaDefinitionRecord = {
  id:string; clientId:string; buildingId:string|null; code:string; name:string;
  operationalType:SlaOperationalType; workType:string|null; priority:WorkOrderPriority|null;
  responseTargetMinutes:number|null; resolutionTargetMinutes:number|null;
  status:SlaDefinitionStatus; effectiveFrom:Date; effectiveTo:Date|null; createdAt:Date; updatedAt:Date;
};
export type PublicSlaDefinition = Omit<SlaDefinitionRecord,'effectiveFrom'|'effectiveTo'|'createdAt'|'updatedAt'> & {effectiveFrom:string;effectiveTo:string|null;createdAt:string;updatedAt:string};
export type CreateSlaDefinitionInput = {clientId:string;buildingId?:string;code:string;name:string;operationalType:SlaOperationalType;workType?:string;priority?:WorkOrderPriority;responseTargetMinutes?:number;resolutionTargetMinutes?:number;status?:SlaDefinitionStatus;effectiveFrom:string;effectiveTo?:string};
export type UpdateSlaDefinitionInput = Partial<Omit<CreateSlaDefinitionInput,'clientId'|'buildingId'|'code'|'operationalType'>>;
export type SlaDefinitionFilters = {buildingId?:string|null;status?:SlaDefinitionStatus;operationalType?:SlaOperationalType;priority?:WorkOrderPriority};
