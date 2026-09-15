/**
 * BE-12L — Security Lost & Found domain types.
 *
 * Two tables back this PART:
 *   - `security_lost_found`         — the Lost & Found master record
 *   - `security_lost_found_history` — append-oriented claim / custody history
 *
 * The Lost & Found record's `custody_status` is authoritative on the
 * master row. History is append-oriented: each custody / claim / return
 * / dispose / close event inserts a new history row, and historical
 * rows are never overwritten or deleted. The "current state" is the
 * master row's `custody_status`, and the most recent history row is
 * the most recent transition.
 *
 * No inventory / warehouse / procurement / costing logic. No personal
 * data is stored — the claimant's name is a free-form text field for
 * traceability only, never a foreign key to a personal-data store.
 */

export const SECURITY_LOST_FOUND_STATUSES = [
  'FOUND',
  'IN_CUSTODY',
  'CLAIMED',
  'RETURNED',
  'DISPOSED',
  'CLOSED',
] as const;

export type SecurityLostFoundStatus = (typeof SECURITY_LOST_FOUND_STATUSES)[number];

export function isSecurityLostFoundStatus(
  value: unknown,
): value is SecurityLostFoundStatus {
  return (
    typeof value === 'string' &&
    (SECURITY_LOST_FOUND_STATUSES as readonly string[]).includes(value)
  );
}

/* Allowed transitions between custody statuses. The terminal states
 * (DISPOSED, CLOSED, RETURNED) are not reversible. CLAIMED is
 * reversible only via the dedicated verify + return flow (which moves
 * the master row from CLAIMED to RETURNED). */
export const SECURITY_LOST_FOUND_TRANSITIONS: Readonly<
  Record<SecurityLostFoundStatus, readonly SecurityLostFoundStatus[]>
> = {
  FOUND: ['IN_CUSTODY', 'CLAIMED', 'DISPOSED', 'CLOSED'],
  IN_CUSTODY: ['CLAIMED', 'DISPOSED', 'CLOSED'],
  CLAIMED: ['RETURNED', 'DISPOSED', 'CLOSED'],
  RETURNED: ['CLOSED'],
  DISPOSED: [],
  CLOSED: [],
};

export function isLostFoundTransitionAllowed(
  from: SecurityLostFoundStatus,
  to: SecurityLostFoundStatus,
): boolean {
  return (SECURITY_LOST_FOUND_TRANSITIONS[from] ?? []).includes(to);
}

export const SECURITY_LOST_FOUND_HISTORY_EVENT_TYPES = [
  'CREATE',
  'CUSTODY_PLACE',
  'CLAIM_REGISTER',
  'CLAIM_VERIFY',
  'RETURN',
  'DISPOSE',
  'CLOSE',
] as const;

export type SecurityLostFoundHistoryEventType =
  (typeof SECURITY_LOST_FOUND_HISTORY_EVENT_TYPES)[number];

export function isSecurityLostFoundHistoryEventType(
  value: unknown,
): value is SecurityLostFoundHistoryEventType {
  return (
    typeof value === 'string' &&
    (SECURITY_LOST_FOUND_HISTORY_EVENT_TYPES as readonly string[]).includes(
      value,
    )
  );
}

/* ------------------------------------------------------------------ */
/*  Lost & Found master record                                        */
/* ------------------------------------------------------------------ */

export type SecurityLostFoundRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  securityPostId: string | null;
  functionalLocationId: string | null;
  itemCode: string;
  itemName: string;
  description: string | null;
  foundAt: Date;
  foundByUserId: string;
  custodyStatus: SecurityLostFoundStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Safe public representation exposed through the API. The claimant
 * name / reference is intentionally NOT a field on the master row —
 * it lives on the append-oriented history rows, and is read through
 * the history endpoint. This keeps the master row free of any
 * claimant PII.
 */
export type PublicSecurityLostFound = {
  id: string;
  clientId: string;
  buildingId: string;
  securityPostId: string | null;
  functionalLocationId: string | null;
  itemCode: string;
  itemName: string;
  description: string | null;
  foundAt: string;
  foundByUserId: string;
  custodyStatus: SecurityLostFoundStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateSecurityLostFoundInput = {
  buildingId: string;
  securityPostId?: string | null;
  functionalLocationId?: string | null;
  itemCode: string;
  itemName: string;
  description?: string | null;
  foundAt?: string | null;
  foundByUserId: string;
  notes?: string | null;
};

export type UpdateSecurityLostFoundInput = {
  securityPostId?: string | null;
  functionalLocationId?: string | null;
  itemName?: string;
  description?: string | null;
  notes?: string | null;
};

export type SecurityLostFoundListFilters = {
  buildingId?: string;
  securityPostId?: string;
  custodyStatus?: SecurityLostFoundStatus;
  fromDate?: string;
  toDate?: string;
};

/* ------------------------------------------------------------------ */
/*  Lost & Found history / claim record                                */
/* ------------------------------------------------------------------ */

export type SecurityLostFoundHistoryRecord = {
  id: string;
  lostFoundId: string;
  eventType: SecurityLostFoundHistoryEventType;
  claimantName: string | null;
  claimantReference: string | null;
  claimNotes: string | null;
  verifiedByUserId: string | null;
  returnedByUserId: string | null;
  returnedAt: Date | null;
  occurredAt: Date;
  notes: string | null;
  createdAt: Date;
};

/**
 * Safe public representation of a Lost & Found history row. The
 * claimant name / reference is exposed ONLY through this history
 * surface, never on the master Lost & Found record. This keeps the
 * PII surface small and prevents the master list endpoint from
 * leaking claimant data.
 */
export type PublicSecurityLostFoundHistory = {
  id: string;
  lostFoundId: string;
  eventType: SecurityLostFoundHistoryEventType;
  claimantName: string | null;
  claimantReference: string | null;
  claimNotes: string | null;
  verifiedByUserId: string | null;
  returnedByUserId: string | null;
  returnedAt: string | null;
  occurredAt: string;
  notes: string | null;
  createdAt: string;
};

export type PlaceCustodyInput = {
  lostFoundId: string;
  notes?: string | null;
  actorUserId: string;
};

export type RegisterClaimInput = {
  lostFoundId: string;
  claimantName: string;
  claimantReference?: string | null;
  claimNotes?: string | null;
  notes?: string | null;
  actorUserId: string;
};

export type ReturnLostFoundInput = {
  lostFoundId: string;
  returnedByUserId: string;
  notes?: string | null;
};

export type CloseLostFoundInput = {
  lostFoundId: string;
  notes?: string | null;
  actorUserId: string;
};
