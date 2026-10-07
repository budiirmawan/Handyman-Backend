import type { SlaOperationalType } from '../sla-definitions/sla-definition.types';
export type SlaClockType='RESPONSE'|'RESOLUTION';export type SlaClockStatus='RUNNING'|'SATISFIED'|'TERMINATED';
export type AppliedSlaRecord={id:string;slaDefinitionId:string;workOrderId:string|null;subjectId:string|null;clientId:string;buildingId:string;definitionCode:string;operationalType:SlaOperationalType;definitionWorkType:string|null;definitionPriority:string|null;workOrderWorkType:string|null;workOrderPriority:string|null;subjectWorkType:string|null;subjectPriority:string|null;responseTargetMinutes:number|null;resolutionTargetMinutes:number|null;definitionEffectiveFrom:Date;definitionEffectiveTo:Date|null;appliedAt:Date;createdAt:Date};
export type SlaPauseIntervalRecord={id:string;slaClockId:string;pausedAt:Date;resumedAt:Date|null;pauseSource:'WORK_ORDER_ON_HOLD'|'SUBJECT_ON_HOLD';pauseActorUserId:string|null;resumeActorUserId:string|null;createdAt:Date;updatedAt:Date};
export type SlaClockRecord={id:string;appliedSlaId:string;clockType:SlaClockType;targetMinutes:number;startedAt:Date;status:SlaClockStatus;satisfiedAt:Date|null;terminatedAt:Date|null;breachedAt:Date|null;createdAt:Date;updatedAt:Date};
export type PublicSlaClock=Omit<SlaClockRecord,'startedAt'|'satisfiedAt'|'terminatedAt'|'breachedAt'|'createdAt'|'updatedAt'>&{startedAt:string;satisfiedAt:string|null;terminatedAt:string|null;breachedAt:string|null;createdAt:string;updatedAt:string;isPaused:boolean;totalPausedMilliseconds:number;effectiveElapsedMilliseconds:number;pauseIntervals:Array<Omit<SlaPauseIntervalRecord,'pausedAt'|'resumedAt'|'createdAt'|'updatedAt'>&{pausedAt:string;resumedAt:string|null;createdAt:string;updatedAt:string}>};
export type PublicAppliedSla=Omit<AppliedSlaRecord,'definitionEffectiveFrom'|'definitionEffectiveTo'|'appliedAt'|'createdAt'>&{definitionEffectiveFrom:string;definitionEffectiveTo:string|null;appliedAt:string;createdAt:string;clocks:PublicSlaClock[]};
/**
 * CR-HM-16 PART 01 — generic subject binding for the shared SLA engine.
 * `subjectType` is the engine's operational-type registry
 * (`SlaOperationalType`); `subjectId` is the caller-authoritative entity id
 * (Work Order id for 'WORK_ORDER', Handyman subject id otherwise). No FK to
 * any Handyman/FM table exists — the binding is polymorphic by design.
 */
export type SlaSubjectBinding={subjectType:SlaOperationalType;subjectId:string;clientId:string;buildingId:string;workType?:string|null;priority?:string|null;createdAt:Date};
export type SlaSubjectRef=Omit<SlaSubjectBinding,'createdAt'>;
