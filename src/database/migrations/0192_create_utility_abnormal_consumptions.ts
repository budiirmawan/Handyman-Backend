import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-18J — Abnormal Consumption.
 *
 * Two tables:
 *
 *   `utility_abnormality_rules` — lightweight, configurable detection rules.
 *   One row per (Client, utility type, abnormality type): a threshold, how to
 *   compare it, and how many prior periods form the baseline. This is
 *   deliberately NOT an analytics or anomaly engine: there is no model, no
 *   training, no scoring, no seasonality. Each rule is a single arithmetic
 *   comparison whose numbers live in data, so tuning detection is a data
 *   operation rather than a code change.
 *
 *   `utility_abnormal_consumptions` — one detected abnormality per
 *   (consumption, abnormality type).
 *
 * Nothing upstream is mutated. Detection reads BE-18G consumptions and the
 * BE-18H chronological history, and writes only its own row: the consumption
 * value, the readings behind it, and any BE-18I calculation are all left
 * exactly as they were. That is why `detected_value` and `reference_value`
 * are stored — they are a snapshot of what the rule saw and what it compared
 * against at detection time, which is the evidence for the flag, not a copy
 * of the source figure. The consumption itself stays reachable through
 * `consumption_id`.
 *
 * Operational follow-up is BE-09's. When a flag needs work, `finding_id`
 * points at a real BE-09 Finding; this module never re-implements finding
 * workflow, status or assignment, and the Finding's own lifecycle and
 * available actions remain BE-09's authority.
 *
 * Status is backend-owned: OPEN → RESOLVED / DISMISSED, both terminal. A
 * partial unique index over (consumption_id, abnormality_type) WHERE status =
 * 'OPEN' makes duplicate detection idempotent — re-evaluating the same
 * consumption cannot pile up identical open flags, while a resolved flag that
 * legitimately recurs can be raised again.
 *
 * Out of scope, deliberately: Verification (BE-18K), tariffs, billing, and
 * any generic anomaly framework.
 */
