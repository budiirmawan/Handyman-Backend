import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-PRO-02 PART 04 — immutable RFQ comparison evidence and human
 * evaluation notes.
 *
 * A comparison run fixes the exact SUBMITTED quotation revision evidence used
 * by that run. The run and its evidence are append-only application
 * authorities; a later Vendor revision requires a new run. Evaluation rows
 * deliberately contain observations only and never a score, winner, award, or
 * financial side effect.
 */
export const migration0316CreateRfqComparisonsAndEvaluations: Migration = {
  id: '0316_create_rfq_comparisons_and_evaluations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE rfq_comparison_runs (
        id                       UUID PRIMARY KEY,
        rfq_id                   UUID NOT NULL REFERENCES rfqs (id),
        client_id               UUID NOT NULL REFERENCES clients (id),
        building_id             UUID NOT NULL REFERENCES buildings (id),
        source_mode             TEXT NOT NULL,
        currency                VARCHAR(3) NOT NULL,
        rfq_number_snapshot     TEXT NOT NULL,
        status                   TEXT NOT NULL DEFAULT 'SNAPSHOT',
        snapshot_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by_user_id      UUID NOT NULL REFERENCES users (id),
        idempotency_key         TEXT NOT NULL,
        idempotency_fingerprint TEXT NOT NULL,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT rfq_comparison_runs_source_mode_check
          CHECK (source_mode IN ('MATERIAL', 'SERVICE')),
        CONSTRAINT rfq_comparison_runs_status_check
          CHECK (status IN ('SNAPSHOT')),
        CONSTRAINT rfq_comparison_runs_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY'
          )),
        CONSTRAINT rfq_comparison_runs_number_check
          CHECK (length(btrim(rfq_number_snapshot)) BETWEEN 1 AND 128),
        CONSTRAINT rfq_comparison_runs_idempotency_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT rfq_comparison_runs_fingerprint_check
          CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT rfq_comparison_runs_scope_unique
          UNIQUE (id, rfq_id, client_id, building_id),
        CONSTRAINT rfq_comparison_runs_idempotency_unique
          UNIQUE (rfq_id, idempotency_key)
      )
    `);

    await client.query(`
      CREATE INDEX rfq_comparison_runs_rfq_idx
        ON rfq_comparison_runs (rfq_id, snapshot_at DESC, id DESC)
    `);

    await client.query(`
      CREATE TABLE rfq_comparison_evidence (
        id                         UUID PRIMARY KEY,
        comparison_run_id          UUID NOT NULL REFERENCES rfq_comparison_runs (id),
        rfq_id                     UUID NOT NULL REFERENCES rfqs (id),
        invitation_id              UUID NOT NULL REFERENCES rfq_vendor_invitations (id),
        quotation_id               UUID NOT NULL REFERENCES vendor_quotations (id),
        quotation_revision_id      UUID NOT NULL REFERENCES vendor_quotation_revisions (id),
        vendor_id                  UUID NOT NULL REFERENCES vendors (id),
        client_id                  UUID NOT NULL REFERENCES clients (id),
        building_id                UUID NOT NULL REFERENCES buildings (id),
        quotation_number_snapshot  TEXT NOT NULL,
        revision_number_snapshot   INTEGER NOT NULL,
        submitted_at               TIMESTAMPTZ NOT NULL,
        currency                   VARCHAR(3) NOT NULL,
        valid_until                DATE,
        lead_time_days             INTEGER,
        delivery_terms             TEXT,
        service_terms              TEXT,
        notes                      TEXT,
        total_amount               NUMERIC(18,2) NOT NULL,
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT rfq_comparison_evidence_scope_fk
          FOREIGN KEY (comparison_run_id, rfq_id, client_id, building_id)
          REFERENCES rfq_comparison_runs (id, rfq_id, client_id, building_id),
        CONSTRAINT rfq_comparison_evidence_revision_scope_fk
          FOREIGN KEY (quotation_revision_id, quotation_id, rfq_id)
          REFERENCES vendor_quotation_revisions (id, quotation_id, rfq_id),
        CONSTRAINT rfq_comparison_evidence_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY'
          )),
        CONSTRAINT rfq_comparison_evidence_revision_number_check
          CHECK (revision_number_snapshot >= 1),
        CONSTRAINT rfq_comparison_evidence_lead_time_check
          CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
        CONSTRAINT rfq_comparison_evidence_total_check
          CHECK (total_amount >= 0),
        CONSTRAINT rfq_comparison_evidence_scope_unique
          UNIQUE (id, comparison_run_id),
        CONSTRAINT rfq_comparison_evidence_vendor_unique
          UNIQUE (comparison_run_id, vendor_id),
        CONSTRAINT rfq_comparison_evidence_revision_unique
          UNIQUE (comparison_run_id, quotation_revision_id)
      )
    `);

    await client.query(`
      CREATE INDEX rfq_comparison_evidence_run_idx
        ON rfq_comparison_evidence (comparison_run_id, vendor_id)
    `);

    await client.query(`
      CREATE TABLE rfq_comparison_lines (
        id                         UUID PRIMARY KEY,
        comparison_run_id         UUID NOT NULL,
        evidence_id               UUID NOT NULL,
        rfq_id                    UUID NOT NULL REFERENCES rfqs (id),
        rfq_line_id               UUID NOT NULL REFERENCES rfq_lines (id),
        quotation_line_id         UUID NOT NULL REFERENCES vendor_quotation_lines (id),
        source_mode               TEXT NOT NULL,
        rfq_line_number_snapshot  INTEGER NOT NULL,
        description_snapshot      TEXT NOT NULL,
        offered_description_snapshot TEXT,
        required_quantity_snapshot NUMERIC,
        required_uom_id           UUID REFERENCES units_of_measure (id),
        quoted_quantity_snapshot  NUMERIC,
        unit_price                NUMERIC(18,2) NOT NULL,
        line_total                NUMERIC(18,2) NOT NULL,
        technical_compliance     TEXT NOT NULL,
        deviation_notes          TEXT,
        line_status               TEXT NOT NULL DEFAULT 'QUOTED',
        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT rfq_comparison_lines_evidence_scope_fk
          FOREIGN KEY (evidence_id, comparison_run_id)
          REFERENCES rfq_comparison_evidence (id, comparison_run_id),
        CONSTRAINT rfq_comparison_lines_source_mode_check
          CHECK (source_mode IN ('MATERIAL', 'SERVICE')),
        CONSTRAINT rfq_comparison_lines_number_check
          CHECK (rfq_line_number_snapshot >= 1),
        CONSTRAINT rfq_comparison_lines_line_status_check
          CHECK (line_status IN ('QUOTED', 'MISSING')),
        CONSTRAINT rfq_comparison_lines_shape_check
          CHECK (
            (source_mode = 'MATERIAL'
              AND required_quantity_snapshot IS NOT NULL
              AND quoted_quantity_snapshot IS NOT NULL)
            OR (source_mode = 'SERVICE'
              AND required_quantity_snapshot IS NULL
              AND quoted_quantity_snapshot IS NULL
              AND required_uom_id IS NULL)
          ),
        CONSTRAINT rfq_comparison_lines_price_check
          CHECK (unit_price >= 0 AND line_total >= 0),
        CONSTRAINT rfq_comparison_lines_unique
          UNIQUE (evidence_id, rfq_line_id)
      )
    `);

    await client.query(`
      CREATE INDEX rfq_comparison_lines_run_idx
        ON rfq_comparison_lines (comparison_run_id, rfq_line_number_snapshot, evidence_id)
    `);

    // This is a reference-only snapshot. It stores no file content and does
    // not create a second document/evidence authority.
    await client.query(`
      CREATE TABLE rfq_comparison_evidence_attachments (
        id                    UUID PRIMARY KEY,
        comparison_run_id    UUID NOT NULL,
        evidence_id          UUID NOT NULL,
        supporting_document_id UUID NOT NULL REFERENCES supporting_documents (id),
        document_id          UUID NOT NULL REFERENCES documents (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT rfq_comparison_evidence_attachments_evidence_scope_fk
          FOREIGN KEY (evidence_id, comparison_run_id)
          REFERENCES rfq_comparison_evidence (id, comparison_run_id),
        CONSTRAINT rfq_comparison_evidence_attachments_unique
          UNIQUE (evidence_id, supporting_document_id)
      )
    `);

    await client.query(`
      CREATE INDEX rfq_comparison_evidence_attachments_run_idx
        ON rfq_comparison_evidence_attachments (comparison_run_id, evidence_id)
    `);

    await client.query(`
      CREATE TABLE rfq_comparison_evaluations (
        id                       UUID PRIMARY KEY,
        comparison_run_id       UUID NOT NULL,
        evidence_id             UUID NOT NULL,
        rfq_id                  UUID NOT NULL REFERENCES rfqs (id),
        vendor_id               UUID NOT NULL REFERENCES vendors (id),
        quotation_revision_id   UUID NOT NULL REFERENCES vendor_quotation_revisions (id),
        commercial_observation  TEXT,
        technical_observation   TEXT,
        compliance_observation  TEXT,
        evaluator_note          TEXT,
        created_by_user_id      UUID NOT NULL REFERENCES users (id),
        updated_by_user_id      UUID NOT NULL REFERENCES users (id),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT rfq_comparison_evaluations_evidence_scope_fk
          FOREIGN KEY (evidence_id, comparison_run_id)
          REFERENCES rfq_comparison_evidence (id, comparison_run_id),
        CONSTRAINT rfq_comparison_evaluations_revision_fk
          FOREIGN KEY (quotation_revision_id)
          REFERENCES vendor_quotation_revisions (id),
        CONSTRAINT rfq_comparison_evaluations_unique
          UNIQUE (comparison_run_id, evidence_id)
      )
    `);

    await client.query(`
      CREATE INDEX rfq_comparison_evaluations_run_idx
        ON rfq_comparison_evaluations (comparison_run_id, created_at, id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS rfq_comparison_evaluations');
    await client.query('DROP TABLE IF EXISTS rfq_comparison_evidence_attachments');
    await client.query('DROP TABLE IF EXISTS rfq_comparison_lines');
    await client.query('DROP TABLE IF EXISTS rfq_comparison_evidence');
    await client.query('DROP TABLE IF EXISTS rfq_comparison_runs');
  },
};
