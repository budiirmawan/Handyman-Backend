/**
 * CR-BE-FX-01 PART 01 — FX Rate Authority domain types.
 *
 * GOVERNANCE: docs/CR-BE-FX-01_START_GOVERNANCE.md §3, §4, §5, §6, §13, §14.1.
 *
 * ============================================================================
 * CANONICAL CONVENTION — FROZEN (§3)
 *
 *   1 BASE = RATE x QUOTE
 *
 * `rate` is the number of QUOTE units equal to ONE unit of BASE.
 *
 *   base = USD, quote = IDR, rate = 16500   =>   1 USD = 16 500 IDR
 *   base = IDR, quote = USD, rate = 0.000061538461538462
 *                                           =>   1 IDR = 0.0000615... USD
 *
 * Multiplication is the ONLY conversion primitive. Division exists solely on
 * the governed INVERSE path, which PART 01 does not implement.
 *
 * This file intentionally contains NO arithmetic. It defines the vocabulary and
 * the shape of the authority; the single governed conversion function arrives
 * in PART 03.
 * ============================================================================
 */

/**
 * The frozen rate-type vocabulary (§5). FX-01 supports exactly ONE type.
 *
 * `SPOT` / `DAILY` were rejected (they collapse into effective-date selection),
 * `MONTH_END` / `ACCOUNTING` were rejected (no fiscal-period authority, no GL),
 * and `CONTRACTUAL` was rejected (`work_contracts` carries no currency). A new
 * type may be added only by a CR proving a consumer that effective-date
 * selection cannot serve.
 */
export const FX_RATE_TYPES = ['REFERENCE'] as const;

export type FxRateType = (typeof FX_RATE_TYPES)[number];

export function isFxRateType(value: unknown): value is FxRateType {
  return typeof value === 'string' && (FX_RATE_TYPES as readonly string[]).includes(value);
}

/**
 * The frozen lifecycle (§4, §5).
 *
 *   PENDING_APPROVAL -> ACTIVE | REJECTED
 *   ACTIVE             -> SUPERSEDED | INACTIVE
 *   REJECTED / SUPERSEDED / INACTIVE are terminal.
 *
 * PART 01 establishes the vocabulary and the DB-enforced invariants only; the
 * transition commands are PART 02.
 */
export const FX_RATE_STATUSES = [
  'PENDING_APPROVAL',
  'ACTIVE',
  'REJECTED',
  'SUPERSEDED',
  'INACTIVE',
] as const;

export type FxRateStatus = (typeof FX_RATE_STATUSES)[number];

export function isFxRateStatus(value: unknown): value is FxRateStatus {
  return typeof value === 'string' && (FX_RATE_STATUSES as readonly string[]).includes(value);
}

/** Statuses a rate may be created in. Everything else requires a transition. */
export const FX_RATE_INITIAL_STATUSES = ['PENDING_APPROVAL'] as const;

export type FxRateInitialStatus = (typeof FX_RATE_INITIAL_STATUSES)[number];

/** Terminal statuses: no transition out of these is ever valid. */
export const FX_RATE_TERMINAL_STATUSES = ['REJECTED', 'SUPERSEDED', 'INACTIVE'] as const;

export type FxRateTerminalStatus = (typeof FX_RATE_TERMINAL_STATUSES)[number];

