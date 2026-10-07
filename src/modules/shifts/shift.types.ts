/**
 * BE-03E — Shift domain types.
 *
 * A Shift is a named working window operated at one Building (e.g. MORNING
 * 07:00–15:00). It is a definition only. A Shift is never inferred from a Team,
 * a Position, or a Role, and it carries no attendance, payroll, overtime,
 * leave, timesheet, roster, or scheduling behaviour.
 *
 * Times are wall-clock `HH:MM:SS` strings with no date and no zone — the
 * Building supplies the timezone. `endTime < startTime` is a legitimate
 * overnight shift.
 */
export const SHIFT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

export function isShiftStatus(value: unknown): value is ShiftStatus {
  return (
    typeof value === 'string' &&
    (SHIFT_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type ShiftRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  status: ShiftStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicShift = {
  id: string;
  clientId: string;
  buildingId: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  status: ShiftStatus;
};

/** Input supplied by the API consumer when creating a Shift. */
export type CreateShiftInput = {
  clientId: string;
  buildingId: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  status?: ShiftStatus;
};

/** Fully-resolved data ready for persistence. */
export type NewShift = {
  clientId: string;
  buildingId: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  status: ShiftStatus;
};

export type UpdateShiftStatusInput = {
  status: ShiftStatus;
};
