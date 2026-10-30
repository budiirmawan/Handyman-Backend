import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BM-COMMISSION-01 PART 01B. Additive identity and explicit Building
 * coverage only. The 0415 CLIENT_ORGANIZATION rows and all earned/settled
 * facts keep their original meanings; no backfill or inferred coverage.
 *
 * A verification is an explicit, immutable human decision with evidence.
 * Coverage binds one exact, effective commercial version and its existing BM
 * rule/term to a verified legal counterparty. Legacy CLIENT_ORGANIZATION
 * coverage must also bind the original 0415 beneficiary and a verified
 * identity explicitly representing that Client. A distinct BM legal party is
 * a separate building-scoped beneficiary, never re-labelled as the Client.
 *
 * A GiST exclusion protects half-open Building windows even under concurrent
 * writers. A future closure/cancellation preserves history; version
 * supersession cannot truncate an existing coverage window silently. The
 * legacy entitlement store can only represent Client beneficiaries, so new
 * facts are refused unless an exact verified legacy coverage exists.
 */
export const migration0493HandymanBmBeneficiaryBuildingCoverage: Migration = {
  id: '0493_handyman_bm_beneficiary_building_coverage',
  async up(client: PoolClient): Promise<void> {
    await client.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    await client.query(`
      CREATE TABLE handyman_bm_legal_counterparties (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id),
        legal_name TEXT NOT NULL CHECK (char_length(btrim(legal_name)) BETWEEN 1 AND 200),
        registration_number TEXT NOT NULL CHECK (char_length(btrim(registration_number)) BETWEEN 1 AND 120),
        represented_client_id UUID REFERENCES clients (id),
        idempotency_key TEXT NOT NULL UNIQUE CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hm_bm_party_represented_client_check
          CHECK (represented_client_id IS NULL OR represented_client_id = client_id),
        CONSTRAINT hm_bm_party_registration_unique UNIQUE (client_id, registration_number)
      );
      CREATE TABLE handyman_bm_counterparty_verifications (
        id UUID PRIMARY KEY,
        counterparty_id UUID NOT NULL UNIQUE REFERENCES handyman_bm_legal_counterparties (id),
        evidence_reference TEXT NOT NULL CHECK (char_length(btrim(evidence_reference)) BETWEEN 1 AND 500),
        verified_by_user_id UUID NOT NULL REFERENCES users (id),
        verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hm_bm_verification_id_party_unique UNIQUE (id, counterparty_id)
      );
      CREATE TABLE handyman_bm_building_coverages (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id),
        building_id UUID NOT NULL REFERENCES buildings (id),
        agreement_version_id UUID NOT NULL REFERENCES handyman_commercial_agreement_versions (id),
        counterparty_id UUID NOT NULL REFERENCES handyman_bm_legal_counterparties (id),
        verification_id UUID NOT NULL,
        beneficiary_kind TEXT NOT NULL CHECK (beneficiary_kind IN ('CLIENT_ORGANIZATION', 'BM_LEGAL_COUNTERPARTY')),
        beneficiary_definition_id UUID REFERENCES handyman_bm_fee_beneficiary_definitions (id),
        effective_from TIMESTAMPTZ NOT NULL,
        original_effective_to TIMESTAMPTZ,
        effective_to TIMESTAMPTZ,
        idempotency_key TEXT NOT NULL UNIQUE CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_by_user_id UUID REFERENCES users (id),
        closed_at TIMESTAMPTZ,
        closure_reason TEXT,
        cancelled_by_user_id UUID REFERENCES users (id),
        cancelled_at TIMESTAMPTZ,
        cancellation_reason TEXT,
        CONSTRAINT hm_bm_coverage_verification_fk FOREIGN KEY (verification_id, counterparty_id)
          REFERENCES handyman_bm_counterparty_verifications (id, counterparty_id),
        CONSTRAINT hm_bm_coverage_beneficiary_check CHECK (
          (beneficiary_kind = 'CLIENT_ORGANIZATION' AND beneficiary_definition_id IS NOT NULL)
          OR (beneficiary_kind = 'BM_LEGAL_COUNTERPARTY' AND beneficiary_definition_id IS NULL)
        ),
        CONSTRAINT hm_bm_coverage_window_check CHECK (
          (original_effective_to IS NULL OR original_effective_to > effective_from)
          AND (effective_to IS NULL OR effective_to > effective_from)
          AND (original_effective_to IS NULL OR effective_to <= original_effective_to)
        ),
        CONSTRAINT hm_bm_coverage_closure_check CHECK (
          (closed_at IS NULL AND closed_by_user_id IS NULL AND closure_reason IS NULL)
          OR (closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL
              AND char_length(btrim(closure_reason)) BETWEEN 1 AND 500)
        ),
        CONSTRAINT hm_bm_coverage_cancellation_check CHECK (
          (cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancellation_reason IS NULL)
          OR (cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL
              AND char_length(btrim(cancellation_reason)) BETWEEN 1 AND 500)
        ),
        CONSTRAINT hm_bm_coverage_no_overlap EXCLUDE USING gist (
          building_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&
        ) WHERE (cancelled_at IS NULL)
      );
      CREATE INDEX hm_bm_coverage_version_idx ON handyman_bm_building_coverages (agreement_version_id);
    `);
    await client.query(`
      CREATE FUNCTION hm_bm_identity_no_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'BM legal identity and verification are immutable.' USING ERRCODE = '23514';
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_bm_party_no_mutation BEFORE UPDATE OR DELETE ON handyman_bm_legal_counterparties
        FOR EACH ROW EXECUTE FUNCTION hm_bm_identity_no_mutation();
      CREATE TRIGGER hm_bm_verification_no_mutation BEFORE UPDATE OR DELETE ON handyman_bm_counterparty_verifications
        FOR EACH ROW EXECUTE FUNCTION hm_bm_identity_no_mutation();
      CREATE FUNCTION hm_bm_verification_server_time() RETURNS trigger AS $$
      BEGIN
        -- Public timestamps and ledger anchors are millisecond precision.
        -- Round up, never down into an instant before the verification decision.
        NEW.verified_at := date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond';
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_bm_verification_time BEFORE INSERT ON handyman_bm_counterparty_verifications
        FOR EACH ROW EXECUTE FUNCTION hm_bm_verification_server_time();
    `);
    await client.query(`
      CREATE FUNCTION hm_bm_coverage_validate() RETURNS trigger AS $$
      DECLARE
        v_status TEXT; v_from TIMESTAMPTZ; v_to TIMESTAMPTZ; v_client UUID;
        building_client UUID; party_client UUID; represented_client UUID; verified TIMESTAMPTZ;
        legacy_version UUID; legacy_kind TEXT; legacy_ref UUID;
      BEGIN
        -- This row lock serializes insertion with agreement supersession.
        SELECT v.status, v.effective_from, v.effective_to, a.client_id
          INTO v_status, v_from, v_to, v_client
          FROM handyman_commercial_agreement_versions v
          JOIN handyman_commercial_agreements a ON a.id = v.agreement_id
         WHERE v.id = NEW.agreement_version_id FOR SHARE OF v;
        SELECT p.client_id INTO building_client
          FROM buildings b JOIN properties p ON p.id = b.property_id
         WHERE b.id = NEW.building_id FOR SHARE OF b, p;
        SELECT c.client_id, c.represented_client_id, x.verified_at
          INTO party_client, represented_client, verified
          FROM handyman_bm_legal_counterparties c
          JOIN handyman_bm_counterparty_verifications x ON x.counterparty_id = c.id
         WHERE c.id = NEW.counterparty_id AND x.id = NEW.verification_id;
        IF v_client IS DISTINCT FROM NEW.client_id OR building_client IS DISTINCT FROM NEW.client_id
           OR party_client IS DISTINCT FROM NEW.client_id THEN
          RAISE EXCEPTION 'BM coverage must match the exact Client, Building, agreement and verified counterparty.' USING ERRCODE = '23514';
        END IF;
        IF verified IS NULL OR NEW.effective_from < verified THEN
          RAISE EXCEPTION 'BM beneficiary must be verified before coverage begins.' USING ERRCODE = '23514';
        END IF;
        IF v_status NOT IN ('ACTIVE', 'SUPERSEDED') OR v_from IS NULL
           OR NEW.effective_from < v_from
           OR (v_to IS NOT NULL AND (NEW.effective_to IS NULL OR NEW.effective_to > v_to)) THEN
          RAISE EXCEPTION 'BM coverage must fit the exact effective agreement version.' USING ERRCODE = '23514';
        END IF;
        IF NEW.original_effective_to IS DISTINCT FROM NEW.effective_to
           OR NEW.closed_at IS NOT NULL OR NEW.closed_by_user_id IS NOT NULL OR NEW.closure_reason IS NOT NULL
           OR NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by_user_id IS NOT NULL OR NEW.cancellation_reason IS NOT NULL THEN
          RAISE EXCEPTION 'BM coverage must begin as an unmodified binding.' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM handyman_bm_fee_rule_definitions r
          WHERE r.agreement_version_id = NEW.agreement_version_id AND r.mode = 'DEFAULT' AND r.basis = 'LABOR_ONLY')
          OR NOT EXISTS (SELECT 1 FROM handyman_bm_fee_term_definitions t
          WHERE t.agreement_version_id = NEW.agreement_version_id AND t.term_kind = 'PERCENTAGE_OF_BASIS') THEN
          RAISE EXCEPTION 'BM coverage requires the exact version DEFAULT rule and term.' USING ERRCODE = '23514';
        END IF;
        IF NEW.beneficiary_kind = 'CLIENT_ORGANIZATION' THEN
          SELECT agreement_version_id, beneficiary_kind, beneficiary_reference_id
            INTO legacy_version, legacy_kind, legacy_ref
            FROM handyman_bm_fee_beneficiary_definitions WHERE id = NEW.beneficiary_definition_id;
          IF represented_client IS DISTINCT FROM NEW.client_id
             OR legacy_version IS DISTINCT FROM NEW.agreement_version_id
             OR legacy_kind IS DISTINCT FROM 'CLIENT_ORGANIZATION'
             OR legacy_ref IS DISTINCT FROM NEW.client_id THEN
            RAISE EXCEPTION 'Legacy BM beneficiary must be the verified represented Client on the exact version.' USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.beneficiary_kind = 'BM_LEGAL_COUNTERPARTY' AND represented_client IS NOT NULL THEN
          RAISE EXCEPTION 'A represented Client must not be re-labelled as a distinct BM legal counterparty.' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_bm_coverage_insert BEFORE INSERT ON handyman_bm_building_coverages
        FOR EACH ROW EXECUTE FUNCTION hm_bm_coverage_validate();
    `);
    await client.query(`
      CREATE FUNCTION hm_bm_coverage_lifecycle() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'BM coverage is history-preserving.' USING ERRCODE = '23514';
        END IF;
        IF ROW(NEW.id, NEW.client_id, NEW.building_id, NEW.agreement_version_id,
               NEW.counterparty_id, NEW.verification_id, NEW.beneficiary_kind,
               NEW.beneficiary_definition_id, NEW.effective_from, NEW.original_effective_to,
               NEW.idempotency_key, NEW.created_by_user_id, NEW.created_at)
           IS DISTINCT FROM
           ROW(OLD.id, OLD.client_id, OLD.building_id, OLD.agreement_version_id,
               OLD.counterparty_id, OLD.verification_id, OLD.beneficiary_kind,
               OLD.beneficiary_definition_id, OLD.effective_from, OLD.original_effective_to,
               OLD.idempotency_key, OLD.created_by_user_id, OLD.created_at) THEN
          RAISE EXCEPTION 'BM coverage identity is immutable.' USING ERRCODE = '23514';
        END IF;
        IF OLD.closed_at IS NULL AND OLD.cancelled_at IS NULL
           AND NEW.cancelled_at IS NULL AND NEW.cancelled_by_user_id IS NULL AND NEW.cancellation_reason IS NULL
           AND NEW.closed_at IS NOT NULL AND NEW.closed_by_user_id IS NOT NULL
           AND char_length(btrim(NEW.closure_reason)) BETWEEN 1 AND 500
           AND NEW.effective_to IS NOT NULL AND NEW.effective_to > OLD.effective_from
           AND NEW.effective_to >= statement_timestamp()
           AND (OLD.effective_to IS NULL OR NEW.effective_to < OLD.effective_to) THEN
          NEW.closed_at := date_trunc('milliseconds', clock_timestamp());
          RETURN NEW;
        END IF;
        IF OLD.closed_at IS NULL AND OLD.cancelled_at IS NULL
           AND NEW.closed_at IS NULL AND NEW.closed_by_user_id IS NULL AND NEW.closure_reason IS NULL
           AND NEW.cancelled_at IS NOT NULL AND NEW.cancelled_by_user_id IS NOT NULL
           AND char_length(btrim(NEW.cancellation_reason)) BETWEEN 1 AND 500
           AND NEW.effective_to IS NOT DISTINCT FROM OLD.effective_to
           AND statement_timestamp() < OLD.effective_from THEN
          NEW.cancelled_at := date_trunc('milliseconds', clock_timestamp());
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'BM coverage may only be closed prospectively or cancelled before it starts.' USING ERRCODE = '23514';
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_bm_coverage_no_rewrite BEFORE UPDATE OR DELETE ON handyman_bm_building_coverages
        FOR EACH ROW EXECUTE FUNCTION hm_bm_coverage_lifecycle();

      CREATE FUNCTION hm_bm_version_coverage_guard() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM handyman_bm_building_coverages c
          WHERE c.agreement_version_id = NEW.id AND c.cancelled_at IS NULL
            AND (NEW.status NOT IN ('ACTIVE', 'SUPERSEDED') OR NEW.effective_from IS NULL
              OR c.effective_from < NEW.effective_from
              OR (NEW.effective_to IS NOT NULL AND (c.effective_to IS NULL OR c.effective_to > NEW.effective_to)))) THEN
          RAISE EXCEPTION 'Close or cancel BM Building coverage before truncating its agreement version.'
            USING ERRCODE = '23514', CONSTRAINT = 'hm_bm_version_coverage';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_bm_version_coverage BEFORE UPDATE ON handyman_commercial_agreement_versions
        FOR EACH ROW EXECUTE FUNCTION hm_bm_version_coverage_guard();
    `);
    await client.query(`
      CREATE FUNCTION hm_bm_entitlement_coverage_guard() RETURNS trigger AS $$
      BEGIN
        IF NEW.entitlement_kind <> 'BM_FEE' THEN RETURN NEW; END IF;
        -- The old fact schema can name only the Client. Never store a different
        -- BM payee as that Client, and never infer coverage from Client alone.
        PERFORM 1 FROM handyman_execution_scopes s
          JOIN buildings b ON b.id = s.building_id
          JOIN properties p ON p.id = b.property_id AND p.client_id = s.client_id
          JOIN handyman_bm_building_coverages c ON c.client_id = s.client_id AND c.building_id = s.building_id
          JOIN handyman_bm_legal_counterparties party ON party.id = c.counterparty_id AND party.client_id = c.client_id
          JOIN handyman_bm_counterparty_verifications x ON x.id = c.verification_id AND x.counterparty_id = party.id
          JOIN handyman_commercial_agreement_versions v ON v.id = c.agreement_version_id
         WHERE s.id = NEW.execution_scope_id AND s.client_id = NEW.client_id
           AND c.cancelled_at IS NULL AND c.beneficiary_kind = 'CLIENT_ORGANIZATION'
           AND party.represented_client_id = NEW.client_id
           AND c.beneficiary_definition_id = NEW.bm_beneficiary_id
           AND c.agreement_version_id = NEW.agreement_version_id
           AND NEW.bm_beneficiary_reference_id = NEW.client_id
           AND c.effective_from <= NEW.ledger_posted_at
           AND (c.effective_to IS NULL OR NEW.ledger_posted_at < c.effective_to)
           AND x.verified_at <= NEW.ledger_posted_at
           AND v.status IN ('ACTIVE', 'SUPERSEDED') AND v.effective_from <= NEW.ledger_posted_at
           AND (v.effective_to IS NULL OR NEW.ledger_posted_at < v.effective_to)
         FOR SHARE OF c, v, b, p;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Exact verified Client-beneficiary Building coverage required for a new BM entitlement.' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_bm_entitlement_coverage BEFORE INSERT ON handyman_entitlement_facts
        FOR EACH ROW EXECUTE FUNCTION hm_bm_entitlement_coverage_guard();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    // Dropping a populated identity/coverage ledger would erase authority.
    const result = await client.query(`SELECT
      EXISTS (SELECT 1 FROM handyman_bm_legal_counterparties) OR
      EXISTS (SELECT 1 FROM handyman_bm_counterparty_verifications) OR
      EXISTS (SELECT 1 FROM handyman_bm_building_coverages) AS populated`);
    if (result.rows[0].populated) {
      throw new Error('Refusing to remove populated BM legal identity/coverage history.');
    }
    await client.query(`
      DROP TRIGGER IF EXISTS hm_bm_entitlement_coverage ON handyman_entitlement_facts;
      DROP TRIGGER IF EXISTS hm_bm_version_coverage ON handyman_commercial_agreement_versions;
      DROP FUNCTION IF EXISTS hm_bm_entitlement_coverage_guard();
      DROP FUNCTION IF EXISTS hm_bm_version_coverage_guard();
      DROP TABLE handyman_bm_building_coverages;
      DROP TABLE handyman_bm_counterparty_verifications;
      DROP TABLE handyman_bm_legal_counterparties;
      DROP FUNCTION IF EXISTS hm_bm_coverage_validate();
      DROP FUNCTION IF EXISTS hm_bm_coverage_lifecycle();
      DROP FUNCTION IF EXISTS hm_bm_verification_server_time();
      DROP FUNCTION IF EXISTS hm_bm_identity_no_mutation();
    `);
  },
};
