import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-INSPECTION-01 PART B — versioned Field inspection reports, their
 * technical estimate lines, and the immutable Operations review decision.
 *
 * Additive minimum (three bounded tables; reverting `down`; nothing else
 * touched, no backfill, no historical row rewritten):
 *
 *   handyman_request_inspection_reports
 *     Immutable report VERSION submitted by the request's assigned Field
 *     inspector for the single 0381 physical inspection. `version_number`
 *     is per-request and monotonic; a correction is a NEW version that
 *     links back to the returned predecessor — a submitted version is
 *     never edited. The discipline/classification pair is the server-derived
 *     F9 snapshot (the classification is never a caller input). Lines carry
 *     technical scope only: no price, amount, currency, tax, markup or
 *     supplier field exists anywhere in this table family.
 *
 *   handyman_request_inspection_report_estimates
 *     Estimated LABOR/MATERIAL scope lines (bounded description, positive
 *     quantity, existing `units_of_measure` reference). Technical quantity
 *     only — never a quotation line, never a CR-HM-12 pricing basis.
 *
 *   handyman_request_inspection_report_reviews
 *     Exactly ONE immutable decision per report version. The submitting
 *     user is copied onto the review by the server and bound by the
 *     composite FK (report_id, report_submitted_by_user_id) → reports
 *     (id, submitted_by_user_id), and the CHECK constraint refuses
 *     self-review at the database boundary as well as in the service. A
 *     partial UNIQUE index permits at most one ACCEPTED version per
 *     request; `RETURNED` demands a bounded reason.
 *
 * DB protection: BEFORE UPDATE / DELETE triggers on all three tables —
 * INSERT is the only write ever allowed.
 */