export function isFxRateTerminalStatus(value: unknown): value is FxRateTerminalStatus {
  return (
    typeof value === 'string' &&
    (FX_RATE_TERMINAL_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The frozen lifecycle transition table, expressed as data so the DB trigger
 * and any future service-layer guard share one definition.
 */
export const FX_RATE_TRANSITIONS: Readonly<Record<FxRateStatus, readonly FxRateStatus[]>> = {
  PENDING_APPROVAL: ['ACTIVE', 'REJECTED'],
  ACTIVE: ['SUPERSEDED', 'INACTIVE'],
  REJECTED: [],
  SUPERSEDED: [],
  INACTIVE: [],
};

export function isValidFxRateTransition(from: FxRateStatus, to: FxRateStatus): boolean {
  return (FX_RATE_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * The provider seam (§13). FX-01 ships MANUAL_TREASURY only.
 *
 * A future provider (Bank Indonesia, ERP, external FX API) adds a value here
 * and an adapter that writes PENDING_APPROVAL rows. A provider may PROPOSE but
 * may never ACTIVATE — no automated path may write status = 'ACTIVE'.
 */
export const FX_RATE_SOURCES = ['MANUAL_TREASURY'] as const;

export type FxRateSource = (typeof FX_RATE_SOURCES)[number];

export function isFxRateSource(value: unknown): value is FxRateSource {
  return typeof value === 'string' && (FX_RATE_SOURCES as readonly string[]).includes(value);
}

/**
 * Append-only rate audit vocabulary (§14.1). Client-scoped FX *policy* events
 * deliberately live in `operational_events` via `recordOperationalEvent`
 * (§14.2) and are NOT part of this list.
 */
export const FX_RATE_EVENT_TYPES = [
  'FX_RATE_CREATED',
  'FX_RATE_APPROVED',
  'FX_RATE_REJECTED',
  'FX_RATE_SUPERSEDED',
  'FX_RATE_DEACTIVATED',
] as const;

export type FxRateEventType = (typeof FX_RATE_EVENT_TYPES)[number];

export function isFxRateEventType(value: unknown): value is FxRateEventType {
  return (
    typeof value === 'string' &&
    (FX_RATE_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Rate precision, in database decimal digits (§3).
 *
 * A rate is a RATIO, not a monetary amount, so the repository's NUMERIC(18,2)
 * monetary convention deliberately does not apply.
 */
export const FX_RATE_NUMERIC_PRECISION = 24;
export const FX_RATE_NUMERIC_SCALE = 12;

/** The maximum number of decimals a submitted rate may carry. */
export const FX_RATE_MAX_DECIMALS = FX_RATE_NUMERIC_SCALE;

/** The largest integer part a NUMERIC(24,12) rate can hold. */
export const FX_RATE_MAX_INTEGER_DIGITS = FX_RATE_NUMERIC_PRECISION - FX_RATE_NUMERIC_SCALE;

/** A persisted FX rate row, as read from `fx_rates`. */
export type FxRate = {
  id: string;
  baseCurrencyCode: string;
  quoteCurrencyCode: string;
  rateType: FxRateType;
  /** Stored as NUMERIC(24,12); returned as a string to avoid float drift. */
  rate: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: FxRateStatus;
  source: FxRateSource;
  sourceReference: string | null;
  ingestedAt: Date | null;
  supersedesRateId: string | null;
  supersededByRateId: string | null;
  createdByUserId: string;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  rejectedByUserId: string | null;
  rejectedAt: Date | null;
  rejectedReason: string | null;
  supersededByUserId: string | null;
  supersededAt: Date | null;
  deactivatedByUserId: string | null;
  deactivatedAt: Date | null;
  deactivationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Insert shape for a newly PROPOSED rate (PART 02 owns the command surface). */
export type NewFxRate = {
  id: string;
  baseCurrencyCode: string;
  quoteCurrencyCode: string;
  rate: string;
  effectiveFrom: Date | string;
  effectiveTo?: Date | string | null;
  source: FxRateSource;
  sourceReference?: string | null;
  createdByUserId: string;
};

/** Read filter for the rate authority. All fields optional; fail-closed reads. */
export type FxRateFilters = {
  baseCurrencyCode?: string;
  quoteCurrencyCode?: string;
  rateType?: FxRateType;
  status?: FxRateStatus;
  source?: FxRateSource;
  /** Selects rates whose window covers this instant. */
  effectiveAt?: Date | string;
  limit?: number;
  offset?: number;
};

/** A row of the append-only `fx_rate_events` ledger. */
export type FxRateEvent = {
  id: string;
  fxRateId: string;
  eventType: FxRateEventType;
  actorUserId: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
  occurredAt: Date;
  createdAt: Date;
};

/** A Client FX policy row (§6). Fail closed when absent. */
export type ClientFxPolicy = {
  clientId: string;
  fxEnabled: boolean;
  reportingCurrencyCode: string;
  permittedSources: FxRateSource[];
  inversePermitted: boolean;
  maxStalenessDays: number | null;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Insert/update shape for a Client FX policy (PART 02 owns the command). */
export type UpsertClientFxPolicyInput = {
  clientId: string;
  fxEnabled: boolean;
  reportingCurrencyCode: string;
  permittedSources: FxRateSource[];
  inversePermitted: boolean;
  maxStalenessDays?: number | null;
  actorUserId: string;
};
