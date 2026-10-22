import type { Migration } from './types';

/**
 * CR-HM-WORKER-COMPETENCY-01 — PART 01: Individual Worker Certification Foundation.
 *
 * Introduces `workforce_certifications` to model optional, per-worker
 * professional/technical/safety certificates (`certificate_number`,
 * `certificate_name`, `issuing_authority`, `issue_date`, `expiry_date`,
 * `status`, `verification_status`, and safe document references via optional
 * `document_id` and `file_reference`).
 *
 * Key invariants enforced at the database layer:
 * 1. Certifications are optional — workers with zero rows in
 *    `workforce_certifications` remain completely valid.
 * 2. Multi-client isolation — `client_id` must match the owning client of
 *    `workforce_profile_id` (via `workforce_profiles -> organizations`),
 *    and when `skill_id` or `document_id` are supplied they must belong to the
 *    exact same `client_id`.
 * 3. Safe document reference — `file_reference` (when provided) rejects
 *    path traversal (`..`), leading slashes (`/`), backslashes (`\`),
 *    whitespace/control characters, and external/executable URI schemes
 *    (`http://`, `https://`, `file://`, `javascript:`, `data:`), permitting
 *    only canonical `hm-ev://<uuid>` references or safe relative storage keys.
 * 4. Verification lifecycle — `verification_status` is constrained to
 *    `PENDING_VERIFICATION | VERIFIED | REJECTED` with mandatory verifier user
 *    and timestamp audit columns whenever `VERIFIED` or `REJECTED`.
 */
export const migration0461CreateWorkforceCertifications: Migration = {
  id: '0461_create_workforce_certifications',
  async up(client) {
    await client.query(`
      CREATE TABLE workforce_certifications (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id),
        workforce_profile_id UUID NOT NULL REFERENCES workforce_profiles (id),
        skill_id UUID REFERENCES skills (id),
        certificate_number TEXT NOT NULL,
        certificate_name TEXT NOT NULL,
        issuing_authority TEXT NOT NULL,
        issue_date TIMESTAMPTZ NOT NULL,
        expiry_date TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        verification_status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
        verified_by_user_id UUID REFERENCES users (id),
        verified_at TIMESTAMPTZ,
        document_id UUID REFERENCES documents (id),
        file_reference TEXT,
        notes TEXT,
        created_by_user_id UUID REFERENCES users (id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT workforce_certifications_status_check
          CHECK (status IN ('ACTIVE', 'EXPIRED', 'INACTIVE')),
        CONSTRAINT workforce_certifications_verification_status_check
          CHECK (
            verification_status IN ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED')
          ),
        CONSTRAINT workforce_certifications_verification_audit_check
          CHECK (
            (
              verification_status = 'PENDING_VERIFICATION'
              AND verified_by_user_id IS NULL
              AND verified_at IS NULL
            )
            OR (
              verification_status IN ('VERIFIED', 'REJECTED')
              AND verified_by_user_id IS NOT NULL
              AND verified_at IS NOT NULL
            )
          ),
        CONSTRAINT workforce_certifications_date_range_check
          CHECK (expiry_date IS NULL OR expiry_date >= issue_date),
        CONSTRAINT workforce_certifications_number_check
          CHECK (char_length(btrim(certificate_number)) BETWEEN 1 AND 128),
        CONSTRAINT workforce_certifications_name_check
          CHECK (char_length(btrim(certificate_name)) BETWEEN 1 AND 255),
        CONSTRAINT workforce_certifications_issuer_check
          CHECK (char_length(btrim(issuing_authority)) BETWEEN 1 AND 255),
        CONSTRAINT workforce_certifications_safe_file_ref_check
          CHECK (
            file_reference IS NULL
            OR (
              char_length(btrim(file_reference)) BETWEEN 1 AND 512
              AND file_reference = btrim(file_reference)
              AND position('..' in file_reference) = 0
              AND position('\\' in file_reference) = 0
              AND left(file_reference, 1) <> '/'
              AND file_reference !~ '[[:cntrl:][:space:]]'
              AND (
                file_reference ~* '^hm-ev://[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                OR (
                  position('://' in file_reference) = 0
                  AND file_reference !~* '^(javascript|data|file|vbscript|http|https|ftp):'
                  AND file_reference ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
                )
              )
            )
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX workforce_certifications_active_unique
        ON workforce_certifications (
          workforce_profile_id,
          lower(btrim(certificate_number))
        )
        WHERE status = 'ACTIVE'
    `);

    await client.query(`
      CREATE INDEX workforce_certifications_profile_idx
        ON workforce_certifications (workforce_profile_id, status, expiry_date)
    `);

    await client.query(`
      CREATE INDEX workforce_certifications_client_idx
        ON workforce_certifications (client_id, status, verification_status)
    `);

    await client.query(`
      CREATE INDEX workforce_certifications_skill_idx
        ON workforce_certifications (skill_id)
        WHERE skill_id IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX workforce_certifications_document_idx
        ON workforce_certifications (document_id)
        WHERE document_id IS NOT NULL
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION workforce_certifications_enforce_client_scope()
      RETURNS TRIGGER AS $$
      DECLARE
        v_profile_client_id UUID;
        v_skill_client_id UUID;
        v_document_client_id UUID;
      BEGIN
        SELECT o.client_id
          INTO v_profile_client_id
          FROM workforce_profiles wp
          INNER JOIN organizations o ON o.id = wp.organization_id
         WHERE wp.id = NEW.workforce_profile_id;

        IF v_profile_client_id IS NULL THEN
          RAISE EXCEPTION 'workforce_profile_id % does not exist', NEW.workforce_profile_id
            USING ERRCODE = '23503';
        END IF;

        IF v_profile_client_id <> NEW.client_id THEN
          RAISE EXCEPTION 'workforce_certifications client_id % does not match workforce_profile client_id %',
            NEW.client_id, v_profile_client_id
            USING ERRCODE = '23514';
        END IF;

        IF NEW.skill_id IS NOT NULL THEN
          SELECT s.client_id
            INTO v_skill_client_id
            FROM skills s
           WHERE s.id = NEW.skill_id;

          IF v_skill_client_id IS NULL OR v_skill_client_id <> NEW.client_id THEN
            RAISE EXCEPTION 'workforce_certifications skill_id % does not belong to client_id %',
              NEW.skill_id, NEW.client_id
              USING ERRCODE = '23514';
          END IF;
        END IF;

        IF NEW.document_id IS NOT NULL THEN
          SELECT d.client_id
            INTO v_document_client_id
            FROM documents d
           WHERE d.id = NEW.document_id;

          IF v_document_client_id IS NULL OR v_document_client_id <> NEW.client_id THEN
            RAISE EXCEPTION 'workforce_certifications document_id % does not belong to client_id %',
              NEW.document_id, NEW.client_id
              USING ERRCODE = '23514';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(`
      CREATE TRIGGER trg_workforce_certifications_enforce_client_scope
        BEFORE INSERT OR UPDATE ON workforce_certifications
        FOR EACH ROW
        EXECUTE FUNCTION workforce_certifications_enforce_client_scope()
    `);
  },

  async down(client) {
    await client.query(`
      DROP TRIGGER IF EXISTS trg_workforce_certifications_enforce_client_scope
        ON workforce_certifications
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS workforce_certifications_enforce_client_scope()
    `);
    await client.query(`
      DROP TABLE IF EXISTS workforce_certifications
    `);
  },
};