export const migration0446HandymanInspectionReports: Migration = {
  id: '0446_handyman_inspection_reports',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_request_inspection_reports (
        id                              UUID PRIMARY KEY,
        client_id                       UUID NOT NULL REFERENCES clients (id),
        handyman_request_id             UUID NOT NULL,
        channel_attribution_id          UUID NOT NULL REFERENCES handyman_channel_attributions (id),
        building_id                     UUID NOT NULL REFERENCES buildings (id),
        handyman_request_inspection_id  UUID NOT NULL REFERENCES handyman_request_inspections (id),
        inspection_assignment_id        UUID NOT NULL REFERENCES handyman_request_inspection_assignments (id),
        version_number                  INTEGER NOT NULL,
        supersedes_report_id            UUID REFERENCES handyman_request_inspection_reports (id),
        submitted_by_user_id            UUID NOT NULL REFERENCES users (id),
        submitted_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        technical_findings              TEXT NOT NULL,
        proposed_diagnosis              TEXT NOT NULL,
        handyman_discipline_id          UUID NOT NULL REFERENCES handyman_disciplines (id),
        discipline_code                 TEXT NOT NULL,
        scope_classification            TEXT NOT NULL,
        recommended_service_catalog_id  UUID REFERENCES service_catalog (id),

        CONSTRAINT handyman_request_inspection_report_version_check
          CHECK (version_number >= 1),
        CONSTRAINT handyman_request_inspection_report_findings_length_check
          CHECK (char_length(technical_findings) BETWEEN 1 AND 2000),
        CONSTRAINT handyman_request_inspection_report_diagnosis_length_check
          CHECK (char_length(proposed_diagnosis) BETWEEN 1 AND 1000),
        CONSTRAINT handyman_request_inspection_report_classification_check
          CHECK (scope_classification IN
            ('GENERAL_HANDYMAN', 'SPECIALIST_REQUIRED',
             'OUT_OF_HANDYMAN_SCOPE')),
        CONSTRAINT handyman_request_inspection_report_version_unique
          UNIQUE (handyman_request_id, version_number),
        CONSTRAINT handyman_request_inspection_report_supersedes_unique
          UNIQUE (supersedes_report_id),
        -- Composite keys used by the review table to prove same-request and
        -- same-submitter provenance at the database boundary.
        CONSTRAINT handyman_request_inspection_report_request_identity
          UNIQUE (id, handyman_request_id),
        CONSTRAINT handyman_request_inspection_report_submitter_identity
          UNIQUE (id, submitted_by_user_id),
        CONSTRAINT handyman_request_inspection_report_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
            REFERENCES handyman_service_requests (id, client_id)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_request_inspection_report_scope_idx
        ON handyman_request_inspection_reports (client_id, submitted_at)
    `);

    await client.query(`
      CREATE TABLE handyman_request_inspection_report_estimates (
        id          UUID PRIMARY KEY,
        client_id   UUID NOT NULL REFERENCES clients (id),
        report_id   UUID NOT NULL
                    REFERENCES handyman_request_inspection_reports (id),
        line_type   TEXT NOT NULL,
        description TEXT NOT NULL,
        quantity    NUMERIC(14, 3) NOT NULL,
        uom_id      UUID NOT NULL REFERENCES units_of_measure (id),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_request_inspection_estimate_line_type_check
          CHECK (line_type IN ('LABOR', 'MATERIAL')),
        CONSTRAINT handyman_request_inspection_estimate_description_check
          CHECK (char_length(description) BETWEEN 1 AND 500),
        CONSTRAINT handyman_request_inspection_estimate_quantity_check
          CHECK (quantity > 0)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_request_inspection_estimate_report_idx
        ON handyman_request_inspection_report_estimates (report_id)
    `);

    await client.query(`
      CREATE TABLE handyman_request_inspection_report_reviews (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        handyman_request_id         UUID NOT NULL,
        building_id                 UUID NOT NULL REFERENCES buildings (id),
        report_id                   UUID NOT NULL,
        report_submitted_by_user_id UUID NOT NULL,
        decision                    TEXT NOT NULL,
        return_reason               TEXT,
        reviewed_by_user_id         UUID NOT NULL REFERENCES users (id),
        reviewed_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_request_inspection_review_one_per_version
          UNIQUE (report_id),
        CONSTRAINT handyman_request_inspection_review_decision_check
          CHECK (decision IN ('ACCEPTED', 'RETURNED')),
        CONSTRAINT handyman_request_inspection_review_reason_check
          CHECK (
            (decision = 'RETURNED'
              AND return_reason IS NOT NULL
              AND char_length(return_reason) BETWEEN 1 AND 1000)
            OR
            (decision = 'ACCEPTED'
              AND (return_reason IS NULL
                   OR char_length(return_reason) BETWEEN 1 AND 1000))
          ),
        -- The version's submitter and the reviewer must differ: enforced in
        -- the database, not only in the service.
        CONSTRAINT handyman_request_inspection_review_separation_check
          CHECK (reviewed_by_user_id <> report_submitted_by_user_id),
        CONSTRAINT handyman_request_inspection_review_report_scope_fk
          FOREIGN KEY (report_id, handyman_request_id)
            REFERENCES handyman_request_inspection_reports
              (id, handyman_request_id),
        CONSTRAINT handyman_request_inspection_review_submitter_fk
          FOREIGN KEY (report_id, report_submitted_by_user_id)
            REFERENCES handyman_request_inspection_reports
              (id, submitted_by_user_id),
        CONSTRAINT handyman_request_inspection_review_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
            REFERENCES handyman_service_requests (id, client_id)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_request_inspection_review_accepted_unique
        ON handyman_request_inspection_report_reviews (handyman_request_id)
        WHERE decision = 'ACCEPTED'
    `);

    for (const [table, name] of [
      [
        'handyman_request_inspection_reports',
        'handyman_request_inspection_report_block_mutation',
      ],
      [
        'handyman_request_inspection_report_estimates',
        'handyman_request_inspection_estimate_block_mutation',
      ],
      [
        'handyman_request_inspection_report_reviews',
        'handyman_request_inspection_review_block_mutation',
      ],
    ] as const) {
      await client.query(`
        CREATE OR REPLACE FUNCTION ${name}()
        RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'Handyman inspection report records are append-only.';
        END;
        $$ LANGUAGE plpgsql
      `);
      await client.query(`
        CREATE TRIGGER ${name}_no_update
          BEFORE UPDATE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION ${name}()
      `);
      await client.query(`
        CREATE TRIGGER ${name}_no_delete
          BEFORE DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION ${name}()
      `);
    }
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP TABLE IF EXISTS handyman_request_inspection_report_reviews CASCADE',
    );
    await client.query(
      'DROP FUNCTION IF EXISTS handyman_request_inspection_review_block_mutation() CASCADE',
    );
    await client.query(
      'DROP TABLE IF EXISTS handyman_request_inspection_report_estimates CASCADE',
    );
    await client.query(
      'DROP FUNCTION IF EXISTS handyman_request_inspection_estimate_block_mutation() CASCADE',
    );
    await client.query(
      'DROP TABLE IF EXISTS handyman_request_inspection_reports CASCADE',
    );
    await client.query(
      'DROP FUNCTION IF EXISTS handyman_request_inspection_report_block_mutation() CASCADE',
    );
  },
};
