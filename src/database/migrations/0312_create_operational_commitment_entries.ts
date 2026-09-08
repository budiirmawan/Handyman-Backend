import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-COMM-VAR-01 PART 02 — append-only Operational Commitment ledger.
 *
 * Every change to a commitment's amounts is expressed as an immutable entry.
 * `signed_amount` is always the effect on the commitment's OPEN amount, so
 * `SUM(signed_amount) = open_amount` for a commitment at all times:
 *
 * | entry_type          | sign | effect on the header                       |
 * |---------------------|------|--------------------------------------------|
 * | CREATE              |  +   | committed_amount set                        |
 * | ADJUST_INCREASE     |  +   | committed_amount increased                  |
 * | ADJUST_DECREASE     |  -   | committed_amount decreased                  |
 * | ACTUALIZE           |  -   | actualized_amount increased (budget stays consumed) |
 * | ACTUALIZE_REVERSAL  |  +   | actualized_amount decreased                 |
 * | RELEASE             |  -   | released_amount increased (remainder freed)  |
 * | CANCEL              |  -   | whole commitment withdrawn                   |
 * | OVERRIDE            |  0   | overspend override provenance marker         |
 *
 * The table is append-only at the application boundary — there is no update
 * or delete surface, exactly as `operational_events` is treated. Corrections
 * are new entries, never rewrites.
 *
 * `source_binding_id` links an ACTUALIZE entry to the CR-BE-FIN-01 typed
 * lineage row that justified it. The partial unique index over it makes
 * duplicate actualization of the same authoritative source structurally
 * impossible before PART 03 wires any source at all.
 */
export const migration0312CreateOperationalCommitmentEntries: Migration = {
  id: '0312_create_operational_commitment_entries',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE operational_commitment_entries (
        id                  UUID PRIMARY KEY,
        commitment_id       UUID NOT NULL
          REFERENCES operational_commitments (id) ON DELETE CASCADE,
        entry_type          TEXT NOT NULL,
        signed_amount       NUMERIC(18, 2) NOT NULL,
        currency            VARCHAR(3) NOT NULL,
        source_binding_id   UUID REFERENCES operational_budget_source_bindings (id),
        idempotency_key     TEXT NOT NULL,
        reason              TEXT,
        actor_user_id       UUID NOT NULL REFERENCES users (id),
        request_id          UUID,
        occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT operational_commitment_entries_type_check
          CHECK (entry_type IN (
            'CREATE', 'ADJUST_INCREASE', 'ADJUST_DECREASE',
            'ACTUALIZE', 'ACTUALIZE_REVERSAL',
            'RELEASE', 'CANCEL', 'OVERRIDE'
          )),

        CONSTRAINT operational_commitment_entries_sign_check
          CHECK (
            (entry_type IN ('CREATE', 'ADJUST_INCREASE', 'ACTUALIZE_REVERSAL')
              AND signed_amount > 0)
            OR (entry_type IN ('ADJUST_DECREASE', 'ACTUALIZE', 'RELEASE', 'CANCEL')
              AND signed_amount < 0)
            OR (entry_type = 'OVERRIDE' AND signed_amount = 0)
          ),

        CONSTRAINT operational_commitment_entries_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY'
          )),

        -- A lineage link is only meaningful for actualization entries.
        CONSTRAINT operational_commitment_entries_binding_check
          CHECK (
            source_binding_id IS NULL
            OR entry_type IN ('ACTUALIZE', 'ACTUALIZE_REVERSAL')
          ),

        -- Corrective and override entries must state why they exist.
        CONSTRAINT operational_commitment_entries_reason_check
          CHECK (
            entry_type NOT IN (
              'ADJUST_INCREASE', 'ADJUST_DECREASE', 'RELEASE',
              'CANCEL', 'OVERRIDE', 'ACTUALIZE_REVERSAL'
            )
            OR (reason IS NOT NULL AND length(btrim(reason)) > 0)
          ),

        CONSTRAINT operational_commitment_entries_idempotency_unique
          UNIQUE (commitment_id, idempotency_key)
      )
    `);

    // Duplicate actualization of one authoritative lineage row is impossible.
    await client.query(`
      CREATE UNIQUE INDEX operational_commitment_entries_actualization_unique
        ON operational_commitment_entries (commitment_id, source_binding_id)
        WHERE entry_type = 'ACTUALIZE' AND source_binding_id IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX operational_commitment_entries_commitment_idx
        ON operational_commitment_entries (commitment_id, occurred_at, id);
      CREATE INDEX operational_commitment_entries_type_idx
        ON operational_commitment_entries (entry_type, occurred_at);
      CREATE INDEX operational_commitment_entries_request_idx
        ON operational_commitment_entries (request_id)
        WHERE request_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS operational_commitment_entries');
  },
};
