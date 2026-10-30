import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Explicit approval and per-issuer/Jakarta-year allocation. No existing receipt
 * is updated: null number/policy identifies a pre-migration artifact. */
export const migration0532HandymanPaymentReceiptNumbering: Migration = {
  id: '0532_handyman_payment_receipt_numbering',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      ALTER TABLE handyman_document_issuer_document_settings DROP CONSTRAINT handyman_doc_settings_kind_check;
      ALTER TABLE handyman_document_issuer_document_settings ADD CONSTRAINT handyman_doc_settings_kind_check
        CHECK (document_kind IN ('QUOTATION','BAST','INVOICE','WARRANTY_CERTIFICATE','VARIATION_ORDER','PAYMENT_RECEIPT'));
      ALTER TABLE handyman_document_issuer_document_settings ADD CONSTRAINT hm_payment_receipt_settings_prefix_check
        CHECK (document_kind <> 'PAYMENT_RECEIPT' OR document_prefix = 'HM-PR');

      -- Settings are configuration, not approval. A manager's separate action
      -- accepts this exact settings version and the fixed policy below.
      CREATE TABLE handyman_payment_receipt_numbering_approvals (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        settings_id UUID NOT NULL REFERENCES handyman_document_issuer_document_settings(id),
        settings_version INTEGER NOT NULL CHECK (settings_version > 0),
        policy_code TEXT NOT NULL CHECK (policy_code = 'HM_PR_ISSUER_YEAR_V1'),
        approved_by_user_id UUID NOT NULL REFERENCES users(id),
        approved_session_id UUID NOT NULL REFERENCES user_sessions(id),
        approved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        status TEXT NOT NULL CHECK (status IN ('ACTIVE','SUPERSEDED')),
        superseded_at TIMESTAMPTZ,
        CHECK ((status = 'ACTIVE' AND superseded_at IS NULL)
          OR (status = 'SUPERSEDED' AND superseded_at IS NOT NULL))
      );
      CREATE UNIQUE INDEX hm_pr_one_active_approval_per_client
        ON handyman_payment_receipt_numbering_approvals(client_id) WHERE status = 'ACTIVE';
      CREATE FUNCTION hm_pr_approval_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status <> 'ACTIVE' OR NEW.superseded_at IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM handyman_document_issuer_document_settings s
          WHERE s.id = NEW.settings_id AND s.client_id = NEW.client_id AND s.status = 'ACTIVE'
            AND s.document_kind = 'PAYMENT_RECEIPT' AND s.document_prefix = 'HM-PR'
            AND s.version = NEW.settings_version
        ) OR NOT EXISTS (
          SELECT 1 FROM users u
          JOIN user_sessions session ON session.user_id = u.id AND session.id = NEW.approved_session_id
            AND session.status = 'ACTIVE' AND session.expires_at > clock_timestamp()
          JOIN user_role_assignments ura ON ura.user_id = u.id AND ura.status = 'ACTIVE'
          JOIN roles r ON r.id = ura.role_id AND r.status = 'ACTIVE'
          JOIN role_permission_assignments rpa ON rpa.role_id = r.id AND rpa.status = 'ACTIVE'
          JOIN permissions p ON p.id = rpa.permission_id AND p.status = 'ACTIVE'
            AND p.code = 'handyman.commercial.manage'
          JOIN user_building_assignments uba ON uba.user_id = u.id AND uba.status = 'ACTIVE'
          JOIN buildings b ON b.id = uba.building_id AND b.status = 'ACTIVE'
          JOIN properties prop ON prop.id = b.property_id AND prop.status = 'ACTIVE'
          JOIN clients c ON c.id = prop.client_id AND c.status = 'ACTIVE'
          WHERE u.id = NEW.approved_by_user_id AND u.status = 'ACTIVE' AND c.id = NEW.client_id
        ) THEN
          RAISE EXCEPTION 'Numbering approval requires the exact active settings and an authorized, scoped manager session.' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER hm_pr_approval_insert BEFORE INSERT ON handyman_payment_receipt_numbering_approvals
        FOR EACH ROW EXECUTE FUNCTION hm_pr_approval_insert_guard();
      CREATE FUNCTION hm_pr_approval_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE' AND OLD.status = 'ACTIVE' AND NEW.status = 'SUPERSEDED'
           AND NEW.superseded_at IS NOT NULL
           AND (to_jsonb(NEW) - 'status' - 'superseded_at') = (to_jsonb(OLD) - 'status' - 'superseded_at') THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'Payment Receipt numbering approvals are immutable history.' USING ERRCODE = '23514';
      END $$;
      CREATE TRIGGER hm_pr_approval_no_mutation BEFORE UPDATE OR DELETE ON handyman_payment_receipt_numbering_approvals
        FOR EACH ROW EXECUTE FUNCTION hm_pr_approval_immutable();
      CREATE TRIGGER hm_pr_approval_no_truncate BEFORE TRUNCATE ON handyman_payment_receipt_numbering_approvals
        FOR EACH STATEMENT EXECUTE FUNCTION hm_pr_approval_immutable();

      CREATE FUNCTION hm_pr_calendar_year(issued TIMESTAMPTZ) RETURNS INTEGER
        LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
          SELECT EXTRACT(YEAR FROM issued AT TIME ZONE 'Asia/Jakarta')::integer
        $$;
      CREATE TABLE handyman_payment_receipt_number_counters (
        client_id UUID NOT NULL REFERENCES clients(id),
        calendar_year INTEGER NOT NULL CHECK (calendar_year BETWEEN 1 AND 9999),
        last_value INTEGER NOT NULL CHECK (last_value BETWEEN 1 AND 999999),
        PRIMARY KEY (client_id, calendar_year)
      );
      CREATE FUNCTION hm_pr_counter_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.last_value = 1 THEN RETURN NEW; END IF;
        IF TG_OP = 'UPDATE' AND NEW.client_id = OLD.client_id AND NEW.calendar_year = OLD.calendar_year
          AND NEW.last_value = OLD.last_value + 1 THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'Payment Receipt numbering counters only advance one step and cannot be removed.' USING ERRCODE = '23514';
      END $$;
      CREATE TRIGGER hm_pr_counter_write BEFORE INSERT OR UPDATE OR DELETE ON handyman_payment_receipt_number_counters
        FOR EACH ROW EXECUTE FUNCTION hm_pr_counter_guard();
      CREATE TRIGGER hm_pr_counter_no_truncate BEFORE TRUNCATE ON handyman_payment_receipt_number_counters
        FOR EACH STATEMENT EXECUTE FUNCTION hm_pr_counter_guard();

      ALTER TABLE handyman_tenant_payment_receipts
        ADD COLUMN document_number TEXT,
        ADD COLUMN numbering_approval_id UUID REFERENCES handyman_payment_receipt_numbering_approvals(id),
        ADD CONSTRAINT hm_tenant_receipt_number_binding CHECK ((
          (document_number IS NULL AND numbering_approval_id IS NULL)
          OR (document_number IS NOT NULL AND numbering_approval_id IS NOT NULL
            AND document_number ~ '^HM-PR-[0-9]{4}-[0-9]{6}$'
            AND substring(document_number, 7, 4) = to_char(issued_at AT TIME ZONE 'Asia/Jakarta', 'YYYY')
            AND substring(document_number, 12, 6) <> '000000'
            AND source_snapshot#>>'{issuance,number}' = document_number
            AND source_snapshot#>>'{numberingPolicy,approvalId}' = numbering_approval_id::text)
        ) IS TRUE);
      CREATE UNIQUE INDEX hm_tenant_receipt_number_per_issuer
        ON handyman_tenant_payment_receipts(client_id, document_number) WHERE document_number IS NOT NULL;
      CREATE FUNCTION hm_pr_receipt_number_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE yr INTEGER; seq INTEGER;
      BEGIN
        IF NEW.document_number IS NULL OR NEW.numbering_approval_id IS NULL
          OR NEW.document_number !~ '^HM-PR-[0-9]{4}-[0-9]{6}$' THEN
          RAISE EXCEPTION 'New Payment Receipts require an approved allocated number.' USING ERRCODE = '23514';
        END IF;
        yr := hm_pr_calendar_year(NEW.issued_at);
        seq := substring(NEW.document_number, 12, 6)::integer;
        IF substring(NEW.document_number, 7, 4) <> lpad(yr::text, 4, '0') OR seq < 1 OR NOT EXISTS (
          SELECT 1 FROM handyman_payment_receipt_number_counters c
          WHERE c.client_id = NEW.client_id AND c.calendar_year = yr AND c.last_value = seq
        ) OR NOT EXISTS (
          SELECT 1 FROM handyman_payment_receipt_numbering_approvals a
          JOIN handyman_document_issuer_document_settings s ON s.id = a.settings_id
          WHERE a.id = NEW.numbering_approval_id AND a.client_id = NEW.client_id AND a.status = 'ACTIVE'
            AND s.client_id = a.client_id AND s.status = 'ACTIVE' AND s.document_kind = 'PAYMENT_RECEIPT'
            AND s.document_prefix = 'HM-PR' AND s.version = a.settings_version
            AND NEW.source_snapshot#>>'{numberingPolicy,approvalId}' = a.id::text
            AND NEW.source_snapshot#>>'{numberingPolicy,settingsId}' = s.id::text
            AND NEW.source_snapshot#>>'{numberingPolicy,settingsVersion}' = s.version::text
            AND NEW.source_snapshot#>>'{numberingPolicy,language}' = s.language
            AND NEW.source_snapshot#>>'{numberingPolicy,policyCode}' = a.policy_code
            AND NEW.source_snapshot#>>'{numberingPolicy,format}' = 'HM-PR-{YYYY}-{SEQ:06}'
            AND NEW.source_snapshot#>>'{numberingPolicy,timeZone}' = 'Asia/Jakarta'
            AND NEW.source_snapshot#>>'{numberingPolicy,scope}' = 'ISSUER_CLIENT_CALENDAR_YEAR'
            AND NEW.source_snapshot#>>'{numberingPolicy,calendarYear}' = yr::text
            AND NEW.source_snapshot#>>'{issuance,number}' = NEW.document_number
        ) THEN
          RAISE EXCEPTION 'Payment Receipt number, policy, issuer, year or allocation does not match.' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER hm_pr_receipt_number_insert BEFORE INSERT ON handyman_tenant_payment_receipts
        FOR EACH ROW EXECUTE FUNCTION hm_pr_receipt_number_insert_guard();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      LOCK TABLE handyman_tenant_payment_receipts, handyman_payment_receipt_numbering_approvals,
        handyman_payment_receipt_number_counters, handyman_document_issuer_document_settings IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_tenant_payment_receipts WHERE document_number IS NOT NULL)
          OR EXISTS (SELECT 1 FROM handyman_payment_receipt_numbering_approvals)
          OR EXISTS (SELECT 1 FROM handyman_payment_receipt_number_counters)
          OR EXISTS (SELECT 1 FROM handyman_document_issuer_document_settings WHERE document_kind = 'PAYMENT_RECEIPT') THEN
          RAISE EXCEPTION 'Refusing to discard Payment Receipt numbering or approval history.';
        END IF;
      END $$;
      DROP TRIGGER hm_pr_receipt_number_insert ON handyman_tenant_payment_receipts;
      DROP FUNCTION hm_pr_receipt_number_insert_guard();
      DROP INDEX hm_tenant_receipt_number_per_issuer;
      ALTER TABLE handyman_tenant_payment_receipts DROP CONSTRAINT hm_tenant_receipt_number_binding,
        DROP COLUMN numbering_approval_id, DROP COLUMN document_number;
      DROP TABLE handyman_payment_receipt_number_counters;
      DROP FUNCTION hm_pr_counter_guard();
      DROP FUNCTION hm_pr_calendar_year(TIMESTAMPTZ);
      DROP TABLE handyman_payment_receipt_numbering_approvals;
      DROP FUNCTION hm_pr_approval_insert_guard();
      DROP FUNCTION hm_pr_approval_immutable();
      ALTER TABLE handyman_document_issuer_document_settings DROP CONSTRAINT hm_payment_receipt_settings_prefix_check;
      ALTER TABLE handyman_document_issuer_document_settings DROP CONSTRAINT handyman_doc_settings_kind_check;
      ALTER TABLE handyman_document_issuer_document_settings ADD CONSTRAINT handyman_doc_settings_kind_check
        CHECK (document_kind IN ('QUOTATION','BAST','INVOICE','WARRANTY_CERTIFICATE','VARIATION_ORDER'));
    `);
  },
};
