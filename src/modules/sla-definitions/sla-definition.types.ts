import type { WorkOrderPriority } from '../work-orders';
export const SLA_DEFINITION_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export const SLA_OPERATIONAL_TYPES = ['WORK_ORDER'] as const;
export type SlaDefinitionStatus = (typeof SLA_DEFINITION_STATUSES)[number];
export type SlaOperationalType = (typeof SLA_OPERATIONAL_TYPES)[number];
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
