/**
 * BE-10J — Shift Handover domain types.
 *
 * A Shift Handover links an outgoing and an incoming BE-03 Shift and carries
 * a DRAFT → READY → ACKNOWLEDGED lifecycle. The operational content is
 * resolved live from the authoritative Engineering records at read time —
 * never copied into the handover table. Only the summary and lifecycle
 * fields are stored, for traceability.
 */

export const SHIFT_HANDOVER_STATUSES = [
  'DRAFT',
  'READY',
  'ACKNOWLEDGED',
] as const;

export type ShiftHandoverStatus = (typeof SHIFT_HANDOVER_STATUSES)[number];

export function isShiftHandoverStatus(
  value: unknown,
): value is ShiftHandoverStatus {
  return (
    typeof value === 'string' &&
    (SHIFT_HANDOVER_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type ShiftHandoverRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  handoverDate: string;
  preparedByUserId: string;
  acknowledgedByUserId: string | null;
  summary: string | null;
  status: ShiftHandoverStatus;
  preparedAt: Date;
  acknowledgedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** One unresolved operational item, referenced from its authoritative record. */
export type HandoverItem = {
  kind:
    | 'WORK_ORDER'
    | 'BREAKDOWN'
    | 'FINDING'
    | 'INSPECTION'
    | 'CHECKLIST'
    | 'METER_READING'
    | 'EQUIPMENT_LOG'
    | 'MAINTENANCE'
    | 'TASK';
  id: string;
  referenceNumber: string | null;
  title: string;
  /** Current authoritative status from the source record (never translated). */
  status: string;
  assetCode: string | null;
};

/** The live Engineering operational dataset for the handover's Building. */
export type HandoverDataset = {
  activeWorkOrders: HandoverItem[];
  openBreakdowns: HandoverItem[];
  openFindings: HandoverItem[];
  incompleteInspections: HandoverItem[];
  incompleteChecklists: HandoverItem[];
  incompleteMeterReadings: HandoverItem[];
  incompleteLogSheets: HandoverItem[];
  pendingMaintenance: HandoverItem[];
  scheduledTasks: HandoverItem[];
};

/** Safe public representation exposed through the API. */
export type PublicShiftHandover = {
  id: string;
  clientId: string;
  buildingId: string;
  outgoingShift: {
    id: string;
    code: string;
    name: string;
    startTime: string;
    endTime: string;
  };
  incomingShift: {
    id: string;
    code: string;
    name: string;
    startTime: string;
    endTime: string;
  };
  handoverDate: string;
  preparedByUserId: string;
  acknowledgedByUserId: string | null;
  summary: string | null;
  status: ShiftHandoverStatus;
  preparedAt: string;
  acknowledgedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Live authoritative dataset — never stored on the handover. */
  dataset: HandoverDataset;
};

export type CreateShiftHandoverInput = {
  buildingId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  handoverDate: string;
  summary?: string;
  preparedByUserId: string;
};

export type UpdateShiftHandoverInput = {
  summary?: string;
};
