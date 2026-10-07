import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-PRO-02 PART 05 — manual recommendation, existing approval binding
 * extension, and explicit immutable award.
 *
 * Recommendation evidence points to one immutable comparison evidence row.
 * Approval reuses procurement_approval_bindings with a typed RFQ target. Award
 * is a separate explicit command and never creates a PO or financial entry.
 */
export const migration0317CreateRfqRecommendationsApprovalsAwards: Migration = {
  id: '0317_create_rfq_recommendations_approvals_awards',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE rfq_recommendations (
        id                    UUID PRIMARY KEY,
        rfq_id                UUID NOT NULL,
        client_id             UUID NOT NULL,
        building_id           UUID NOT NULL,
        comparison_run_id    UUID NOT NULL,
        evidence_id           UUID,
        quotation_id          UUID,
        quotation_revision_id UUID,
        invitation_id         UUID,
        vendor_id             UUID,
        outcome               TEXT NOT NULL DEFAULT 'VENDOR',
        status                TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
        reason                TEXT NOT NULL,
        notes                 TEXT,
        created_by_user_id    UUID NOT NULL REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT rfq_recommendations_rfq_scope_fk
          FOREIGN KEY (rfq_id, client_id, building_id)
          REFERENCES rfqs (id, client_id, building_id),
        CONSTRAINT rfq_recommendations_comparison_scope_fk
          FOREIGN KEY (comparison_run_id, rfq_id, client_id, building_id)
          REFERENCES rfq_comparison_runs (id, rfq_id, client_id, building_id),
        CONSTRAINT rfq_recommendations_evidence_scope_fk
          FOREIGN KEY (evidence_id, comparison_run_id)
          REFERENCES rfq_comparison_evidence (id, comparison_run_id),
        CONSTRAINT rfq_recommendations_revision_scope_fk
          FOREIGN KEY (quotation_revision_id, quotation_id, rfq_id)
          REFERENCES vendor_quotation_revisions (id, quotation_id, rfq_id),
        CONSTRAINT rfq_recommendations_invitation_scope_fk
          FOREIGN KEY (invitation_id, rfq_id, vendor_id, client_id, building_id)
          REFERENCES rfq_vendor_invitations
            (id, rfq_id, vendor_id, client_id, building_id),
        CONSTRAINT rfq_recommendations_vendor_scope_fk
          FOREIGN KEY (vendor_id, client_id)
          REFERENCES vendors (id, client_id),
        CONSTRAINT rfq_recommendations_outcome_check
          CHECK (outcome IN ('VENDOR', 'NO_AWARD')),
        CONSTRAINT rfq_recommendations_status_check
          CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'AWARDED')),
        CONSTRAINT rfq_recommendations_selection_shape_check
          CHECK (
            (outcome = 'VENDOR'
              AND evidence_id IS NOT NULL
              AND quotation_id IS NOT NULL
              AND quotation_revision_id IS NOT NULL
              AND invitation_id IS NOT NULL
              AND vendor_id IS NOT NULL)
            OR (outcome = 'NO_AWARD'
              AND evidence_id IS NULL
              AND quotation_id IS NULL
              AND quotation_revision_id IS NULL
              AND invitation_id IS NULL
              AND vendor_id IS NULL)
          ),
        CONSTRAINT rfq_recommendations_reason_check
          CHECK (length(btrim(reason)) BETWEEN 1 AND 4000),
        CONSTRAINT rfq_recommendations_scope_unique
          UNIQUE (id, rfq_id, client_id, building_id),
        CONSTRAINT rfq_recommendations_one_per_rfq_unique
          UNIQUE (rfq_id)
      )
    `);

    await client.query(`
      CREATE INDEX rfq_recommendations_building_idx
        ON rfq_recommendations (building_id, status, created_at DESC);
      CREATE INDEX rfq_recommendations_comparison_idx
        ON rfq_recommendations (comparison_run_id, created_at DESC)
    `);

    // Extend the existing procurement approval authority. Existing request
    // rows remain valid with these new RFQ columns NULL.
    await client.query(`
      ALTER TABLE procurement_approval_bindings
        ADD COLUMN rfq_id UUID,
        ADD COLUMN recommendation_id UUID
    `);
    await client.query(`
      ALTER TABLE procurement_approval_bindings
        DROP CONSTRAINT procurement_approval_request_type_check,
        DROP CONSTRAINT procurement_approval_request_reference_check,
        DROP CONSTRAINT procurement_approval_request_type_reference_check
    `);
    await client.query(`
      ALTER TABLE procurement_approval_bindings
        ADD CONSTRAINT procurement_approval_request_type_check
          CHECK (request_type IN (
            'PURCHASE_REQUEST', 'MATERIAL_REQUEST', 'SERVICE_REQUEST', 'RFQ'
          )),
        ADD CONSTRAINT procurement_approval_request_reference_check
          CHECK (
            (purchase_request_id IS NOT NULL)::int
            + (material_request_id IS NOT NULL)::int
            + (service_request_id IS NOT NULL)::int
            + (rfq_id IS NOT NULL)::int = 1
          ),
        ADD CONSTRAINT procurement_approval_request_type_reference_check
          CHECK (
            (request_type = 'PURCHASE_REQUEST' AND purchase_request_id IS NOT NULL
              AND material_request_id IS NULL AND service_request_id IS NULL
              AND rfq_id IS NULL AND recommendation_id IS NULL)
            OR (request_type = 'MATERIAL_REQUEST' AND material_request_id IS NOT NULL
              AND purchase_request_id IS NULL AND service_request_id IS NULL
              AND rfq_id IS NULL AND recommendation_id IS NULL)
            OR (request_type = 'SERVICE_REQUEST' AND service_request_id IS NOT NULL
              AND purchase_request_id IS NULL AND material_request_id IS NULL
              AND rfq_id IS NULL AND recommendation_id IS NULL)
            OR (request_type = 'RFQ' AND rfq_id IS NOT NULL
              AND purchase_request_id IS NULL AND material_request_id IS NULL
              AND service_request_id IS NULL AND recommendation_id IS NOT NULL)
          ),
        ADD CONSTRAINT procurement_approval_rfq_scope_fk
          FOREIGN KEY (rfq_id, client_id, building_id)
          REFERENCES rfqs (id, client_id, building_id),
        ADD CONSTRAINT procurement_approval_recommendation_fk
          FOREIGN KEY (recommendation_id)
          REFERENCES rfq_recommendations (id)
    `);
    await client.query(`
      CREATE UNIQUE INDEX procurement_approval_rfq_pending_unique
        ON procurement_approval_bindings (rfq_id, approval_type)
        WHERE request_type = 'RFQ' AND status = 'PENDING';
      CREATE INDEX procurement_approval_rfq_idx
        ON procurement_approval_bindings (rfq_id, status, created_at)
        WHERE rfq_id IS NOT NULL
    `);

    await client.query(`
      CREATE TABLE rfq_awards (
        id                    UUID PRIMARY KEY,
        rfq_id                UUID NOT NULL,
        client_id             UUID NOT NULL,
        building_id           UUID NOT NULL,
        recommendation_id    UUID NOT NULL,
        approval_id          UUID NOT NULL REFERENCES procurement_approval_bindings (id),
        comparison_run_id    UUID NOT NULL,
        evidence_id           UUID,
        quotation_id          UUID,
        quotation_revision_id UUID,
        invitation_id         UUID,
        vendor_id             UUID,
        outcome               TEXT NOT NULL,
        award_reason          TEXT,
        awarded_by_user_id    UUID NOT NULL REFERENCES users (id),
        awarded_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT rfq_awards_rfq_scope_fk
          FOREIGN KEY (rfq_id, client_id, building_id)
          REFERENCES rfqs (id, client_id, building_id),
        CONSTRAINT rfq_awards_recommendation_scope_fk
          FOREIGN KEY (recommendation_id, rfq_id, client_id, building_id)
          REFERENCES rfq_recommendations (id, rfq_id, client_id, building_id),
        CONSTRAINT rfq_awards_comparison_scope_fk
          FOREIGN KEY (comparison_run_id, rfq_id, client_id, building_id)
          REFERENCES rfq_comparison_runs (id, rfq_id, client_id, building_id),
        CONSTRAINT rfq_awards_evidence_scope_fk
          FOREIGN KEY (evidence_id, comparison_run_id)
          REFERENCES rfq_comparison_evidence (id, comparison_run_id),
        CONSTRAINT rfq_awards_revision_scope_fk
          FOREIGN KEY (quotation_revision_id, quotation_id, rfq_id)
          REFERENCES vendor_quotation_revisions (id, quotation_id, rfq_id),
        CONSTRAINT rfq_awards_invitation_scope_fk
          FOREIGN KEY (invitation_id, rfq_id, vendor_id, client_id, building_id)
          REFERENCES rfq_vendor_invitations
            (id, rfq_id, vendor_id, client_id, building_id),
        CONSTRAINT rfq_awards_vendor_scope_fk
          FOREIGN KEY (vendor_id, client_id)
          REFERENCES vendors (id, client_id),
        CONSTRAINT rfq_awards_outcome_check
          CHECK (outcome IN ('VENDOR', 'NO_AWARD')),
        CONSTRAINT rfq_awards_selection_shape_check
          CHECK (
            (outcome = 'VENDOR'
              AND evidence_id IS NOT NULL
              AND quotation_id IS NOT NULL
              AND quotation_revision_id IS NOT NULL
              AND invitation_id IS NOT NULL
              AND vendor_id IS NOT NULL)
            OR (outcome = 'NO_AWARD'
              AND evidence_id IS NULL
              AND quotation_id IS NULL
              AND quotation_revision_id IS NULL
              AND invitation_id IS NULL
              AND vendor_id IS NULL)
          ),
        CONSTRAINT rfq_awards_reason_check
          CHECK (award_reason IS NULL OR length(btrim(award_reason)) BETWEEN 1 AND 4000),
        CONSTRAINT rfq_awards_one_per_rfq_unique
          UNIQUE (rfq_id),
        CONSTRAINT rfq_awards_one_per_recommendation_unique
          UNIQUE (recommendation_id)
      )
    `);

    await client.query(`
      CREATE INDEX rfq_awards_building_idx
        ON rfq_awards (building_id, awarded_at DESC);
      CREATE INDEX rfq_awards_vendor_idx
        ON rfq_awards (vendor_id, awarded_at DESC)
        WHERE vendor_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS rfq_awards');
    await client.query(`
      DROP INDEX IF EXISTS procurement_approval_rfq_pending_unique;
      DROP INDEX IF EXISTS procurement_approval_rfq_idx
    `);
    await client.query(`
      ALTER TABLE procurement_approval_bindings
        DROP CONSTRAINT IF EXISTS procurement_approval_recommendation_fk,
        DROP CONSTRAINT IF EXISTS procurement_approval_rfq_scope_fk,
        DROP CONSTRAINT IF EXISTS procurement_approval_request_type_reference_check,
        DROP CONSTRAINT IF EXISTS procurement_approval_request_reference_check,
        DROP CONSTRAINT IF EXISTS procurement_approval_request_type_check
    `);
    await client.query(`
      ALTER TABLE procurement_approval_bindings
        DROP COLUMN IF EXISTS recommendation_id,
        DROP COLUMN IF EXISTS rfq_id
    `);
    await client.query(`
      ALTER TABLE procurement_approval_bindings
        ADD CONSTRAINT procurement_approval_request_type_check
          CHECK (request_type IN ('PURCHASE_REQUEST', 'MATERIAL_REQUEST', 'SERVICE_REQUEST')),
        ADD CONSTRAINT procurement_approval_request_reference_check
          CHECK (
            (purchase_request_id IS NOT NULL)::int
            + (material_request_id IS NOT NULL)::int
            + (service_request_id IS NOT NULL)::int = 1
          ),
        ADD CONSTRAINT procurement_approval_request_type_reference_check
          CHECK (
            (request_type = 'PURCHASE_REQUEST' AND purchase_request_id IS NOT NULL)
            OR (request_type = 'MATERIAL_REQUEST' AND material_request_id IS NOT NULL)
            OR (request_type = 'SERVICE_REQUEST' AND service_request_id IS NOT NULL)
          )
    `);
    await client.query('DROP TABLE IF EXISTS rfq_recommendations');
  },
};
