import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * Finance maker-checker approval of exact 0495 assertions. The assertion and
 * its V1 digest are never changed; approval facts are a separate history.
 * The head projection serializes new versions against approval even when a
 * REPEATABLE READ transaction began before the competing version committed.
 */
export const migration0496HandymanTaxIdentityApproval: Migration = {
  id: '0496_handyman_tax_identity_approval',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`INSERT INTO permissions (id, code, name, status)
      VALUES ($1, 'handyman.tax_identity.approve', 'Approve or reject Handyman tax identities', 'ACTIVE')
      ON CONFLICT (code) DO NOTHING`, [randomUUID()]);

    // No profile can slip between the projection backfill and trigger install.
    await tx.query('LOCK TABLE handyman_tax_identity_profiles IN SHARE ROW EXCLUSIVE MODE');
    await tx.query(`
      CREATE TABLE handyman_tax_identity_heads (
        owner_kind TEXT NOT NULL,
        owner_id UUID NOT NULL,
        latest_version INTEGER NOT NULL CHECK (latest_version > 0),
        latest_profile_id UUID NOT NULL REFERENCES handyman_tax_identity_profiles (id),
        PRIMARY KEY (owner_kind, owner_id)
      );
      INSERT INTO handyman_tax_identity_heads (owner_kind, owner_id, latest_version, latest_profile_id)
        SELECT DISTINCT ON (owner_kind, owner_id) owner_kind, owner_id, version, id
          FROM handyman_tax_identity_profiles ORDER BY owner_kind, owner_id, version DESC;

      CREATE FUNCTION hm_tax_identity_head_guard() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Tax identity head is a protected version projection.' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM handyman_tax_identity_profiles p
          WHERE p.id = NEW.latest_profile_id AND p.owner_kind = NEW.owner_kind
            AND p.owner_id = NEW.owner_id AND p.version = NEW.latest_version) THEN
          RAISE EXCEPTION 'Tax identity head must identify an existing exact profile.' USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' AND (NEW.owner_kind IS DISTINCT FROM OLD.owner_kind
          OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.latest_version <> OLD.latest_version + 1) THEN
          RAISE EXCEPTION 'Tax identity head advances one immutable version at a time.' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_identity_head_guard BEFORE INSERT OR UPDATE OR DELETE ON handyman_tax_identity_heads
        FOR EACH ROW EXECUTE FUNCTION hm_tax_identity_head_guard();

      CREATE FUNCTION hm_tax_identity_advance_head() RETURNS trigger AS $$
      BEGIN
        INSERT INTO handyman_tax_identity_heads (owner_kind, owner_id, latest_version, latest_profile_id)
          VALUES (NEW.owner_kind, NEW.owner_id, NEW.version, NEW.id)
        ON CONFLICT (owner_kind, owner_id) DO UPDATE
          SET latest_version = EXCLUDED.latest_version, latest_profile_id = EXCLUDED.latest_profile_id;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_profile_head AFTER INSERT ON handyman_tax_identity_profiles
        FOR EACH ROW EXECUTE FUNCTION hm_tax_identity_advance_head();

      -- Match the frozen HANDYMAN_TAX_IDENTITY_V1 stableJson payload exactly:
      -- scalar JSON values, keys ordered lexically and UTC millisecond dates.
      -- pgcrypto already exists in migration 0230. Exotic out-of-JS-range
      -- dates fail closed instead of producing a different digest.
      CREATE FUNCTION hm_tax_identity_payload_digest(profile_uuid UUID) RETURNS TEXT
      LANGUAGE sql STABLE AS $$
        SELECT encode(digest(convert_to('{' || (
          SELECT string_agg(to_json(k)::text || ':' || v::text, ',' ORDER BY k COLLATE "C")
          FROM json_each(json_build_object(
            'schema', 'HANDYMAN_TAX_IDENTITY_V1', 'id', p.id::text,
            'clientId', p.client_id::text, 'ownerKind', p.owner_kind, 'ownerId', p.owner_id::text,
            'issuerProfileId', p.issuer_profile_id::text, 'counterpartyId', p.counterparty_id::text,
            'verificationId', p.verification_id::text, 'version', p.version, 'legalName', p.legal_name,
            'taxpayerKind', p.taxpayer_kind, 'individualResidency', p.individual_residency,
            'identifierKind', p.identifier_kind, 'identifierValue', p.identifier_value,
            'pkpStatus', p.pkp_status, 'approvalStatus', p.approval_status,
            'effectiveFrom', to_char(p.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'declaredEffectiveTo', CASE WHEN p.declared_effective_to IS NULL THEN NULL ELSE
              to_char(p.declared_effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
            'evidenceSource', p.evidence_source, 'evidenceReference', p.evidence_reference,
            'createdByUserId', p.created_by_user_id::text,
            'createdAt', to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )) AS j(k, v)
        ) || '}', 'UTF8'), 'sha256'), 'hex')
        FROM handyman_tax_identity_profiles p
        WHERE p.id = profile_uuid
          AND p.effective_from >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
          AND p.effective_from <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'
          AND (p.declared_effective_to IS NULL OR (p.declared_effective_to >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
            AND p.declared_effective_to <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'))
          AND p.created_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
          AND p.created_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'
      $$;

      CREATE TABLE handyman_tax_identity_approval_events (
        id UUID PRIMARY KEY,
        profile_id UUID NOT NULL REFERENCES handyman_tax_identity_profiles (id),
        client_id UUID NOT NULL REFERENCES clients (id),
        owner_kind TEXT NOT NULL CHECK (owner_kind IN ('HANDYMAN_ISSUER', 'BM_BENEFICIARY')),
        owner_id UUID NOT NULL,
        profile_version INTEGER NOT NULL CHECK (profile_version > 0),
        profile_digest TEXT NOT NULL CHECK (profile_digest ~ '^[0-9a-f]{64}$'),
        event_type TEXT NOT NULL CHECK (event_type IN ('SUBMIT', 'APPROVE', 'REJECT')),
        submission_id UUID REFERENCES handyman_tax_identity_approval_events (id),
        actor_user_id UUID NOT NULL REFERENCES users (id),
        evidence_source TEXT NOT NULL CHECK (char_length(btrim(evidence_source)) BETWEEN 1 AND 200
          AND evidence_source = btrim(evidence_source) AND evidence_source !~ '[[:cntrl:]]'),
        evidence_reference TEXT NOT NULL CHECK (char_length(btrim(evidence_reference)) BETWEEN 1 AND 500
          AND evidence_reference = btrim(evidence_reference) AND evidence_reference !~ '[[:cntrl:]]'),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        review_from TIMESTAMPTZ NOT NULL,
        review_to TIMESTAMPTZ,
        approved_from TIMESTAMPTZ,
        approved_to TIMESTAMPTZ,
        CONSTRAINT hm_tax_approval_event_shape CHECK (
          (event_type = 'SUBMIT' AND submission_id IS NULL AND approved_from IS NULL AND approved_to IS NULL)
          OR (event_type = 'REJECT' AND submission_id IS NOT NULL AND approved_from IS NULL AND approved_to IS NULL)
          OR (event_type = 'APPROVE' AND submission_id IS NOT NULL AND approved_from IS NOT NULL
            AND (approved_to IS NULL OR approved_to > approved_from))
        )
      );
      CREATE UNIQUE INDEX hm_tax_approval_one_submission ON handyman_tax_identity_approval_events (profile_id)
        WHERE event_type = 'SUBMIT';
      CREATE UNIQUE INDEX hm_tax_approval_one_decision ON handyman_tax_identity_approval_events (submission_id)
        WHERE event_type IN ('APPROVE', 'REJECT');
      CREATE INDEX hm_tax_approval_owner_idx ON handyman_tax_identity_approval_events (owner_kind, owner_id, profile_id);

      CREATE FUNCTION hm_tax_identity_actor_has_permission(actor UUID, permission_code TEXT) RETURNS BOOLEAN
      LANGUAGE sql STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM users u
          JOIN user_role_assignments ura ON ura.user_id=u.id AND ura.status='ACTIVE'
          JOIN roles r ON r.id=ura.role_id AND r.status='ACTIVE'
          JOIN role_permission_assignments rpa ON rpa.role_id=r.id AND rpa.status='ACTIVE'
          JOIN permissions perm ON perm.id=rpa.permission_id AND perm.status='ACTIVE'
          WHERE u.id=actor AND u.status='ACTIVE' AND perm.code=permission_code)
      $$;

      CREATE FUNCTION hm_tax_identity_approval_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Tax identity approval events are immutable history.' USING ERRCODE = '23514';
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_approval_no_mutation BEFORE UPDATE OR DELETE ON handyman_tax_identity_approval_events
        FOR EACH ROW EXECUTE FUNCTION hm_tax_identity_approval_immutable();

      CREATE FUNCTION hm_tax_identity_approval_validate() RETURNS trigger AS $$
      DECLARE
        p handyman_tax_identity_profiles%ROWTYPE;
        w handyman_tax_identity_windows%ROWTYPE;
        h handyman_tax_identity_heads%ROWTYPE;
        s handyman_tax_identity_approval_events%ROWTYPE;
        anchor_name TEXT; anchor_status TEXT; anchor_from TIMESTAMPTZ; anchor_to TIMESTAMPTZ;
        verified TIMESTAMPTZ; closed_to TIMESTAMPTZ;
      BEGIN
        SELECT * INTO p FROM handyman_tax_identity_profiles WHERE id=NEW.profile_id;
        IF p.id IS NULL OR NEW.client_id IS DISTINCT FROM p.client_id
           OR NEW.owner_kind IS DISTINCT FROM p.owner_kind OR NEW.owner_id IS DISTINCT FROM p.owner_id
           OR NEW.profile_version IS DISTINCT FROM p.version THEN
          RAISE EXCEPTION 'Approval must pin the exact Client, owner, profile and version.' USING ERRCODE = '23514';
        END IF;
        -- Same authority locks and order as 0495 profile creation/closure.
        IF p.owner_kind = 'HANDYMAN_ISSUER' THEN
          PERFORM 1 FROM clients WHERE id=p.client_id FOR UPDATE;
        ELSE
          PERFORM 1 FROM handyman_bm_legal_counterparties
            WHERE id=p.counterparty_id AND client_id=p.client_id FOR UPDATE;
        END IF;
        IF NOT FOUND THEN RAISE EXCEPTION 'Approval owner is missing.' USING ERRCODE = '23514'; END IF;
        SELECT * INTO h FROM handyman_tax_identity_heads
          WHERE owner_kind=p.owner_kind AND owner_id=p.owner_id FOR UPDATE;
        SELECT * INTO w FROM handyman_tax_identity_windows WHERE profile_id=p.id FOR UPDATE;
        IF h.latest_profile_id IS NULL OR w.profile_id IS NULL OR w.owner_kind IS DISTINCT FROM p.owner_kind
          OR w.owner_id IS DISTINCT FROM p.owner_id OR w.effective_from IS DISTINCT FROM p.effective_from THEN
          RAISE EXCEPTION 'Approval requires an intact identity head and effective window.' USING ERRCODE = '23514';
        END IF;
        SELECT effective_to INTO closed_to FROM handyman_tax_identity_closures WHERE profile_id=p.id;
        IF (FOUND AND w.effective_to IS DISTINCT FROM closed_to)
           OR (NOT FOUND AND w.effective_to IS DISTINCT FROM p.declared_effective_to) THEN
          RAISE EXCEPTION 'Approval requires the immutable effective-window projection.' USING ERRCODE = '23514';
        END IF;
        IF NEW.profile_digest IS DISTINCT FROM hm_tax_identity_payload_digest(p.id) THEN
          RAISE EXCEPTION 'Approval digest does not match the immutable profile payload.' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM user_building_assignments uba
          JOIN buildings b ON b.id=uba.building_id AND b.status='ACTIVE'
          JOIN properties pr ON pr.id=b.property_id
          WHERE uba.user_id=NEW.actor_user_id AND uba.status='ACTIVE' AND pr.client_id=p.client_id) THEN
          RAISE EXCEPTION 'Approval actor lacks exact provider Client scope.' USING ERRCODE = '23514';
        END IF;
        IF NEW.event_type='SUBMIT' THEN
          IF NOT hm_tax_identity_actor_has_permission(NEW.actor_user_id, 'handyman.finance.manage') THEN
            RAISE EXCEPTION 'Active Finance maker authority is required.' USING ERRCODE = '23514';
          END IF;
        ELSE
          IF NOT hm_tax_identity_actor_has_permission(NEW.actor_user_id, 'handyman.finance.read')
             OR NOT hm_tax_identity_actor_has_permission(NEW.actor_user_id, 'handyman.tax_identity.approve') THEN
            RAISE EXCEPTION 'Active dedicated Finance checker authority is required.' USING ERRCODE = '23514';
          END IF;
          SELECT * INTO s FROM handyman_tax_identity_approval_events WHERE id=NEW.submission_id;
          IF s.id IS NULL OR s.event_type <> 'SUBMIT' OR s.profile_id IS DISTINCT FROM p.id
             OR s.client_id IS DISTINCT FROM p.client_id OR s.owner_kind IS DISTINCT FROM p.owner_kind
             OR s.owner_id IS DISTINCT FROM p.owner_id OR s.profile_version IS DISTINCT FROM p.version
             OR s.profile_digest IS DISTINCT FROM NEW.profile_digest THEN
            RAISE EXCEPTION 'Decision must reference its exact submitted profile and digest.' USING ERRCODE = '23514';
          END IF;
          IF NEW.actor_user_id = s.actor_user_id OR NEW.actor_user_id = p.created_by_user_id THEN
            RAISE EXCEPTION 'Tax identity maker or author cannot check their own assertion.' USING ERRCODE = '23514';
          END IF;
        END IF;
        NEW.occurred_at := date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond';
        IF NEW.event_type <> 'SUBMIT' AND NEW.occurred_at <= s.occurred_at THEN
          NEW.occurred_at := s.occurred_at + interval '1 millisecond';
        END IF;
        NEW.approved_from := NULL; NEW.approved_to := NULL;

        -- REJECT can close a stale/expired submission; it grants no authority.
        IF NEW.event_type IN ('SUBMIT', 'APPROVE') THEN
          IF h.latest_profile_id IS DISTINCT FROM p.id OR h.latest_version IS DISTINCT FROM p.version THEN
            RAISE EXCEPTION 'A stale identity version cannot be submitted or approved.' USING ERRCODE = '23514';
          END IF;
          IF p.taxpayer_kind = 'UNKNOWN' OR p.pkp_status NOT IN ('PKP', 'NON_PKP')
             OR (p.taxpayer_kind='INDIVIDUAL' AND (p.individual_residency IS NULL
               OR p.individual_residency NOT IN ('RESIDENT', 'NON_RESIDENT')))
             OR p.identifier_kind IS NULL OR p.identifier_value IS NULL
             OR char_length(btrim(p.evidence_source))=0 OR char_length(btrim(p.evidence_reference))=0
             OR p.evidence_source ~ '[[:cntrl:]]' OR p.evidence_reference ~ '[[:cntrl:]]' THEN
            RAISE EXCEPTION 'Taxpayer, identifier, PKP classification and evidence must be complete.' USING ERRCODE = '23514';
          END IF;
          IF (w.effective_to IS NOT NULL AND (w.effective_to <= w.effective_from OR w.effective_to <= NEW.occurred_at)) THEN
            RAISE EXCEPTION 'The identity effective window is expired or invalid.' USING ERRCODE = '23514';
          END IF;
          IF p.owner_kind='HANDYMAN_ISSUER' THEN
            SELECT legal_name, status, effective_from, superseded_at
              INTO anchor_name, anchor_status, anchor_from, anchor_to
              FROM handyman_document_issuer_profiles WHERE id=p.issuer_profile_id AND client_id=p.client_id FOR SHARE;
            IF anchor_name IS DISTINCT FROM p.legal_name OR anchor_status IS DISTINCT FROM 'ACTIVE'
              OR anchor_to IS NOT NULL OR anchor_from IS NULL OR p.effective_from < anchor_from THEN
              RAISE EXCEPTION 'Approval requires the exact current issuer profile.' USING ERRCODE = '23514';
            END IF;
          ELSE
            SELECT cp.legal_name, v.verified_at INTO anchor_name, verified
              FROM handyman_bm_legal_counterparties cp
              JOIN handyman_bm_counterparty_verifications v ON v.counterparty_id=cp.id
              WHERE cp.id=p.counterparty_id AND cp.client_id=p.client_id AND v.id=p.verification_id;
            IF anchor_name IS DISTINCT FROM p.legal_name OR verified IS NULL OR p.effective_from < verified THEN
              RAISE EXCEPTION 'Approval requires the exact verified BM beneficiary.' USING ERRCODE = '23514';
            END IF;
          END IF;
        END IF;

        IF NEW.event_type='SUBMIT' THEN
          IF NEW.submission_id IS NOT NULL THEN
            RAISE EXCEPTION 'A submission cannot reference another submission.' USING ERRCODE = '23514';
          END IF;
          NEW.review_from := w.effective_from; NEW.review_to := w.effective_to;
        ELSE
          NEW.review_from := s.review_from; NEW.review_to := s.review_to;
          IF NEW.event_type='APPROVE' THEN
            IF w.effective_from IS DISTINCT FROM s.review_from OR w.effective_to IS DISTINCT FROM s.review_to THEN
              RAISE EXCEPTION 'The submitted effective window changed before approval.' USING ERRCODE = '23514';
            END IF;
            NEW.approved_from := GREATEST(w.effective_from, NEW.occurred_at);
            NEW.approved_to := w.effective_to;
            IF NEW.approved_to IS NOT NULL AND NEW.approved_to <= NEW.approved_from THEN
              RAISE EXCEPTION 'The approved window is expired or invalid.' USING ERRCODE = '23514';
            END IF;
            -- 0495 already excludes overlapping owner windows. Recheck pinned
            -- approval intervals as a fail-closed defense against corruption.
            IF EXISTS (SELECT 1 FROM handyman_tax_identity_approval_events a
              JOIN handyman_tax_identity_profiles ap ON ap.id=a.profile_id
              JOIN handyman_tax_identity_windows aw ON aw.profile_id=ap.id
              LEFT JOIN handyman_document_issuer_profiles ai ON ai.id=ap.issuer_profile_id
              CROSS JOIN LATERAL (SELECT LEAST(a.approved_to, aw.effective_to, ai.superseded_at) AS ends_at) bounds
              WHERE a.event_type='APPROVE' AND a.owner_kind=p.owner_kind AND a.owner_id=p.owner_id
                AND a.profile_id<>p.id
                AND (bounds.ends_at IS NULL OR a.approved_from < bounds.ends_at)
                AND (NEW.approved_to IS NULL OR a.approved_from < NEW.approved_to)
                AND (bounds.ends_at IS NULL OR NEW.approved_from < bounds.ends_at)) THEN
              RAISE EXCEPTION 'Overlapping approved tax identity periods are not permitted.' USING ERRCODE = '23514';
            END IF;
          END IF;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_approval_validate BEFORE INSERT ON handyman_tax_identity_approval_events
        FOR EACH ROW EXECUTE FUNCTION hm_tax_identity_approval_validate();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_tax_identity_approval_events) THEN
          RAISE EXCEPTION 'Refusing to remove populated tax identity approval history.';
        END IF;
      END $$;
      DROP TRIGGER hm_tax_profile_head ON handyman_tax_identity_profiles;
      DROP FUNCTION hm_tax_identity_advance_head();
      DROP TABLE handyman_tax_identity_approval_events;
      DROP FUNCTION hm_tax_identity_approval_validate();
      DROP FUNCTION hm_tax_identity_approval_immutable();
      DROP FUNCTION hm_tax_identity_actor_has_permission(UUID, TEXT);
      DROP FUNCTION hm_tax_identity_payload_digest(UUID);
      DROP TABLE handyman_tax_identity_heads;
      DROP FUNCTION hm_tax_identity_head_guard();
    `);
    // As in 0448, never silently revoke a deliberately granted capability.
  },
};