export const migration0192CreateUtilityAbnormalConsumptions: Migration = {
  id: '0192_create_utility_abnormal_consumptions',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE utility_abnormality_rules (
        id               UUID PRIMARY KEY,
        client_id        UUID NOT NULL REFERENCES clients (id),
        utility_type     TEXT NOT NULL,
        abnormality_type TEXT NOT NULL,
        name             TEXT NOT NULL,
        description      TEXT,
        threshold_value  NUMERIC,
        comparison_mode  TEXT NOT NULL DEFAULT 'ABSOLUTE',
        baseline_window  INTEGER NOT NULL DEFAULT 3,
        status           TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT utility_abnormality_rules_type_check
          CHECK (utility_type IN ('ELECTRICITY', 'WATER', 'GAS')),
        CONSTRAINT utility_abnormality_rules_abnormality_check
          CHECK (abnormality_type IN (
            'HIGH_USAGE', 'LOW_USAGE', 'ZERO_USAGE',
            'NEGATIVE_OR_INVALID', 'SUDDEN_CHANGE'
          )),
        CONSTRAINT utility_abnormality_rules_mode_check
          CHECK (comparison_mode IN ('ABSOLUTE', 'PERCENT_OF_BASELINE')),
        CONSTRAINT utility_abnormality_rules_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT utility_abnormality_rules_threshold_check
          CHECK (threshold_value IS NULL OR threshold_value >= 0),
        CONSTRAINT utility_abnormality_rules_window_check
          CHECK (baseline_window >= 1 AND baseline_window <= 24),
        -- One active rule per (Client, utility type, abnormality type): two
        -- contradictory thresholds for the same check cannot both be right.
        CONSTRAINT utility_abnormality_rules_unique
          UNIQUE (client_id, utility_type, abnormality_type)
      )
    `);

    await client.query(`
      CREATE INDEX utility_abnormality_rules_lookup_idx
        ON utility_abnormality_rules (client_id, utility_type, status)
    `);

    await client.query(`
      CREATE TABLE utility_abnormal_consumptions (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        building_id        UUID NOT NULL REFERENCES buildings (id),
        meter_id           UUID NOT NULL REFERENCES utility_meters (id),
        utility_type       TEXT NOT NULL,
        consumption_id     UUID NOT NULL
          REFERENCES utility_meter_consumptions (id),
        rule_id            UUID REFERENCES utility_abnormality_rules (id),
        abnormality_type   TEXT NOT NULL,
        comparison_mode    TEXT NOT NULL,
        /* What the rule saw, and what it compared against — the evidence for
           the flag, snapshotted so it stays explainable. */
        detected_value     NUMERIC NOT NULL,
        reference_value    NUMERIC,
        threshold_value    NUMERIC,
        uom_id             UUID NOT NULL REFERENCES units_of_measure (id),
        period_start       TIMESTAMPTZ NOT NULL,
        period_end         TIMESTAMPTZ NOT NULL,
        detected_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        detected_by_user_id UUID REFERENCES users (id),
        status             TEXT NOT NULL DEFAULT 'OPEN',
        resolved_at        TIMESTAMPTZ,
        resolved_by_user_id UUID REFERENCES users (id),
        resolution_notes   TEXT,
        /* BE-09 owns the follow-up entirely; this is a reference only. */
        finding_id         UUID REFERENCES findings (id),
        tenant_assignment_id UUID
          REFERENCES utility_meter_tenant_assignments (id),
        tenant_company_id  UUID REFERENCES tenant_companies (id),
        notes              TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT utility_abnormal_consumptions_type_check
          CHECK (utility_type IN ('ELECTRICITY', 'WATER', 'GAS')),
        CONSTRAINT utility_abnormal_consumptions_abnormality_check
          CHECK (abnormality_type IN (
            'HIGH_USAGE', 'LOW_USAGE', 'ZERO_USAGE',
            'NEGATIVE_OR_INVALID', 'SUDDEN_CHANGE'
          )),
        CONSTRAINT utility_abnormal_consumptions_mode_check
          CHECK (comparison_mode IN ('ABSOLUTE', 'PERCENT_OF_BASELINE')),
        CONSTRAINT utility_abnormal_consumptions_status_check
          CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED')),
        CONSTRAINT utility_abnormal_consumptions_period_check
          CHECK (period_end > period_start),
        -- Only a closed flag may carry resolution stamps.
        CONSTRAINT utility_abnormal_consumptions_resolved_check
          CHECK (
            (status = 'OPEN' AND resolved_at IS NULL)
            OR (status <> 'OPEN' AND resolved_at IS NOT NULL)
          )
      )
    `);

    // Re-evaluating a consumption must not pile up identical open flags.
    // Resolved / dismissed ones are exempt, so a recurrence can be raised.
    await client.query(`
      CREATE UNIQUE INDEX utility_abnormal_consumptions_open_unique
        ON utility_abnormal_consumptions (consumption_id, abnormality_type)
        WHERE status = 'OPEN'
    `);

    await client.query(`
      CREATE INDEX utility_abnormal_consumptions_meter_idx
        ON utility_abnormal_consumptions (meter_id, period_end DESC);
      CREATE INDEX utility_abnormal_consumptions_building_idx
        ON utility_abnormal_consumptions (building_id, period_end DESC);
      CREATE INDEX utility_abnormal_consumptions_client_idx
        ON utility_abnormal_consumptions (client_id, period_end DESC);
      CREATE INDEX utility_abnormal_consumptions_tenant_idx
        ON utility_abnormal_consumptions (tenant_company_id, period_end DESC);
      CREATE INDEX utility_abnormal_consumptions_status_idx
        ON utility_abnormal_consumptions (status, detected_at DESC);
      CREATE INDEX utility_abnormal_consumptions_finding_idx
        ON utility_abnormal_consumptions (finding_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP TABLE IF EXISTS utility_abnormal_consumptions',
    );
    await client.query('DROP TABLE IF EXISTS utility_abnormality_rules');
  },
};
