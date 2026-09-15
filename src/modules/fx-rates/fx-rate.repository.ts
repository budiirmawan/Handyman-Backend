import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import {
  fxRateActiveWindowConflictError,
  fxRateEffectiveWindowOverlapError,
  fxRateImmutableError,
  fxRateInvalidStatusTransitionError,
  fxRateSelfApprovalError,
} from './fx-rate.errors';
import { validateClientFxPolicyInput, validateNewFxRate } from './fx-rate.validation';
import type {
  ClientFxPolicy,
  FxRate,
  FxRateEvent,
  FxRateFilters,
  FxRateStatus,
  NewFxRate,
  UpsertClientFxPolicyInput,
} from './fx-rate.types';

/**
 * CR-BE-FX-01 PART 01 + PART 02 — FX Rate Authority persistence.
 *
 * GOVERNANCE: docs/CR-BE-FX-01_START_GOVERNANCE.md §4, §6, §14.1, §18, §22.
 *
 * This layer owns SQL only. Authorization, maker-checker policy, event emission
 * and transaction boundaries live in `fx-rate-lifecycle.service.ts`. Every
 * mutation accepts an optional executor so a caller can run several statements
 * plus an audit row inside one transaction — the same pattern as
 * `recordOperationalEvent`.
 *
 * Still deliberately absent: conversion, inverse, rate selection policy
 * (PART 03), and reporting read models (PART 04).
 *
 * The database constraints from `0333` remain the authority. This layer maps a
 * governed violation onto a 4xx/409 instead of leaking a raw Postgres error.
 */

/** Anything able to run a query: the pool, or a transaction client. */
type Executor = Pick<PoolClient, 'query'>;

const FX_RATE_SELECT = `
  id,
  base_currency_code            AS "baseCurrencyCode",
  quote_currency_code           AS "quoteCurrencyCode",
  rate_type                     AS "rateType",
  rate,
  effective_from                AS "effectiveFrom",
  effective_to                  AS "effectiveTo",
  status,
  source,
  source_reference              AS "sourceReference",
  ingested_at                   AS "ingestedAt",
  supersedes_rate_id            AS "supersedesRateId",
  superseded_by_rate_id         AS "supersededByRateId",
  created_by_user_id            AS "createdByUserId",
  approved_by_user_id           AS "approvedByUserId",
  approved_at                   AS "approvedAt",
  rejected_by_user_id           AS "rejectedByUserId",
  rejected_at                   AS "rejectedAt",
  rejected_reason               AS "rejectedReason",
  superseded_by_user_id         AS "supersededByUserId",
  superseded_at                 AS "supersededAt",
  deactivated_by_user_id        AS "deactivatedByUserId",
  deactivated_at                AS "deactivatedAt",
  deactivation_reason           AS "deactivationReason",
  created_at                    AS "createdAt",
  updated_at                    AS "updatedAt"
`;

const CLIENT_FX_POLICY_SELECT = `
  client_id                     AS "clientId",
  fx_enabled                    AS "fxEnabled",
  reporting_currency_code       AS "reportingCurrencyCode",
  permitted_sources             AS "permittedSources",
  inverse_permitted             AS "inversePermitted",
  max_staleness_days            AS "maxStalenessDays",
  created_by_user_id            AS "createdByUserId",
  updated_by_user_id            AS "updatedByUserId",
  created_at                    AS "createdAt",
  updated_at                    AS "updatedAt"
`;

/** Postgres SQLSTATE for an EXCLUDE constraint violation. */
const EXCLUSION_VIOLATION = '23P01';
/** SQLSTATE our own trigger `RAISE ... USING ERRCODE = '23514'` produces. */
const CHECK_VIOLATION = '23514';

