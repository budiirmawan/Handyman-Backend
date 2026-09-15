import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-PRO-02 PART 06 — RFQ award to existing Purchase Order provenance.
 *
 * These are typed lineage links only. No alternate PO, price, quantity,
 * budget, or commitment model is introduced. Conversion creates an existing
 * DRAFT Purchase Order; issuance and the existing ISSUED PO-line commitment
 * boundary remain separate authorities.
 */
export const migration0318CreateRfqAwardPoProvenance: Migration = {
  id: '0318_create_rfq_award_po_provenance',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE rfq_awards
        ADD CONSTRAINT rfq_awards_scope_unique
          UNIQUE (id, rfq_id, client_id, building_id)
    `);

    await client.query(`
      CREATE TABLE rfq_award_po_conversions (
        id                       UUID PRIMARY KEY,
        award_id                UUID NOT NULL,
        recommendation_id       UUID NOT NULL,
        rfq_id                  UUID NOT NULL,
        client_id               UUID NOT NULL,
        building_id             UUID NOT NULL,
        comparison_run_id       UUID NOT NULL,
        evidence_id             UUID NOT NULL,
        quotation_id             UUID NOT NULL,
        quotation_revision_id   UUID NOT NULL,
        invitation_id           UUID NOT NULL,
        vendor_id               UUID NOT NULL,
        po_readiness_id         UUID NOT NULL REFERENCES purchase_order_readiness (id),
        purchase_order_id       UUID NOT NULL REFERENCES purchase_orders (id),
        idempotency_key         TEXT NOT NULL,
        idempotency_fingerprint TEXT NOT NULL,
        converted_by_user_id    UUID NOT NULL REFERENCES users (id),
        converted_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT rfq_award_po_conversions_award_scope_fk
          FOREIGN KEY (award_id, rfq_id, client_id, building_id)
          REFERENCES rfq_awards (id, rfq_id, client_id, building_id),
        CONSTRAINT rfq_award_po_conversions_recommendation_fk
          FOREIGN KEY (recommendation_id, rfq_id, client_id, building_id)
          REFERENCES rfq_recommendations (id, rfq_id, client_id, building_id),
        CONSTRAINT rfq_award_po_conversions_comparison_scope_fk
          FOREIGN KEY (comparison_run_id, rfq_id, client_id, building_id)
          REFERENCES rfq_comparison_runs (id, rfq_id, client_id, building_id),
        CONSTRAINT rfq_award_po_conversions_evidence_scope_fk
          FOREIGN KEY (evidence_id, comparison_run_id)
          REFERENCES rfq_comparison_evidence (id, comparison_run_id),
        CONSTRAINT rfq_award_po_conversions_revision_scope_fk
          FOREIGN KEY (quotation_revision_id, quotation_id, rfq_id)
          REFERENCES vendor_quotation_revisions (id, quotation_id, rfq_id),
        CONSTRAINT rfq_award_po_conversions_invitation_scope_fk
          FOREIGN KEY (invitation_id, rfq_id, vendor_id, client_id, building_id)
          REFERENCES rfq_vendor_invitations
            (id, rfq_id, vendor_id, client_id, building_id),
        CONSTRAINT rfq_award_po_conversions_vendor_scope_fk
          FOREIGN KEY (vendor_id, client_id)
          REFERENCES vendors (id, client_id),
        CONSTRAINT rfq_award_po_conversions_idempotency_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT rfq_award_po_conversions_fingerprint_check
          CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT rfq_award_po_conversions_scope_unique
          UNIQUE (id, rfq_id, client_id, building_id),
        CONSTRAINT rfq_award_po_conversions_line_scope_unique
          UNIQUE (id, purchase_order_id),
        CONSTRAINT rfq_award_po_conversions_award_unique
          UNIQUE (award_id),
        CONSTRAINT rfq_award_po_conversions_po_unique
          UNIQUE (purchase_order_id),
        CONSTRAINT rfq_award_po_conversions_idempotency_unique
          UNIQUE (award_id, idempotency_key)
      )
    `);

    await client.query(`
      CREATE INDEX rfq_award_po_conversions_rfq_idx
        ON rfq_award_po_conversions (rfq_id, converted_at DESC);
      CREATE INDEX rfq_award_po_conversions_vendor_idx
        ON rfq_award_po_conversions (vendor_id, converted_at DESC)
    `);

    await client.query(`
      CREATE TABLE rfq_award_po_line_provenance (
        id                    UUID PRIMARY KEY,
        conversion_id        UUID NOT NULL REFERENCES rfq_award_po_conversions (id),
        purchase_order_id    UUID NOT NULL REFERENCES purchase_orders (id),
        purchase_order_line_id UUID NOT NULL REFERENCES purchase_order_lines (id),
        rfq_id               UUID NOT NULL REFERENCES rfqs (id),
        rfq_line_id          UUID NOT NULL REFERENCES rfq_lines (id),
        quotation_line_id    UUID NOT NULL REFERENCES vendor_quotation_lines (id),
        quotation_revision_id UUID NOT NULL REFERENCES vendor_quotation_revisions (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT rfq_award_po_line_provenance_conversion_scope_fk
          FOREIGN KEY (conversion_id, purchase_order_id)
          REFERENCES rfq_award_po_conversions (id, purchase_order_id),
        CONSTRAINT rfq_award_po_line_provenance_unique_po_line
          UNIQUE (purchase_order_line_id),
        CONSTRAINT rfq_award_po_line_provenance_unique_rfq_line
          UNIQUE (conversion_id, rfq_line_id),
        CONSTRAINT rfq_award_po_line_provenance_unique_quote_line
          UNIQUE (conversion_id, quotation_line_id)
      )
    `);

    await client.query(`
      CREATE INDEX rfq_award_po_line_provenance_conversion_idx
        ON rfq_award_po_line_provenance (conversion_id, rfq_line_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS rfq_award_po_line_provenance');
    await client.query('DROP TABLE IF EXISTS rfq_award_po_conversions');
    await client.query('ALTER TABLE rfq_awards DROP CONSTRAINT IF EXISTS rfq_awards_scope_unique');
  },
};
