/**
 * CR-HM-10 PART 02 — evidence/QC/defect persistence types.
 * FROZEN governance `CR-HM-10_START_GOVERNANCE.md` D2–D3. There is
 * NO runtime command service in this PART — these types only name
 * the persisted rows and the legal write payloads.
 * The lists below give the frozen vocabulary; every value is also
 * DB-CHECK enforced.
 */

export const HANDYMAN_EVIDENCE_STAGES = [
  'BEFORE',
  'DURING',
  'AFTER',
  'QC',
  'DEFECT',
  'RECTIFICATION',
  'MATERIAL',
] as const;
export type HandymanEvidenceStage =
  (typeof HANDYMAN_EVIDENCE_STAGES)[number];

export const HANDYMAN_EVIDENCE_MEDIA_KINDS = [
  'PHOTO',
  'DOCUMENT',
  'VIDEO',
] as const;
export type HandymanEvidenceMediaKind =
  (typeof HANDYMAN_EVIDENCE_MEDIA_KINDS)[number];

export const HANDYMAN_EVIDENCE_EVENT_TYPES = [
  'CREATE',
  'FILE_ADD',
  'FINALIZE',
] as const;
export type HandymanEvidenceEventType =
  (typeof HANDYMAN_EVIDENCE_EVENT_TYPES)[number];

export const HANDYMAN_QC_RUN_STATUSES = [
  'OPEN',
  'PASSED',
  'FAILED',
] as const;
export type HandymanQcRunStatus =
  (typeof HANDYMAN_QC_RUN_STATUSES)[number];

export const HANDYMAN_QC_ITEM_OUTCOMES = [
  'PASS',
  'DEFECT',
  'NA',
  'NOT_CHECKED',
] as const;
export type HandymanQcItemOutcome =
  (typeof HANDYMAN_QC_ITEM_OUTCOMES)[number];

export const HANDYMAN_QC_RUN_EVENT_TYPES = [
  'OPEN',
  'ITEM_SET',
  'FINISH',
] as const;
export type HandymanQcRunEventType =
  (typeof HANDYMAN_QC_RUN_EVENT_TYPES)[number];

export const HANDYMAN_DEFECT_STATUSES = [
  'OPENED',
  'RECTIFYING',
  'RECTIFIED',
  'VERIFIED',
] as const;
export type HandymanDefectStatus =
  (typeof HANDYMAN_DEFECT_STATUSES)[number];

export const HANDYMAN_DEFECT_EVENT_TYPES = [
  'OPEN_DEFECT',
  'START_RECTIFICATION',
  'RECORD_RECTIFICATION',
  'REQUEST_REINSPECTION',
  'PASS_REINSPECTION',
] as const;
export type HandymanDefectEventType =
  (typeof HANDYMAN_DEFECT_EVENT_TYPES)[number];

/** Persisted evidence record row (aggregate A head). */
export type HandymanEvidenceRecordRecord = {
  id: string;
  clientId: string;
  executionScopeId: string;
  sessionId: string | null;
  stage: HandymanEvidenceStage;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewHandymanEvidenceRecord = {
  clientId: string;
  executionScopeId: string;
  sessionId: string | null;
  stage: HandymanEvidenceStage;
  description?: string | null;
};

/** Persisted evidence file row (immutable, storage reference only). */
export type HandymanEvidenceFileRecord = {
  id: string;
  recordId: string;
  mediaKind: HandymanEvidenceMediaKind;
  storageKey: string;
  contentType: string;
  byteSize: number;
  sha256Digest: string;
  captureTime: string | null;
  createdAt: string;
};

export type NewHandymanEvidenceFile = {
  recordId: string;
  mediaKind: HandymanEvidenceMediaKind;
  storageKey: string;
  contentType: string;
  byteSize: number;
  sha256Digest: string;
  captureTime?: string | null;
};

export type HandymanEvidenceEventRecord = {
  id: string;
  recordId: string;
  clientId: string;
  eventType: HandymanEvidenceEventType;
  idempotencyKey: string;
  actorUserId: string;
  occurredAt: string;
  createdAt: string;
};

export type NewHandymanEvidenceEvent = {
  recordId: string;
  clientId: string;
  eventType: HandymanEvidenceEventType;
  idempotencyKey: string;
  actorUserId: string;
};

/** Persisted QC run row (aggregate B head). */
export type HandymanQcRunRecord = {
  id: string;
  clientId: string;
  executionScopeId: string;
  sessionId: string | null;
  checklistIdentity: string;
  status: HandymanQcRunStatus;
  createdAt: string;
  updatedAt: string;
};

export type NewHandymanQcRun = {
  clientId: string;
  executionScopeId: string;
  sessionId: string | null;
  checklistIdentity: string;
};

export type HandymanQcRunItemRecord = {
  id: string;
  runId: string;
  itemKey: string;
  outcome: HandymanQcItemOutcome;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewHandymanQcRunItem = {
  runId: string;
  itemKey: string;
  outcome: HandymanQcItemOutcome;
  note?: string | null;
};

export type HandymanQcRunEventRecord = {
  id: string;
  runId: string;
  clientId: string;
  eventType: HandymanQcRunEventType;
  idempotencyKey: string;
  actorUserId: string;
  occurredAt: string;
  createdAt: string;
};

export type NewHandymanQcRunEvent = {
  runId: string;
  clientId: string;
  eventType: HandymanQcRunEventType;
  idempotencyKey: string;
  actorUserId: string;
};

/** Persisted defect record row (aggregate C head). */
export type HandymanDefectRecordRecord = {
  id: string;
  clientId: string;
  executionScopeId: string;
  runId: string | null;
  itemId: string | null;
  description: string;
  status: HandymanDefectStatus;
  createdAt: string;
  updatedAt: string;
};

export type NewHandymanDefectRecord = {
  clientId: string;
  executionScopeId: string;
  runId: string | null;
  itemId: string | null;
  description: string;
};

export type HandymanDefectEventRecord = {
  id: string;
  defectId: string;
  clientId: string;
  eventType: HandymanDefectEventType;
  idempotencyKey: string;
  actorUserId: string;
  occurredAt: string;
  createdAt: string;
};

export type NewHandymanDefectEvent = {
  defectId: string;
  clientId: string;
  eventType: HandymanDefectEventType;
  idempotencyKey: string;
  actorUserId: string;
};