function sqlState(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

/** Which lifecycle context a violation happened in, so the remedy is precise. */
type ViolationContext =
  | { kind: 'PROPOSE'; base: string; quote: string }
  | { kind: 'ACTIVATE'; rateId: string; base: string; quote: string };

/**
 * Translates the `0333` structural guards into governed errors so a caller can
 * never see a raw constraint violation. Unknown errors are re-thrown untouched.
 */
function translateFxRateViolation(error: unknown, context: ViolationContext): never {
  const state = sqlState(error);
  const message = errorMessage(error);

  if (state === EXCLUSION_VIOLATION) {
    if (context.kind === 'ACTIVATE') {
      throw fxRateActiveWindowConflictError(context.rateId, context.base, context.quote);
    }
    throw fxRateEffectiveWindowOverlapError(context.base, context.quote);
  }
  if (state === CHECK_VIOLATION) {
    // The maker-checker CHECK is the structural backstop for self-approval.
    if (/approved_by_user_id|maker/i.test(message)) {
      throw fxRateSelfApprovalError(context.kind === 'ACTIVATE' ? context.rateId : 'new');
    }
    if (/immutable/i.test(message)) {
      throw fxRateImmutableError('business fields');
    }
    if (/lifecycle transition|is terminal/i.test(message)) {
      throw fxRateInvalidStatusTransitionError('PENDING_APPROVAL', 'UNKNOWN');
    }
  }
  throw error;
}

/**
 * Exact per-status attribution columns from `0333`.
 *
 * Spelled out rather than derived from the status name, because the schema is
 * NOT uniformly named: the deactivation reason column is `deactivation_reason`,
 * not `deactivated_reason`, and `ACTIVE` / `SUPERSEDED` have no reason column at
 * all. Deriving `${status}_reason` would generate a column that does not exist.
 */
export const TRANSITION_COLUMNS: Readonly<Record<
  string,
  { actor: string; at: string; reason: string | null }
>> = {
  ACTIVE: { actor: 'approved_by_user_id', at: 'approved_at', reason: null },
  REJECTED: { actor: 'rejected_by_user_id', at: 'rejected_at', reason: 'rejected_reason' },
  SUPERSEDED: { actor: 'superseded_by_user_id', at: 'superseded_at', reason: null },
  INACTIVE: { actor: 'deactivated_by_user_id', at: 'deactivated_at', reason: 'deactivation_reason' },
};

export const fxRateRepository = {
  /**
   * Inserts a rate in the only status a new row may hold: `PENDING_APPROVAL`.
   * A provider or a human may PROPOSE; neither may ACTIVATE (§13).
   */
  async insert(input: NewFxRate, executor: Executor = getPool()): Promise<FxRate> {
    const rate = validateNewFxRate(input);
    try {
      const result = await executor.query<FxRate>(
        `INSERT INTO fx_rates (
           id, base_currency_code, quote_currency_code, rate_type, rate,
           effective_from, effective_to, status, source, source_reference,
           created_by_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING_APPROVAL',$8,$9,$10)
         RETURNING ${FX_RATE_SELECT}`,
        [
          input.id,
          rate.baseCurrencyCode,
          rate.quoteCurrencyCode,
          rate.rateType,
          rate.rate,
          rate.effectiveFrom,
          rate.effectiveTo,
          rate.source,
          rate.sourceReference,
          input.createdByUserId,
        ],
      );
      return result.rows[0]!;
    } catch (error) {
      translateFxRateViolation(error, {
        kind: 'PROPOSE',
        base: rate.baseCurrencyCode,
        quote: rate.quoteCurrencyCode,
      });
    }
  },

  /**
   * Inserts a corrected rate that is born ACTIVE, linked to the rate it
   * supersedes. Used only by the supersession command.
   *
   * The caller must already have moved the incumbent out of `ACTIVE` in the same
   * transaction: the GiST exclusion is not deferrable, so an ACTIVE successor
   * cannot be inserted while the incumbent window is still ACTIVE.
   */
  async insertActiveSuccessor(input: {
    id: string;
    baseCurrencyCode: string;
    quoteCurrencyCode: string;
    rate: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    source: FxRate['source'];
    sourceReference: string | null;
    supersedesRateId: string;
    createdByUserId: string;
    approvedByUserId: string;
  }, executor: Executor): Promise<FxRate> {
    try {
      const result = await executor.query<FxRate>(
        `INSERT INTO fx_rates (
           id, base_currency_code, quote_currency_code, rate_type, rate,
           effective_from, effective_to, status, source, source_reference,
           supersedes_rate_id, created_by_user_id, approved_by_user_id, approved_at
         ) VALUES ($1,$2,$3,'REFERENCE',$4,$5,$6,'ACTIVE',$7,$8,$9,$10,$11,NOW())
         RETURNING ${FX_RATE_SELECT}`,
        [
          input.id,
          input.baseCurrencyCode,
          input.quoteCurrencyCode,
          input.rate,
          input.effectiveFrom,
          input.effectiveTo,
          input.source,
          input.sourceReference,
          input.supersedesRateId,
          input.createdByUserId,
          input.approvedByUserId,
        ],
      );
      return result.rows[0]!;
    } catch (error) {
      translateFxRateViolation(error, {
        kind: 'ACTIVATE',
        rateId: input.id,
        base: input.baseCurrencyCode,
        quote: input.quoteCurrencyCode,
      });
    }
  },

  /**
   * Applies one governed status transition, recording the actor. Returns null
   * when the row no longer holds the expected status, so a concurrent
   * transition can never be silently overwritten.
   */
  async transition(input: {
    rateId: string;
    expectedStatus: FxRateStatus;
    nextStatus: FxRateStatus;
    actorUserId: string;
    reason?: string | null;
  }, executor: Executor = getPool()): Promise<FxRate | null> {
    const columns = TRANSITION_COLUMNS[input.nextStatus];
    if (!columns) throw new Error(`No attribution columns for FX rate status ${input.nextStatus}`);
    // A reason is only written where the schema actually has a reason column.
    const withReason = columns.reason !== null && input.reason !== undefined;

    try {
      const result = await executor.query<FxRate>(
        `UPDATE fx_rates SET
           status = $2,
           ${columns.actor} = $3,
           ${columns.at} = NOW(),
           ${withReason ? `${columns.reason} = $5,` : ''}
           updated_at = NOW()
         WHERE id = $1 AND status = $4
         RETURNING ${FX_RATE_SELECT}`,
        withReason
          ? [input.rateId, input.nextStatus, input.actorUserId, input.expectedStatus, input.reason]
          : [input.rateId, input.nextStatus, input.actorUserId, input.expectedStatus],
      );
      return result.rows[0] ?? null;
    } catch (error) {
      const current = await executor.query<Pick<FxRate, 'baseCurrencyCode' | 'quoteCurrencyCode'>>(
        'SELECT base_currency_code AS "baseCurrencyCode", quote_currency_code AS "quoteCurrencyCode" FROM fx_rates WHERE id = $1',
        [input.rateId],
      );
      translateFxRateViolation(error, {
        kind: 'ACTIVATE',
        rateId: input.rateId,
        base: current.rows[0]?.baseCurrencyCode ?? '?',
        quote: current.rows[0]?.quoteCurrencyCode ?? '?',
      });
    }
  },

  /** Links the incumbent to its successor. Called in the supersession transaction. */
  async setSuccessor(
    rateId: string,
    successorId: string,
    executor: Executor,
  ): Promise<FxRate | null> {
    const result = await executor.query<FxRate>(
      `UPDATE fx_rates SET superseded_by_rate_id = $2, updated_at = NOW()
       WHERE id = $1 AND superseded_by_rate_id IS NULL
       RETURNING ${FX_RATE_SELECT}`,
      [rateId, successorId],
    );
    return result.rows[0] ?? null;
  },

  async findByIdWith(executor: Executor, id: string): Promise<FxRate | null> {
    const result = await executor.query<FxRate>(
      `SELECT ${FX_RATE_SELECT} FROM fx_rates WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  },

  async findById(id: string): Promise<FxRate | null> {
    const result = await getPool().query<FxRate>(
      `SELECT ${FX_RATE_SELECT} FROM fx_rates WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Filtered read model over the rate authority. Every filter is optional; the
   * absence of a filter never widens access, because rates are platform-global
   * market facts containing no Client data (§15).
   */
  async list(filters: FxRateFilters = {}): Promise<FxRate[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const push = (clause: string, value: unknown): void => {
      params.push(value);
      clauses.push(clause.replace('?', `$${params.length}`));
    };

    if (filters.baseCurrencyCode) push('base_currency_code = ?', filters.baseCurrencyCode);
    if (filters.quoteCurrencyCode) push('quote_currency_code = ?', filters.quoteCurrencyCode);
    if (filters.rateType) push('rate_type = ?', filters.rateType);
    if (filters.status) push('status = ?', filters.status);
    if (filters.source) push('source = ?', filters.source);
    if (filters.effectiveAt) {
      params.push(filters.effectiveAt);
      const at = `$${params.length}`;
      clauses.push(`effective_from <= ${at} AND (effective_to IS NULL OR effective_to > ${at})`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);

    const result = await getPool().query<FxRate>(
      `SELECT ${FX_RATE_SELECT} FROM fx_rates ${where}
       ORDER BY effective_from DESC, created_at DESC, id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return result.rows;
  },

  /**
   * Read primitive: the ACTIVE rate whose closed-open window covers `at` for an
   * ordered pair. Returns at most one row — the `fx_rates_active_window_exclusion`
   * constraint guarantees it.
   *
   * This is NOT selection policy. There is no latest-rate fallback, no inverse,
   * no source permission and no staleness rule here; an empty result means
   * "no governed rate", which PART 03 turns into a fail-closed outcome.
   */
  async findActiveCovering(
    baseCurrencyCode: string,
    quoteCurrencyCode: string,
    at: Date | string,
  ): Promise<FxRate | null> {
    const result = await getPool().query<FxRate>(
      `SELECT ${FX_RATE_SELECT} FROM fx_rates
       WHERE status = 'ACTIVE'
         AND rate_type = 'REFERENCE'
         AND base_currency_code = $1
         AND quote_currency_code = $2
         AND effective_from <= $3
         AND (effective_to IS NULL OR effective_to > $3)
       ORDER BY effective_from DESC
       LIMIT 1`,
      [baseCurrencyCode, quoteCurrencyCode, at],
    );
    return result.rows[0] ?? null;
  },

  /**
   * CR-BE-FX-01 PART 03 — every ACTIVE REFERENCE rate whose closed-open window
   * covers `at` for an ordered pair.
   *
   * Returns ALL matches rather than the first, so the conversion authority can
   * fail closed on multiplicity (`FX_RATE_AMBIGUOUS`) instead of silently
   * picking one. The `0333` GiST exclusion makes more than one structurally
   * impossible; this is the defence-in-depth guard governance §6 step 8 keeps.
   *
   * There is deliberately no `ORDER BY ... LIMIT 1` fallback here and no
   * widening of the window predicate: a nearest, latest, previous or future rate
   * is never returned by this method.
   */
  async findAllActiveCovering(
    baseCurrencyCode: string,
    quoteCurrencyCode: string,
    at: Date | string,
    executor: Executor = getPool(),
  ): Promise<FxRate[]> {
    const result = await executor.query<FxRate>(
      `SELECT ${FX_RATE_SELECT} FROM fx_rates
       WHERE status = 'ACTIVE'
         AND rate_type = 'REFERENCE'
         AND base_currency_code = $1
         AND quote_currency_code = $2
         AND effective_from <= $3
         AND (effective_to IS NULL OR effective_to > $3)`,
      [baseCurrencyCode, quoteCurrencyCode, at],
    );
    return result.rows;
  },

  /**
   * Diagnostic counts for an ordered pair at an instant, used only to choose the
   * correct fail-closed reason when no rate resolves. Governance §12 requires
   * the caller to be told *why*: unknown pair, no ACTIVE row, not yet effective,
   * or window expired.
   */
  async countPairCoverage(
    baseCurrencyCode: string,
    quoteCurrencyCode: string,
    at: Date | string,
    executor: Executor = getPool(),
  ): Promise<{
    anyStatus: number;
    active: number;
    activeNotYetEffective: number;
    activeExpired: number;
  }> {
    const result = await executor.query<{
      anyStatus: string;
      active: string;
      activeNotYetEffective: string;
      activeExpired: string;
    }>(
      `SELECT
         COUNT(*)::text AS "anyStatus",
         COUNT(*) FILTER (WHERE status = 'ACTIVE')::text AS "active",
         COUNT(*) FILTER (WHERE status = 'ACTIVE' AND effective_from > $3)::text AS "activeNotYetEffective",
         COUNT(*) FILTER (WHERE status = 'ACTIVE' AND effective_to IS NOT NULL AND effective_to <= $3)::text AS "activeExpired"
       FROM fx_rates
       WHERE base_currency_code = $1 AND quote_currency_code = $2`,
      [baseCurrencyCode, quoteCurrencyCode, at],
    );
    const row = result.rows[0];
    return {
      anyStatus: Number(row?.anyStatus ?? '0'),
      active: Number(row?.active ?? '0'),
      activeNotYetEffective: Number(row?.activeNotYetEffective ?? '0'),
      activeExpired: Number(row?.activeExpired ?? '0'),
    };
  },
};

/**
 * The append-only rate audit ledger. There is no update or delete path — the
 * `0333` triggers reject both at the database level.
 */
export const fxRateEventRepository = {
  async append(input: {
    fxRateId: string;
    eventType: FxRateEvent['eventType'];
    actorUserId?: string | null;
    requestId?: string | null;
    metadata?: Record<string, unknown>;
  }, executor: Executor = getPool()): Promise<FxRateEvent> {
    const result = await executor.query<FxRateEvent>(
      `INSERT INTO fx_rate_events (id, fx_rate_id, event_type, actor_user_id, request_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, fx_rate_id AS "fxRateId", event_type AS "eventType",
                 actor_user_id AS "actorUserId", request_id AS "requestId",
                 metadata, occurred_at AS "occurredAt", created_at AS "createdAt"`,
      [
        randomUUID(),
        input.fxRateId,
        input.eventType,
        input.actorUserId ?? null,
        input.requestId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return result.rows[0]!;
  },

  async listForRate(fxRateId: string): Promise<FxRateEvent[]> {
    const result = await getPool().query<FxRateEvent>(
      `SELECT id, fx_rate_id AS "fxRateId", event_type AS "eventType",
              actor_user_id AS "actorUserId", request_id AS "requestId",
              metadata, occurred_at AS "occurredAt", created_at AS "createdAt"
       FROM fx_rate_events WHERE fx_rate_id = $1
       ORDER BY occurred_at ASC, created_at ASC, id ASC`,
      [fxRateId],
    );
    return result.rows;
  },
};

export const clientFxPolicyRepository = {
  /** Absence is meaningful: no policy row means FX fails closed for the Client. */
  async findByClientId(clientId: string): Promise<ClientFxPolicy | null> {
    const result = await getPool().query<ClientFxPolicy>(
      `SELECT ${CLIENT_FX_POLICY_SELECT} FROM client_fx_policies WHERE client_id = $1`,
      [clientId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * The Client's `base_currency_code` from the existing CUR-01 monetary context.
   * Read for validation and display ONLY — it is never injected into a policy.
   */
  async findBaseCurrency(clientId: string): Promise<string | null> {
    const result = await getPool().query<{ baseCurrencyCode: string }>(
      `SELECT base_currency_code AS "baseCurrencyCode"
       FROM client_monetary_contexts WHERE client_id = $1`,
      [clientId],
    );
    return result.rows[0]?.baseCurrencyCode ?? null;
  },

  /**
   * Persistence primitive. The governed command surface — Client access check,
   * `CLIENT_FX_POLICY_SET` / `CLIENT_FX_POLICY_CHANGED` operational event, RBAC
   * and HTTP — lives in `client-fx-policy.service.ts` (PART 02), which owns the
   * transaction so the audit row commits atomically with the policy.
   *
   * Currency liveness, Client allowance and the base-currency equality are
   * enforced by the deferred `client_fx_policy_valid` trigger, so the write and
   * any same-transaction allowed-currency change commit or fail together.
   */
  async upsertWith(executor: Executor, input: UpsertClientFxPolicyInput): Promise<ClientFxPolicy> {
    const policy = validateClientFxPolicyInput(input);
    {
      const result = await executor.query<ClientFxPolicy>(
        `INSERT INTO client_fx_policies (
           client_id, fx_enabled, reporting_currency_code, permitted_sources,
           inverse_permitted, max_staleness_days, created_by_user_id, updated_by_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         ON CONFLICT (client_id) DO UPDATE SET
           fx_enabled = EXCLUDED.fx_enabled,
           reporting_currency_code = EXCLUDED.reporting_currency_code,
           permitted_sources = EXCLUDED.permitted_sources,
           inverse_permitted = EXCLUDED.inverse_permitted,
           max_staleness_days = EXCLUDED.max_staleness_days,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at = NOW()
         RETURNING ${CLIENT_FX_POLICY_SELECT}`,
        [
          policy.clientId,
          policy.fxEnabled,
          policy.reportingCurrencyCode,
          policy.permittedSources,
          policy.inversePermitted,
          policy.maxStalenessDays,
          input.actorUserId,
        ],
      );
      return result.rows[0]!;
    }
  },

  /** Convenience wrapper: runs the upsert in its own transaction. */
  async upsert(input: UpsertClientFxPolicyInput): Promise<ClientFxPolicy> {
    return withTransaction((tx) => clientFxPolicyRepository.upsertWith(tx, input));
  },
};

/**
 * Read-only view of the existing Currency Master (`currencies`, `0331`).
 *
 * FX never duplicates the master. An FX rate leg must be an ACTIVE master code,
 * but — unlike a transaction currency — it is NOT subject to any Client's
 * allowed-currency set, because `fx_rates` is platform-global. This is therefore
 * deliberately not `assertActiveAllowedCurrency`, which also enforces the
 * Client allowance.
 */
export const currencyMasterRepository = {
  async isActive(code: string, executor: Executor = getPool()): Promise<boolean> {
    const result = await executor.query<{ active: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM currencies WHERE code = $1 AND status = 'ACTIVE') AS active`,
      [code],
    );
    return result.rows[0]?.active === true;
  },

  /**
   * CR-BE-FX-01 PART 03 — the ACTIVE master row, including `decimal_precision`.
   *
   * The target currency's `decimal_precision` is the rounding scale governance
   * §3 requires (0 for IDR/JPY, 2 for the rest). It is read from the existing
   * master and never assumed or hardcoded.
   */
  async findActive(
    code: string,
    executor: Executor = getPool(),
  ): Promise<{ code: string; decimalPrecision: number } | null> {
    const result = await executor.query<{ code: string; decimalPrecision: number }>(
      `SELECT code, decimal_precision AS "decimalPrecision" FROM currencies
       WHERE code = $1 AND status = 'ACTIVE'`,
      [code],
    );
    return result.rows[0] ?? null;
  },

  /** Returns the subset of `codes` that are not ACTIVE in the master. */
  async findInactive(codes: string[], executor: Executor = getPool()): Promise<string[]> {
    if (codes.length === 0) return [];
    const result = await executor.query<{ code: string }>(
      `SELECT code FROM currencies WHERE code = ANY($1::varchar(3)[]) AND status = 'ACTIVE'`,
      [codes],
    );
    const active = new Set(result.rows.map((row) => row.code));
    return codes.filter((code) => !active.has(code));
  },
};

/**
 * CR-BE-FX-01 PART 03 — the CUR-01 Client allowed-transaction-currency
 * authority, read-only.
 *
 * An FX conversion may only involve currencies the Client is actually allowed
 * to transact in. This reuses `client_allowed_transaction_currencies` (0331)
 * rather than inventing an FX-specific allowance.
 */
export const clientCurrencyAllowanceRepository = {
  /** Returns the subset of `codes` that the Client is NOT allowed to transact in. */
  async findNotAllowed(
    clientId: string,
    codes: string[],
    executor: Executor = getPool(),
  ): Promise<string[]> {
    if (codes.length === 0) return [];
    const result = await executor.query<{ currencyCode: string }>(
      `SELECT currency_code AS "currencyCode" FROM client_allowed_transaction_currencies
       WHERE client_id = $1 AND currency_code = ANY($2::varchar(3)[])`,
      [clientId, codes],
    );
    const allowed = new Set(result.rows.map((row) => row.currencyCode));
    return codes.filter((code) => !allowed.has(code));
  },
};
