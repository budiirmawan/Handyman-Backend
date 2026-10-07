/**
 * CR-BE-MOB-05 PART 03 — Security Operational Logbook domain types.
 *
 * The authoritative Security logbook entry for mobile Security
 * operations. Each entry binds the authenticated Workforce Profile
 * (BE-03C), the Building it belongs to (BE-02F/G access-asserted), and —
 * when supplied — a valid existing authoritative `shift_handovers.id` row
 * in the SAME Building. `recordedAt` is always backend-set (database
 * clock); client-supplied timestamps are never accepted.
 *
 * Lifecycle (minimal, backend-authoritative):
 *   OPEN → CLOSED
 * Updates are allowed only while OPEN; CLOSED is terminal and preserved.
 *
 * Deliberately out of scope: patrol, checkpoint, incident management,
 * visitor management, attendance, QR, GPS, push, offline sync, supervisor
 * dashboard, Management Read Models, mobile facades, mock fallback.
 */

export const SECURITY_LOGBOOK_STATUSES = ['OPEN', 'CLOSED'] as const;

export type SecurityLogbookStatus =
  (typeof SECURITY_LOGBOOK_STATUSES)[number];

export function isSecurityLogbookStatus(
  value: unknown,
): value is SecurityLogbookStatus {
  return (
    typeof value === 'string' &&
    (SECURITY_LOGBOOK_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Classification vocabulary only — the backend branches no behavior on a
 * category. No patrol / incident / finding engine is implied.
 */
export const SECURITY_LOGBOOK_CATEGORIES = [
  'GENERAL',
  'INCIDENT',
  'PATROL',
  'HANDOVER',
  'FINDING',
] as const;

export type SecurityLogbookCategory =
  (typeof SECURITY_LOGBOOK_CATEGORIES)[number];

export function isSecurityLogbookCategory(
  value: unknown,
): value is SecurityLogbookCategory {
  return (
    typeof value === 'string' &&
    (SECURITY_LOGBOOK_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Full database record (raw, no display joins). */
export type SecurityLogbookEntryRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  workforceProfileId: string;
  shiftHandoverId: string | null;
  category: SecurityLogbookCategory;
  summary: string;
  detail: string | null;
  status: SecurityLogbookStatus;
  recordedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicSecurityLogbookEntry = {
  /** `security_logbook_entries.id` — the authoritative logbook row. */
  id: string;
  /** `clients.id` — derived Building → Property → Client, never caller-supplied. */
  clientId: string;
  /** `buildings.id` — the Building the entry belongs to. */
  buildingId: string;
  buildingCode: string;
  buildingName: string;
  /** `workforce_profiles.id` — resolved from the authenticated session. */
  workforceProfileId: string;
  employeeCode: string;
  /** `shift_handovers.id` when a valid same-Building handover was bound. */
  shiftHandoverId: string | null;
  category: SecurityLogbookCategory;
  summary: string;
  detail: string | null;
  status: SecurityLogbookStatus;
  /** Backend-set database timestamp (ISO-8601). Never client-supplied. */
  recordedAt: string;
  createdAt: string;
  updatedAt: string;
};

/** Input for creating an entry at a Building. */
export type CreateSecurityLogbookEntryInput = {
  buildingId: string;
  category: SecurityLogbookCategory;
  summary: string;
  detail?: string | null;
  /** Optional existing authoritative `shift_handovers.id` (same Building). */
  shiftHandoverId?: string | null;
};

/** Partial update; only OPEN entries accept updates. */
export type UpdateSecurityLogbookEntryInput = {
  category?: SecurityLogbookCategory;
  summary?: string;
  detail?: string | null;
  status?: SecurityLogbookStatus;
  shiftHandoverId?: string | null;
};

/** List filters (all optional). */
export type SecurityLogbookListFilters = {
  status?: SecurityLogbookStatus;
  category?: SecurityLogbookCategory;
  /** ISO-8601 date (YYYY-MM-DD, UTC day) or datetime; inclusive lower bound. */
  dateFrom?: string;
  /** ISO-8601 date (YYYY-MM-DD, UTC day, inclusive of that day) or datetime. */
  dateTo?: string;
};
