import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-TAX-INDONESIA-01 PART 01A. Identity assertions only, never tax
 * approval. Existing 0490 issuer versions and 0493 verified BM parties remain
 * the identities; nothing is backfilled into financial facts.
 *
 * Profile and closure rows are immutable facts. The separately protected
 * window is only a GiST-enforced projection of those facts. Closing an open
 * window therefore never rewrites the profile or its snapshot digest.
 */
export const migration0495HandymanTaxIdentityProfiles: Migration = {
  id: '0495_handyman_tax_identity_profiles',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE TABLE handyman_tax_identity_profiles (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id),
        owner_kind TEXT NOT NULL CHECK (owner_kind IN ('HANDYMAN_ISSUER', 'BM_BENEFICIARY')),
        owner_id UUID NOT NULL,
        issuer_profile_id UUID REFERENCES handyman_document_issuer_profiles (id),
        counterparty_id UUID REFERENCES handyman_bm_legal_counterparties (id),
        verification_id UUID,
        version INTEGER NOT NULL CHECK (version > 0),
        legal_name TEXT NOT NULL CHECK (char_length(btrim(legal_name)) BETWEEN 1 AND 200),
        taxpayer_kind TEXT NOT NULL CHECK (taxpayer_kind IN ('UNKNOWN', 'LEGAL_ENTITY', 'INDIVIDUAL')),
        individual_residency TEXT CHECK (individual_residency IN ('UNKNOWN', 'RESIDENT', 'NON_RESIDENT')),
        identifier_kind TEXT CHECK (identifier_kind IN ('NPWP_15', 'NPWP_16', 'NIK_NPWP_16')),
        identifier_value TEXT,
        pkp_status TEXT NOT NULL CHECK (pkp_status IN ('UNKNOWN', 'PKP', 'NON_PKP')),
        approval_status TEXT NOT NULL DEFAULT 'UNAPPROVED' CHECK (approval_status = 'UNAPPROVED'),
        effective_from TIMESTAMPTZ NOT NULL,
        declared_effective_to TIMESTAMPTZ,
        evidence_source TEXT NOT NULL CHECK (char_length(btrim(evidence_source)) BETWEEN 1 AND 200),
        evidence_reference TEXT NOT NULL CHECK (char_length(btrim(evidence_reference)) BETWEEN 1 AND 500),
        idempotency_key TEXT NOT NULL UNIQUE CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hm_tax_profile_verification_fk FOREIGN KEY (verification_id, counterparty_id)
          REFERENCES handyman_bm_counterparty_verifications (id, counterparty_id),
        CONSTRAINT hm_tax_profile_owner_check CHECK (
          (owner_kind = 'HANDYMAN_ISSUER' AND owner_id = client_id AND issuer_profile_id IS NOT NULL
            AND counterparty_id IS NULL AND verification_id IS NULL)
          OR (owner_kind = 'BM_BENEFICIARY' AND owner_id = counterparty_id AND issuer_profile_id IS NULL
            AND counterparty_id IS NOT NULL AND verification_id IS NOT NULL)
        ),
        CONSTRAINT hm_tax_profile_identifier_check CHECK (
          (identifier_kind IS NULL AND identifier_value IS NULL)
          OR (identifier_kind IS NOT NULL AND identifier_value IS NOT NULL AND identifier_value !~ '^0+$' AND (
            (identifier_kind = 'NPWP_15' AND identifier_value ~ '^[0-9]{15}$')
            OR (identifier_kind = 'NPWP_16' AND identifier_value ~ '^[0-9]{16}$'
              AND (taxpayer_kind = 'LEGAL_ENTITY'
                OR (taxpayer_kind = 'INDIVIDUAL' AND individual_residency = 'NON_RESIDENT')))
            OR (identifier_kind = 'NIK_NPWP_16' AND taxpayer_kind = 'INDIVIDUAL'
              AND individual_residency = 'RESIDENT' AND identifier_value ~ '^[0-9]{16}$')
          ))
        ),
        CONSTRAINT hm_tax_profile_classification_check CHECK (
          ((taxpayer_kind = 'INDIVIDUAL' AND individual_residency IS NOT NULL)
            OR (taxpayer_kind <> 'INDIVIDUAL' AND individual_residency IS NULL))
          AND (taxpayer_kind <> 'UNKNOWN' OR pkp_status = 'UNKNOWN')
          AND (pkp_status = 'UNKNOWN' OR identifier_value IS NOT NULL)
        ),
        CONSTRAINT hm_tax_profile_dates_check CHECK (
          isfinite(effective_from) AND date_trunc('milliseconds', effective_from) = effective_from
          AND (declared_effective_to IS NULL OR (isfinite(declared_effective_to)
            AND date_trunc('milliseconds', declared_effective_to) = declared_effective_to
            AND declared_effective_to > effective_from))
        ),
        CONSTRAINT hm_tax_profile_version_unique UNIQUE (owner_kind, owner_id, version)
      );

      CREATE TABLE handyman_tax_identity_windows (
        profile_id UUID PRIMARY KEY REFERENCES handyman_tax_identity_profiles (id),
        owner_kind TEXT NOT NULL,
        owner_id UUID NOT NULL,
        effective_from TIMESTAMPTZ NOT NULL,
        effective_to TIMESTAMPTZ,
        CONSTRAINT hm_tax_identity_window_no_overlap EXCLUDE USING gist (
          owner_kind WITH =, owner_id WITH =,
          tstzrange(effective_from, effective_to, '[)') WITH &&
        )
      );

      CREATE TABLE handyman_tax_identity_closures (
        id UUID PRIMARY KEY,
        profile_id UUID NOT NULL UNIQUE REFERENCES handyman_tax_identity_profiles (id),
        effective_to TIMESTAMPTZ NOT NULL CHECK (
          isfinite(effective_to) AND date_trunc('milliseconds', effective_to) = effective_to
        ),
        reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await tx.query(`
      CREATE FUNCTION hm_tax_identity_no_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Tax identity versions and closures are immutable history.' USING ERRCODE = '23514';
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_profile_no_mutation BEFORE UPDATE OR DELETE ON handyman_tax_identity_profiles
        FOR EACH ROW EXECUTE FUNCTION hm_tax_identity_no_mutation();
      CREATE TRIGGER hm_tax_closure_no_mutation BEFORE UPDATE OR DELETE ON handyman_tax_identity_closures
        FOR EACH ROW EXECUTE FUNCTION hm_tax_identity_no_mutation();

      CREATE FUNCTION hm_tax_identity_validate_profile() RETURNS trigger AS $$
      DECLARE
        anchor_name TEXT; anchor_from TIMESTAMPTZ; anchor_to TIMESTAMPTZ;
        anchor_status TEXT; proof_id UUID; verified TIMESTAMPTZ; next_version INTEGER;
      BEGIN
        -- These are the same stable authority rows used by 0490/0493 writers.
        -- The unique version and GiST exclusion also protect old snapshots at
        -- REPEATABLE READ, where a waiter cannot see the winner's commit.
        IF NEW.owner_kind = 'HANDYMAN_ISSUER' THEN
          PERFORM 1 FROM clients WHERE id = NEW.client_id FOR UPDATE;
          SELECT legal_name, effective_from, superseded_at, status
            INTO anchor_name, anchor_from, anchor_to, anchor_status
            FROM handyman_document_issuer_profiles
           WHERE id = NEW.issuer_profile_id AND client_id = NEW.client_id FOR SHARE;
          IF anchor_name IS NULL OR NEW.owner_id IS DISTINCT FROM NEW.client_id
             OR NEW.legal_name IS DISTINCT FROM anchor_name
             OR anchor_status NOT IN ('ACTIVE', 'SUPERSEDED')
             OR (anchor_status = 'SUPERSEDED' AND anchor_to IS NULL)
             OR NEW.effective_from < anchor_from
             OR (anchor_to IS NOT NULL AND (NEW.effective_from >= anchor_to
                  OR NEW.declared_effective_to IS NULL OR NEW.declared_effective_to > anchor_to)) THEN
            RAISE EXCEPTION 'Tax identity must match and fit its exact issuer profile.' USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.owner_kind = 'BM_BENEFICIARY' THEN
          SELECT legal_name INTO anchor_name FROM handyman_bm_legal_counterparties
           WHERE id = NEW.counterparty_id AND client_id = NEW.client_id FOR UPDATE;
          SELECT id, verified_at INTO proof_id, verified FROM handyman_bm_counterparty_verifications
           WHERE id = NEW.verification_id AND counterparty_id = NEW.counterparty_id;
          IF anchor_name IS NULL OR NEW.owner_id IS DISTINCT FROM NEW.counterparty_id
             OR NEW.legal_name IS DISTINCT FROM anchor_name OR proof_id IS NULL
             OR verified IS NULL OR NEW.effective_from < verified THEN
            RAISE EXCEPTION 'Tax identity requires the exact verified BM beneficiary and Client.' USING ERRCODE = '23514';
          END IF;
        ELSE
          RAISE EXCEPTION 'Unsupported tax identity owner.' USING ERRCODE = '23514';
        END IF;
        SELECT COALESCE(MAX(version), 0) + 1 INTO next_version FROM handyman_tax_identity_profiles
         WHERE owner_kind = NEW.owner_kind AND owner_id = NEW.owner_id;
        IF NEW.version <> next_version THEN
          RAISE EXCEPTION 'Tax identity version must follow the immutable owner history.' USING ERRCODE = '23514';
        END IF;
        NEW.created_at := date_trunc('milliseconds', clock_timestamp());
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_profile_validate BEFORE INSERT ON handyman_tax_identity_profiles
        FOR EACH ROW EXECUTE FUNCTION hm_tax_identity_validate_profile();

      CREATE FUNCTION hm_tax_window_guard() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Tax identity window projection cannot be deleted.' USING ERRCODE = '23514';
        ELSIF TG_OP = 'INSERT' THEN
          IF NOT EXISTS (SELECT 1 FROM handyman_tax_identity_profiles p
            WHERE p.id = NEW.profile_id AND p.owner_kind = NEW.owner_kind AND p.owner_id = NEW.owner_id
              AND p.effective_from = NEW.effective_from
              AND p.declared_effective_to IS NOT DISTINCT FROM NEW.effective_to) THEN
            RAISE EXCEPTION 'Tax identity window must project its immutable profile.' USING ERRCODE = '23514';
          END IF;
        ELSE
          IF ROW(NEW.profile_id, NEW.owner_kind, NEW.owner_id, NEW.effective_from)
             IS DISTINCT FROM ROW(OLD.profile_id, OLD.owner_kind, OLD.owner_id, OLD.effective_from)
             OR NOT EXISTS (SELECT 1 FROM handyman_tax_identity_closures c
               WHERE c.profile_id = OLD.profile_id AND c.effective_to = NEW.effective_to) THEN
            RAISE EXCEPTION 'Tax identity window may only project its immutable closure.' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_window_projection_guard BEFORE INSERT OR UPDATE OR DELETE ON handyman_tax_identity_windows
        FOR EACH ROW EXECUTE FUNCTION hm_tax_window_guard();

      CREATE FUNCTION hm_tax_identity_project_profile() RETURNS trigger AS $$
      BEGIN
        INSERT INTO handyman_tax_identity_windows (profile_id, owner_kind, owner_id, effective_from, effective_to)
          VALUES (NEW.id, NEW.owner_kind, NEW.owner_id, NEW.effective_from, NEW.declared_effective_to);
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_profile_window AFTER INSERT ON handyman_tax_identity_profiles
        FOR EACH ROW EXECUTE FUNCTION hm_tax_identity_project_profile();

      CREATE FUNCTION hm_tax_identity_validate_closure() RETURNS trigger AS $$
      DECLARE window_from TIMESTAMPTZ; window_to TIMESTAMPTZ;
      BEGIN
        SELECT effective_from, effective_to INTO window_from, window_to
          FROM handyman_tax_identity_windows WHERE profile_id = NEW.profile_id FOR UPDATE;
        IF window_from IS NULL OR NOT (
          -- An empty window cancels an as-yet-unstarted identity without
          -- rewriting or removing the immutable asserted version.
          (NEW.effective_to = window_from AND statement_timestamp() < window_from)
          OR (NEW.effective_to > window_from AND NEW.effective_to >= statement_timestamp()
            AND (window_to IS NULL OR NEW.effective_to < window_to))
        ) THEN
          RAISE EXCEPTION 'Tax identity can only be closed prospectively or cancelled before it starts.' USING ERRCODE = '23514';
        END IF;
        NEW.created_at := date_trunc('milliseconds', clock_timestamp());
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_closure_validate BEFORE INSERT ON handyman_tax_identity_closures
        FOR EACH ROW EXECUTE FUNCTION hm_tax_identity_validate_closure();

      CREATE FUNCTION hm_tax_identity_project_closure() RETURNS trigger AS $$
      BEGIN
        UPDATE handyman_tax_identity_windows SET effective_to = NEW.effective_to WHERE profile_id = NEW.profile_id;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_closure_window AFTER INSERT ON handyman_tax_identity_closures
        FOR EACH ROW EXECUTE FUNCTION hm_tax_identity_project_closure();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_tax_identity_profiles)
          OR EXISTS (SELECT 1 FROM handyman_tax_identity_closures)
          OR EXISTS (SELECT 1 FROM handyman_tax_identity_windows) THEN
          RAISE EXCEPTION 'Refusing to remove populated tax identity history.';
        END IF;
      END $$;
      DROP TABLE handyman_tax_identity_closures;
      DROP TABLE handyman_tax_identity_windows;
      DROP TABLE handyman_tax_identity_profiles;
      DROP FUNCTION hm_tax_identity_project_closure();
      DROP FUNCTION hm_tax_identity_validate_closure();
      DROP FUNCTION hm_tax_identity_project_profile();
      DROP FUNCTION hm_tax_window_guard();
      DROP FUNCTION hm_tax_identity_validate_profile();
      DROP FUNCTION hm_tax_identity_no_mutation();
    `);
  },
};
