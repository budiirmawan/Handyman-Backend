/**
 * BE-25D — Mobile Checklist Contract types.
 *
 * A mobile read-model contract for checklist execution: checklist/task
 * reference, checklist items, item status/value, measurement/UOM where
 * applicable, evidence requirements, execution status, and
 * backend-authoritative available actions.
 *
 * Composition only — no separate mobile checklist engine. Item UOM and
 * evidence requirements reuse the authoritative BE-07 definitions (always
 * null/[] when not configured).
 */

export type MobileChecklistItemType = 'CHECK' | 'BOOLEAN' | 'TEXT' | 'NUMBER';

export type MobileChecklistItemStatus = 'PENDING' | 'ANSWERED';

export type MobileChecklistUom = {
  id: string;
  code: string;
  name: string;
  symbol: string;
  category: string;
};

export type MobileChecklistMeasurement = {
  uom: MobileChecklistUom | null;
  minimumValue: number | null;
  maximumValue: number | null;
  decimalPrecision: number | null;
};

/** One checklist item with its current response value/status. */
export type MobileChecklistItem = {
  id: string;
  code: string;
  label: string;
  itemType: MobileChecklistItemType;
  required: boolean;
  displayOrder: number;
  status: string;
  /** Item status within this execution. */
  itemStatus: MobileChecklistItemStatus;
  /** Stored response value (boolean / number / string per itemType). */
  value: boolean | number | string | null;
  result: string | null;
  notes: string | null;
  /** Measurement / UOM where applicable (NUMBER items; else null). */
  measurement: MobileChecklistMeasurement | null;
  /** Evidence requirements bound to this item. */
  evidenceRequirements: MobileChecklistEvidenceRequirement[];
};

export type MobileChecklistEvidenceRequirement = {
  id: string;
  evidenceType: 'PHOTO' | 'DOCUMENT' | 'SIGNATURE';
  required: boolean;
  minimumCount: number;
  maximumCount: number | null;
  description: string | null;
};

/** Template reference of the execution. */
export type MobileChecklistTemplateReference = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
};

/** Task reference of the execution, when it exists. */
export type MobileChecklistTaskReference = {
  taskId: string;
  scheduleDefinitionId: string | null;
  occurrenceAt: string;
  targetId: string;
  buildingId: string | null;
  taskStatus: string;
};

/** The full mobile checklist execution contract. */
export type MobileChecklistExecution = {
  /** Checklist execution id. */
  id: string;
  clientId: string;
  checklist: MobileChecklistTemplateReference;
  task: MobileChecklistTaskReference | null;
  /** Execution status (DRAFT / IN_PROGRESS / COMPLETED / CANCELLED). */
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Template items (ACTIVE, ordered) with response values/status. */
  items: MobileChecklistItem[];
  /**
   * Evidence requirements bound to the execution's template (target type
   * CHECKLIST_TEMPLATE / CHECKLIST_ITEM, active). Evidence submission
   * itself is the BE-25E contract.
   */
  evidenceRequirements: MobileChecklistEvidenceRequirement[];
  /** Backend-authoritative actions (START / SAVE_RESPONSES / COMPLETE / CANCEL). */
  availableActions: string[];
};
