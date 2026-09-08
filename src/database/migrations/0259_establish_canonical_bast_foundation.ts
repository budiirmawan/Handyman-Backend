import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-BAST-01 PART 01 — canonical BAST authority and reconciliation
 * foundation.
 *
 * BE-22 `bast_documents.id` remains the sole canonical BAST identity. This
 * migration is deliberately additive: it does not backfill or reinterpret
 * legacy lifecycle state, disable BE-15 writes, or change Work Order closure.
 */
export const migration0259EstablishCanonicalBastFoundation: Migration = {
  id: '0259_establish_canonical_bast_foundation',

  async up(client: PoolClient): Promise<void> {
    // Historical Work Orders keep the non-blocking policy. PART 01 only makes
    // the future acceptance cardinality explicit; closure enforcement is a
    // later phase.
    await client.query(`
      ALTER TABLE work_orders
        ADD COLUMN bast_requirement TEXT NOT NULL DEFAULT 'NONE',
        ADD CONSTRAINT work_orders_bast_requirement_check
          CHECK (bast_requirement IN ('NONE', 'WORK_ORDER', 'EACH_VENDOR_WORK'))
    `);
    await client.query(`
      CREATE INDEX work_orders_bast_requirement_idx
        ON work_orders (bast_requirement, status)
    `);

    // Stable references are nullable for existing canonical records so that
    // reconciliation can inventory them before an explicit, governed backfill.
    // New BE-22 writes resolve and populate them from authoritative work data.
    await client.query(`
      ALTER TABLE bast_documents
        ADD COLUMN vendor_id UUID REFERENCES vendors (id),
        ADD COLUMN completion_report_id UUID REFERENCES vendor_completion_reports (id),
        ADD COLUMN service_report_id UUID REFERENCES vendor_service_reports (id),
        ADD COLUMN acceptance_scope_type TEXT,
        ADD CONSTRAINT bast_documents_acceptance_scope_check
          CHECK (acceptance_scope_type IS NULL OR acceptance_scope_type IN ('WORK_ORDER', 'VENDOR_WORK'))
    `);
    await client.query(`
      CREATE INDEX bast_documents_vendor_idx
        ON bast_documents (vendor_id, acceptance_status);
      CREATE INDEX bast_documents_completion_report_idx
        ON bast_documents (completion_report_id);
      CREATE INDEX bast_documents_service_report_idx
        ON bast_documents (service_report_id);
      CREATE INDEX bast_documents_acceptance_scope_idx
        ON bast_documents (acceptance_scope_type, work_order_id, vendor_work_id);
    `);

    // Each row is one immutable submission snapshot. No submission command is
    // activated in PART 01; the structure preserves all evidence pins needed by
    // a later command without overloading mutable bast_documents columns.
    await client.query(`
      CREATE TABLE bast_submission_attempts (
        id                              UUID PRIMARY KEY,
        bast_document_id                UUID NOT NULL REFERENCES bast_documents (id) ON DELETE CASCADE,
        attempt_number                  INT NOT NULL,
        document_version_id             UUID NOT NULL REFERENCES document_versions (id),
        work_completion_document_id     UUID REFERENCES work_completion_documents (id),
        completion_report_id            UUID REFERENCES vendor_completion_reports (id),
        service_report_id               UUID REFERENCES vendor_service_reports (id),
        work_order_verification_id      UUID REFERENCES reviews (id),
        vendor_work_verification_id     UUID REFERENCES reviews (id),
        readiness_snapshot              JSONB NOT NULL,
        submitted_by_user_id            UUID NOT NULL REFERENCES users (id),
        submitted_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT bast_submission_attempt_number_check CHECK (attempt_number >= 1),
        CONSTRAINT bast_submission_attempt_unique UNIQUE (bast_document_id, attempt_number),
        CONSTRAINT bast_submission_readiness_object_check
          CHECK (jsonb_typeof(readiness_snapshot) = 'object')
      )
    `);
    await client.query(`
      CREATE INDEX bast_submission_attempts_document_idx
        ON bast_submission_attempts (bast_document_id, attempt_number DESC);
      CREATE INDEX bast_submission_attempts_version_idx
        ON bast_submission_attempts (document_version_id);
      CREATE INDEX bast_submission_attempts_submitted_idx
        ON bast_submission_attempts (submitted_at DESC);
    `);

    // Evidence links are copied as stable IDs into an attempt rather than
    // inferred from whatever evidence happens to remain active later.
    await client.query(`
      CREATE TABLE bast_submission_attempt_evidence (
        submission_attempt_id UUID NOT NULL REFERENCES bast_submission_attempts (id) ON DELETE CASCADE,
        evidence_submission_id UUID NOT NULL REFERENCES evidence_submissions (id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (submission_attempt_id, evidence_submission_id)
      )
    `);
    await client.query(`
      CREATE INDEX bast_submission_attempt_evidence_submission_idx
        ON bast_submission_attempt_evidence (evidence_submission_id)
    `);

    // Existing sign-off APIs remain unchanged. Nullable links let future BAST
    // decisions name the exact submission and version they decided on while
    // preserving historical Handover and legacy-compatible rows.
    await client.query(`
      ALTER TABLE acceptance_sign_offs
        ADD COLUMN bast_submission_attempt_id UUID REFERENCES bast_submission_attempts (id),
        ADD COLUMN document_version_id UUID REFERENCES document_versions (id)
    `);
    await client.query(`
      CREATE INDEX acceptance_sign_offs_bast_attempt_idx
        ON acceptance_sign_offs (bast_submission_attempt_id, signed_at DESC);
      CREATE INDEX acceptance_sign_offs_document_version_idx
        ON acceptance_sign_offs (document_version_id);
    `);

    // A rejected BAST can point into the existing Finding/Rework authority.
    // This is an association only: Finding remains Work Order-sourced and owns
    // all corrective transitions.
    await client.query(`
      CREATE TABLE bast_finding_links (
        id                         UUID PRIMARY KEY,
        bast_document_id           UUID NOT NULL REFERENCES bast_documents (id) ON DELETE CASCADE,
        bast_submission_attempt_id UUID REFERENCES bast_submission_attempts (id),
        acceptance_sign_off_id     UUID REFERENCES acceptance_sign_offs (id),
        finding_id                 UUID NOT NULL REFERENCES findings (id),
        linked_by_user_id          UUID NOT NULL REFERENCES users (id),
        linked_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metadata                   JSONB NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT bast_finding_metadata_object_check
          CHECK (jsonb_typeof(metadata) = 'object'),
        CONSTRAINT bast_finding_link_unique
          UNIQUE (bast_document_id, finding_id, bast_submission_attempt_id)
      )
    `);
    await client.query(`
      CREATE INDEX bast_finding_links_bast_idx
        ON bast_finding_links (bast_document_id, linked_at DESC);
      CREATE INDEX bast_finding_links_attempt_idx
        ON bast_finding_links (bast_submission_attempt_id);
      CREATE INDEX bast_finding_links_finding_idx
        ON bast_finding_links (finding_id);
    `);

    // Optional operator-owned quarantine metadata is separate from source
    // records. The inventory endpoint only reads this table and never inserts,
    // links, renumbers, changes status, or resolves a case.
    await client.query(`
      CREATE TABLE bast_reconciliation_quarantines (
        id                          UUID PRIMARY KEY,
        bast_document_id            UUID REFERENCES bast_documents (id) ON DELETE CASCADE,
        vendor_bast_binding_id       UUID REFERENCES vendor_bast_bindings (id) ON DELETE CASCADE,
        reason_code                  TEXT NOT NULL,
        source_snapshot              JSONB NOT NULL DEFAULT '{}'::jsonb,
        notes                        TEXT,
        status                       TEXT NOT NULL DEFAULT 'OPEN',
        created_by_user_id           UUID NOT NULL REFERENCES users (id),
        resolved_by_user_id          UUID REFERENCES users (id),
        resolved_at                  TIMESTAMPTZ,
        created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT bast_reconciliation_quarantine_source_check
          CHECK (bast_document_id IS NOT NULL OR vendor_bast_binding_id IS NOT NULL),
        CONSTRAINT bast_reconciliation_quarantine_status_check
          CHECK (status IN ('OPEN', 'RESOLVED')),
        CONSTRAINT bast_reconciliation_quarantine_resolution_check
          CHECK (
            (status = 'OPEN' AND resolved_by_user_id IS NULL AND resolved_at IS NULL)
            OR
            (status = 'RESOLVED' AND resolved_by_user_id IS NOT NULL AND resolved_at IS NOT NULL)
          ),
        CONSTRAINT bast_reconciliation_snapshot_object_check
          CHECK (jsonb_typeof(source_snapshot) = 'object')
      )
    `);
    await client.query(`
      CREATE INDEX bast_reconciliation_quarantines_bast_idx
        ON bast_reconciliation_quarantines (bast_document_id, status);
      CREATE INDEX bast_reconciliation_quarantines_legacy_idx
        ON bast_reconciliation_quarantines (vendor_bast_binding_id, status);
      CREATE INDEX bast_reconciliation_quarantines_status_idx
        ON bast_reconciliation_quarantines (status, created_at DESC);
    `);

    // Database-level immutability protects attempt pins even from accidental
    // repository updates. A correction creates a new numbered attempt.
    await client.query(`
      CREATE FUNCTION reject_bast_submission_attempt_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'BAST submission attempts and their evidence pins are immutable'
          USING ERRCODE = '55000';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER bast_submission_attempts_immutable
        BEFORE UPDATE OR DELETE ON bast_submission_attempts
        FOR EACH ROW EXECUTE FUNCTION reject_bast_submission_attempt_mutation();
      CREATE TRIGGER bast_submission_attempt_evidence_immutable
        BEFORE UPDATE OR DELETE ON bast_submission_attempt_evidence
        FOR EACH ROW EXECUTE FUNCTION reject_bast_submission_attempt_mutation();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS bast_reconciliation_quarantines');
    await client.query('DROP TABLE IF EXISTS bast_finding_links');
    await client.query(`
      ALTER TABLE acceptance_sign_offs
        DROP COLUMN IF EXISTS document_version_id,
        DROP COLUMN IF EXISTS bast_submission_attempt_id
    `);
    await client.query('DROP TABLE IF EXISTS bast_submission_attempt_evidence');
    await client.query('DROP TABLE IF EXISTS bast_submission_attempts');
    await client.query('DROP FUNCTION IF EXISTS reject_bast_submission_attempt_mutation()');
    await client.query(`
      ALTER TABLE bast_documents
        DROP COLUMN IF EXISTS acceptance_scope_type,
        DROP COLUMN IF EXISTS service_report_id,
        DROP COLUMN IF EXISTS completion_report_id,
        DROP COLUMN IF EXISTS vendor_id
    `);
    await client.query(`
      ALTER TABLE work_orders DROP COLUMN IF EXISTS bast_requirement
    `);
  },
};
