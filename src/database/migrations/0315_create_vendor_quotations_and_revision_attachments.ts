import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-PRO-02 PART 03 — Vendor Quotation + immutable revision authority.
 *
 * A quotation is an invited Vendor response to one RFQ. Submitted revisions
 * and their lines are immutable commercial evidence. This migration creates no
 * comparison, recommendation, award, PO, budget, or commitment authority.
 * Attachments reuse the shared Document/Version/Supporting Document chain.
 */
export const migration0315CreateVendorQuotationsAndRevisionAttachments: Migration = {
  id: '0315_create_vendor_quotations_and_revision_attachments',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE rfq_lines
        ADD CONSTRAINT rfq_lines_quote_scope_unique
          UNIQUE (id, rfq_id)
    `);

    await client.query(`
      ALTER TABLE supporting_documents
        DROP CONSTRAINT supporting_documents_parent_check;
      ALTER TABLE supporting_documents
        ADD CONSTRAINT supporting_documents_parent_check
          CHECK (parent_type IN (
            'WORK_COMPLETION', 'BAST', 'HANDOVER', 'SIGN_OFF',
            'TENANT_COMPANY', 'VENDOR', 'DOCUMENT', 'RFQ',
            'QUOTATION_REVISION'
          ))
    `);

    await client.query(`
      CREATE TABLE vendor_quotations (
        id                       UUID PRIMARY KEY,
        rfq_id                   UUID NOT NULL,
        invitation_id            UUID NOT NULL,
        vendor_id                UUID NOT NULL,
        client_id                UUID NOT NULL,
        building_id              UUID NOT NULL,
        quotation_number         TEXT NOT NULL,
        status                   TEXT NOT NULL DEFAULT 'DRAFT',
        created_by_session_id    UUID NOT NULL
          REFERENCES rfq_vendor_access_sessions (id),
        idempotency_key          TEXT NOT NULL,
        idempotency_fingerprint  TEXT NOT NULL,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT vendor_quotations_invitation_scope_fk
          FOREIGN KEY (invitation_id, rfq_id, vendor_id, client_id, building_id)
          REFERENCES rfq_vendor_invitations
            (id, rfq_id, vendor_id, client_id, building_id),
        CONSTRAINT vendor_quotations_session_scope_fk
          FOREIGN KEY (created_by_session_id, invitation_id, rfq_id, vendor_id,
                       client_id, building_id)
          REFERENCES rfq_vendor_access_sessions
            (id, invitation_id, rfq_id, vendor_id, client_id, building_id),
        CONSTRAINT vendor_quotations_status_check
          CHECK (status IN ('DRAFT', 'SUBMITTED', 'WITHDRAWN')),
        CONSTRAINT vendor_quotations_number_check
          CHECK (length(btrim(quotation_number)) BETWEEN 1 AND 128),
        CONSTRAINT vendor_quotations_idempotency_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT vendor_quotations_fingerprint_check
          CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT vendor_quotations_scope_unique
          UNIQUE (id, invitation_id, rfq_id, vendor_id, client_id, building_id),
        CONSTRAINT vendor_quotations_invitation_unique
          UNIQUE (invitation_id),
        CONSTRAINT vendor_quotations_idempotency_unique
          UNIQUE (invitation_id, idempotency_key)
      )
    `);

    await client.query(`
      CREATE INDEX vendor_quotations_rfq_idx
        ON vendor_quotations (rfq_id, status, created_at DESC);
      CREATE INDEX vendor_quotations_vendor_idx
        ON vendor_quotations (vendor_id, status, created_at DESC);
      CREATE INDEX vendor_quotations_building_idx
        ON vendor_quotations (building_id, status, created_at DESC)
    `);

    await client.query(`
      CREATE TABLE vendor_quotation_revisions (
        id                       UUID PRIMARY KEY,
        quotation_id             UUID NOT NULL
          REFERENCES vendor_quotations (id),
        rfq_id                   UUID NOT NULL,
        invitation_id            UUID NOT NULL,
        vendor_id                UUID NOT NULL,
        client_id                UUID NOT NULL,
        building_id              UUID NOT NULL,
        revision_number          INTEGER NOT NULL,
        status                   TEXT NOT NULL DEFAULT 'DRAFT',
        currency                 VARCHAR(3) NOT NULL,
        valid_until              DATE,
        lead_time_days           INTEGER,
        delivery_terms           TEXT,
        service_terms            TEXT,
        notes                    TEXT,
        created_by_session_id    UUID NOT NULL
          REFERENCES rfq_vendor_access_sessions (id),
        submitted_at             TIMESTAMPTZ,
        submitted_by_session_id  UUID REFERENCES rfq_vendor_access_sessions (id),
        superseded_at            TIMESTAMPTZ,
        idempotency_key          TEXT NOT NULL,
        idempotency_fingerprint  TEXT NOT NULL,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT vendor_quotation_revisions_quotation_scope_fk
          FOREIGN KEY (quotation_id, invitation_id, rfq_id, vendor_id,
                       client_id, building_id)
          REFERENCES vendor_quotations
            (id, invitation_id, rfq_id, vendor_id, client_id, building_id),
        CONSTRAINT vendor_quotation_revisions_session_scope_fk
          FOREIGN KEY (created_by_session_id, invitation_id, rfq_id, vendor_id,
                       client_id, building_id)
          REFERENCES rfq_vendor_access_sessions
            (id, invitation_id, rfq_id, vendor_id, client_id, building_id),
        CONSTRAINT vendor_quotation_revisions_submitted_session_fk
          FOREIGN KEY (submitted_by_session_id, invitation_id, rfq_id, vendor_id,
                       client_id, building_id)
          REFERENCES rfq_vendor_access_sessions
            (id, invitation_id, rfq_id, vendor_id, client_id, building_id),
        CONSTRAINT vendor_quotation_revisions_status_check
          CHECK (status IN ('DRAFT', 'SUBMITTED', 'SUPERSEDED')),
        CONSTRAINT vendor_quotation_revisions_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY'
          )),
        CONSTRAINT vendor_quotation_revisions_number_check
          CHECK (revision_number >= 1),
        CONSTRAINT vendor_quotation_revisions_lead_time_check
          CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
        CONSTRAINT vendor_quotation_revisions_idempotency_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT vendor_quotation_revisions_fingerprint_check
          CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT vendor_quotation_revisions_state_check
          CHECK (
            (status = 'DRAFT' AND submitted_at IS NULL
              AND submitted_by_session_id IS NULL AND superseded_at IS NULL)
            OR (status = 'SUBMITTED' AND submitted_at IS NOT NULL
              AND submitted_by_session_id IS NOT NULL AND superseded_at IS NULL)
            OR (status = 'SUPERSEDED' AND submitted_at IS NOT NULL
              AND submitted_by_session_id IS NOT NULL AND superseded_at IS NOT NULL)
          ),
        CONSTRAINT vendor_quotation_revisions_scope_unique
          UNIQUE (id, quotation_id, rfq_id),
        CONSTRAINT vendor_quotation_revisions_number_unique
          UNIQUE (quotation_id, revision_number),
        CONSTRAINT vendor_quotation_revisions_idempotency_unique
          UNIQUE (quotation_id, idempotency_key)
      )
    `);

    await client.query(`
      CREATE INDEX vendor_quotation_revisions_quotation_idx
        ON vendor_quotation_revisions (quotation_id, revision_number DESC);
      CREATE INDEX vendor_quotation_revisions_rfq_idx
        ON vendor_quotation_revisions (rfq_id, status, created_at DESC);
      CREATE UNIQUE INDEX vendor_quotation_revisions_one_draft_unique
        ON vendor_quotation_revisions (quotation_id)
        WHERE status = 'DRAFT'
    `);

    await client.query(`
      CREATE TABLE vendor_quotation_lines (
        id                         UUID PRIMARY KEY,
        quotation_revision_id      UUID NOT NULL,
        quotation_id               UUID NOT NULL,
        rfq_id                     UUID NOT NULL,
        rfq_line_id                UUID NOT NULL,
        source_mode                TEXT NOT NULL,
        line_number_snapshot       INTEGER NOT NULL,
        description                TEXT,
        required_quantity_snapshot NUMERIC,
        required_uom_id            UUID REFERENCES units_of_measure (id),
        quoted_quantity            NUMERIC,
        unit_price                 NUMERIC(18, 2) NOT NULL,
        line_total                 NUMERIC(18, 2)
          GENERATED ALWAYS AS (
            ROUND(
              CASE
                WHEN required_quantity_snapshot IS NULL THEN unit_price
                ELSE required_quantity_snapshot * unit_price
              END,
              2
            )
          ) STORED,
        technical_compliance       TEXT NOT NULL DEFAULT 'NOT_STATED',
        deviation_notes            TEXT,
        created_by_session_id      UUID NOT NULL
          REFERENCES rfq_vendor_access_sessions (id),
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT vendor_quotation_lines_revision_scope_fk
          FOREIGN KEY (quotation_revision_id, quotation_id, rfq_id)
          REFERENCES vendor_quotation_revisions (id, quotation_id, rfq_id),
        CONSTRAINT vendor_quotation_lines_rfq_scope_fk
          FOREIGN KEY (rfq_line_id, rfq_id)
          REFERENCES rfq_lines (id, rfq_id),
        CONSTRAINT vendor_quotation_lines_source_mode_check
          CHECK (source_mode IN ('MATERIAL', 'SERVICE')),
        CONSTRAINT vendor_quotation_lines_line_number_check
          CHECK (line_number_snapshot >= 1),
        CONSTRAINT vendor_quotation_lines_required_quantity_check
          CHECK (required_quantity_snapshot IS NULL OR required_quantity_snapshot > 0),
        CONSTRAINT vendor_quotation_lines_quoted_quantity_check
          CHECK (quoted_quantity IS NULL OR quoted_quantity > 0),
        CONSTRAINT vendor_quotation_lines_unit_price_check
          CHECK (unit_price >= 0),
        CONSTRAINT vendor_quotation_lines_technical_check
          CHECK (technical_compliance IN ('COMPLIANT', 'NON_COMPLIANT', 'NOT_STATED')),
        CONSTRAINT vendor_quotation_lines_material_shape_check
          CHECK (
            source_mode <> 'MATERIAL'
            OR (required_quantity_snapshot IS NOT NULL
              AND quoted_quantity IS NOT NULL)
          ),
        CONSTRAINT vendor_quotation_lines_service_shape_check
          CHECK (
            source_mode <> 'SERVICE'
            OR (required_quantity_snapshot IS NULL AND quoted_quantity IS NULL
              AND required_uom_id IS NULL)
          ),
        CONSTRAINT vendor_quotation_lines_revision_line_unique
          UNIQUE (quotation_revision_id, rfq_line_id)
      )
    `);

    await client.query(`
      CREATE INDEX vendor_quotation_lines_revision_idx
        ON vendor_quotation_lines (quotation_revision_id, line_number_snapshot);
      CREATE INDEX vendor_quotation_lines_rfq_line_idx
        ON vendor_quotation_lines (rfq_line_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_quotation_lines');
    await client.query('DROP TABLE IF EXISTS vendor_quotation_revisions');
    await client.query('DROP TABLE IF EXISTS vendor_quotations');

    // Preserve shared-document history on downgrade by retaining the rows
    // under the pre-PART-03 generic DOCUMENT parent rather than deleting them.
    await client.query(`
      UPDATE supporting_documents
         SET parent_type = 'DOCUMENT'
       WHERE parent_type IN ('RFQ', 'QUOTATION_REVISION')
    `);
    await client.query(`
      ALTER TABLE supporting_documents
        DROP CONSTRAINT IF EXISTS supporting_documents_parent_check;
      ALTER TABLE supporting_documents
        ADD CONSTRAINT supporting_documents_parent_check
          CHECK (parent_type IN (
            'WORK_COMPLETION', 'BAST', 'HANDOVER', 'SIGN_OFF',
            'TENANT_COMPANY', 'VENDOR', 'DOCUMENT'
          ))
    `);
    await client.query(`
      ALTER TABLE rfq_lines
        DROP CONSTRAINT IF EXISTS rfq_lines_quote_scope_unique
    `);
  },
};
