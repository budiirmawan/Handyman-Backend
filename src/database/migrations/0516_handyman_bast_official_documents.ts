import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** A new ISSUE and its official, byte-backed PDF are one indivisible fact.
 * This migration deliberately creates no artifacts for historical BASTs. */
export const migration0516HandymanBastOfficialDocuments: Migration = {
  id: '0516_handyman_bast_official_documents',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE SEQUENCE handyman_bast_official_document_number_seq;
      CREATE TABLE handyman_bast_official_documents (
        id UUID PRIMARY KEY,
        bast_id UUID NOT NULL UNIQUE REFERENCES handyman_bast_documents(id),
        issue_event_id UUID NOT NULL UNIQUE REFERENCES handyman_bast_events(id),
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        request_id UUID NOT NULL REFERENCES handyman_service_requests(id),
        execution_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes(id),
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies(id),
        completion_verification_id UUID NOT NULL REFERENCES handyman_completion_verifications(id),
        manifest_id UUID NOT NULL REFERENCES handyman_completion_manifests(id),
        manifest_version INTEGER NOT NULL CHECK (manifest_version > 0),
        manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
        qc_run_id UUID NOT NULL REFERENCES handyman_qc_runs(id),
        qc_run_version INTEGER NOT NULL CHECK (qc_run_version > 0),
        qc_finish_event_id UUID NOT NULL REFERENCES handyman_qc_run_events(id),
        issuer_profile_id UUID NOT NULL REFERENCES handyman_document_issuer_profiles(id),
        settings_id UUID NOT NULL REFERENCES handyman_document_issuer_document_settings(id),
        document_number TEXT NOT NULL UNIQUE CHECK (length(document_number) BETWEEN 1 AND 150),
        issued_by_user_id UUID NOT NULL REFERENCES users(id),
        issued_at TIMESTAMPTZ NOT NULL,
        source_snapshot JSONB NOT NULL,
        source_canonical TEXT NOT NULL,
        source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
        pdf_filename TEXT NOT NULL CHECK (pdf_filename ~ '^[A-Za-z0-9._-]+[.]pdf$'),
        pdf_bytes BYTEA NOT NULL,
        pdf_size INTEGER NOT NULL CHECK (pdf_size > 0 AND pdf_size <= 33554432),
        pdf_sha256 TEXT NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
        CHECK (source_snapshot = source_canonical::jsonb),
        CHECK (encode(sha256(convert_to(source_canonical, 'UTF8')), 'hex') = source_sha256),
        CHECK (octet_length(pdf_bytes) = pdf_size),
        CHECK (substring(pdf_bytes from 1 for 5) = convert_to('%PDF-', 'UTF8')),
        CHECK (encode(sha256(pdf_bytes), 'hex') = pdf_sha256)
      );
      CREATE INDEX hm_bast_official_request ON handyman_bast_official_documents(request_id,bast_id);
      CREATE FUNCTION hm_bast_official_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='TRUNCATE' AND NOT EXISTS (SELECT 1 FROM handyman_bast_official_documents) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Official BAST artifacts are immutable.' USING ERRCODE='23514';
      END; $$;
      CREATE TRIGGER hm_bast_official_no_write BEFORE UPDATE OR DELETE ON handyman_bast_official_documents
        FOR EACH ROW EXECUTE FUNCTION hm_bast_official_immutable();
      CREATE TRIGGER hm_bast_official_no_truncate BEFORE TRUNCATE ON handyman_bast_official_documents
        FOR EACH STATEMENT EXECUTE FUNCTION hm_bast_official_immutable();

      -- Artifacts can only originate alongside the actual new ISSUE and its
      -- event, never be reconstructed for an older BAST. Every principal and
      -- review binding is independently checked against authoritative rows.
      CREATE FUNCTION hm_bast_official_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM handyman_bast_documents b
          JOIN handyman_bast_events e ON e.id=NEW.issue_event_id AND e.bast_id=b.id
            AND e.event_type='ISSUE' AND e.client_id=b.client_id AND e.execution_scope_id=b.execution_scope_id
            AND e.actor_user_id=NEW.issued_by_user_id AND e.occurred_at=b.issued_at
          JOIN handyman_execution_scopes s ON s.id=b.execution_scope_id AND s.client_id=b.client_id
          JOIN handyman_service_requests r ON r.id=s.handyman_request_id AND r.client_id=s.client_id
            AND r.building_id=s.building_id AND r.tenant_company_id=s.tenant_company_id
          JOIN handyman_completion_verifications v ON v.id=b.completion_verification_id
            AND v.execution_scope_id=s.id AND v.qc_run_id=b.qc_run_id
          JOIN handyman_completion_manifests m ON m.id=v.manifest_id AND m.execution_scope_id=s.id
            AND m.version=v.manifest_version AND m.source_sha256=v.manifest_sha256
          JOIN handyman_qc_runs q ON q.id=v.qc_run_id AND q.execution_scope_id=s.id
            AND q.status='PASSED' AND q.version=v.qc_run_version
          JOIN handyman_qc_run_events f ON f.id=v.qc_finish_event_id AND f.run_id=q.id
            AND f.event_type='FINISH' AND f.metadata->>'outcome'='PASSED'
          JOIN handyman_document_issuer_profiles i ON i.id=NEW.issuer_profile_id AND i.client_id=s.client_id AND i.status='ACTIVE'
          JOIN handyman_document_issuer_document_settings d ON d.id=NEW.settings_id AND d.client_id=s.client_id
            AND d.status='ACTIVE' AND d.document_kind='BAST'
          WHERE b.id=NEW.bast_id AND b.status='ISSUED' AND b.issued_at=NEW.issued_at
            AND b.issued_at=transaction_timestamp()
            AND b.xmin=(pg_current_xact_id()::text)::xid AND e.xmin=(pg_current_xact_id()::text)::xid
            AND NEW.client_id=s.client_id AND NEW.building_id=s.building_id
            AND NEW.request_id=r.id AND NEW.tenant_company_id=s.tenant_company_id
            AND NEW.execution_scope_id=s.id AND NEW.completion_verification_id=v.id
            AND NEW.manifest_id=m.id AND NEW.manifest_version=m.version AND NEW.manifest_sha256=m.source_sha256
            AND NEW.qc_run_id=q.id AND NEW.qc_run_version=q.version AND NEW.qc_finish_event_id=f.id
            AND NEW.source_snapshot->>'schema'='HANDYMAN_BAST_OFFICIAL_V1'
            AND NEW.source_snapshot->>'status'='ISSUED'
            AND NEW.source_snapshot#>>'{issuance,id}'=NEW.id::text
            AND NEW.source_snapshot#>>'{issuance,number}'=NEW.document_number
            AND NEW.source_snapshot#>>'{issuance,bastId}'=b.id::text
            AND NEW.source_snapshot#>>'{issuance,eventId}'=e.id::text
            AND NEW.source_snapshot#>>'{issuance,actorUserId}'=NEW.issued_by_user_id::text
            AND (NEW.source_snapshot#>>'{issuance,issuedAt}')::timestamptz=date_trunc('milliseconds', b.issued_at)
            AND NEW.source_snapshot#>>'{customer,requestId}'=r.id::text
            AND NEW.source_snapshot#>>'{customer,clientId}'=s.client_id::text
            AND NEW.source_snapshot#>>'{customer,buildingId}'=s.building_id::text
            AND NEW.source_snapshot#>>'{customer,tenantCompanyId}'=s.tenant_company_id::text
            AND (NEW.source_snapshot#>>'{customer,spaceId}')::uuid IS NOT DISTINCT FROM r.space_id
            AND NEW.source_snapshot->>'executionScopeId'=s.id::text
            AND NEW.source_snapshot#>>'{approvedQuotation,id}'=s.quotation_id::text
            AND NEW.source_snapshot#>>'{approvedQuotation,versionId}'=s.approved_quotation_version_id::text
            AND NEW.source_snapshot#>>'{approvedQuotation,decisionId}'=s.quotation_decision_id::text
            AND NEW.source_snapshot#>>'{manifest,id}'=m.id::text
            AND (NEW.source_snapshot#>>'{manifest,version}')::integer=m.version
            AND NEW.source_snapshot#>>'{manifest,sha256}'=m.source_sha256
            AND NEW.source_snapshot#>'{manifest,snapshot}'=m.source_snapshot
            AND NEW.source_snapshot#>>'{verification,id}'=v.id::text
            AND NEW.source_snapshot#>>'{verification,verifiedByUserId}'=v.verified_by_user_id::text
            AND NEW.source_snapshot#>>'{verification,qcFinishedByUserId}'=f.actor_user_id::text
            AND NEW.source_snapshot#>>'{verification,qcRunId}'=q.id::text
            AND (NEW.source_snapshot#>>'{verification,qcRunVersion}')::integer=q.version
            AND NEW.source_snapshot#>>'{verification,qcFinishEventId}'=f.id::text
            AND NEW.source_snapshot#>>'{issuer,profileId}'=i.id::text
            AND (NEW.source_snapshot#>>'{issuer,version}')::integer=i.version
            AND NEW.source_snapshot#>>'{settings,settingsId}'=d.id::text
            AND (NEW.source_snapshot#>>'{settings,version}')::integer=d.version
            AND NEW.source_snapshot#>>'{settings,language}'=d.language
            AND NEW.source_snapshot#>>'{settings,documentPrefix}'=d.document_prefix
            AND NEW.document_number LIKE d.document_prefix || '-%'
            AND NOT EXISTS (SELECT 1 FROM handyman_bast_events earlier WHERE earlier.bast_id=b.id
              AND earlier.event_type='ISSUE' AND earlier.id<>e.id)
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(m.source_snapshot->'items') item
              WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.source_snapshot->'units') unit
                JOIN units_of_measure u ON u.id::text=unit->>'id' AND u.client_id=s.client_id
                WHERE unit->>'id'=item->>'uomId' AND unit->>'name'=u.name
                  AND unit->>'code'=u.code AND unit->>'symbol'=u.symbol)
            )
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(m.source_snapshot->'items') item,
                LATERAL jsonb_array_elements(item->'execution') proof
              WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.source_snapshot->'evidence') ev
                JOIN handyman_field_evidence_uploads u ON u.id::text=ev->>'id'
                WHERE ev->>'kind'='EXECUTION' AND ev->>'id'=proof->>'evidenceId'
                  AND ev->>'reference'=proof->>'evidenceReference' AND ev->>'sha256'=proof->>'evidenceSha256'
                  AND u.client_id=s.client_id AND u.building_id=s.building_id AND u.handyman_request_id=r.id
                  AND u.tenant_company_id=s.tenant_company_id AND u.execution_scope_id=s.id
                  AND u.upload_status='VERIFIED' AND u.purpose='BEFORE_AFTER_WORK'
                  AND u.attachment_reference=ev->>'reference' AND u.sha256_checksum=ev->>'sha256')
            )
            AND NOT EXISTS (
              SELECT 1 FROM handyman_qc_run_evidence qe WHERE qe.run_id=q.id
              AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.source_snapshot->'evidence') ev
                JOIN handyman_field_evidence_uploads u ON u.id::text=ev->>'id'
                WHERE ev->>'kind'='QC' AND u.id=qe.evidence_upload_id AND u.client_id=s.client_id
                  AND u.building_id=s.building_id AND u.handyman_request_id=r.id AND u.tenant_company_id=s.tenant_company_id
                  AND u.execution_scope_id=s.id AND u.upload_status='VERIFIED' AND u.purpose='QC_EVIDENCE'
                  AND u.attachment_reference=ev->>'reference' AND u.sha256_checksum=ev->>'sha256')
            )
        ) THEN RAISE EXCEPTION 'Official BAST requires the exact new ISSUE, reviewed manifest and QC PASS.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_bast_official_insert_guard BEFORE INSERT ON handyman_bast_official_documents
        FOR EACH ROW EXECUTE FUNCTION hm_bast_official_insert_guard();

      -- Applies only to future new transitions; old issued rows stay untouched.
      CREATE FUNCTION hm_bast_official_issue_required() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status='ISSUED' AND OLD.status IS DISTINCT FROM 'ISSUED' AND NOT EXISTS (
          SELECT 1 FROM handyman_bast_official_documents d WHERE d.bast_id=NEW.id
            AND d.completion_verification_id=NEW.completion_verification_id
        ) THEN RAISE EXCEPTION 'New BAST ISSUE requires an atomic official PDF.' USING ERRCODE='23514'; END IF;
        RETURN NULL;
      END; $$;
      CREATE CONSTRAINT TRIGGER hm_bast_official_issue_required AFTER UPDATE ON handyman_bast_documents
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hm_bast_official_issue_required();
      -- Keep historical issue timestamps intact and require an actual new
      -- DRAFT-to-ISSUED transition, not a touched legacy row, for artifacts.
      CREATE FUNCTION hm_bast_official_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.issued_at IS NOT NULL AND NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
          RAISE EXCEPTION 'BAST ISSUE timestamp is immutable.' USING ERRCODE='23514'; END IF;
        IF NEW.status='ISSUED' AND OLD.status IS DISTINCT FROM 'ISSUED' AND
          (OLD.status<>'DRAFT' OR OLD.issued_at IS NOT NULL OR NEW.issued_at IS DISTINCT FROM transaction_timestamp()) THEN
          RAISE EXCEPTION 'A new BAST ISSUE must originate from its DRAFT in this transaction.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_bast_official_transition_guard BEFORE UPDATE ON handyman_bast_documents
        FOR EACH ROW EXECUTE FUNCTION hm_bast_official_transition_guard();
      CREATE FUNCTION hm_bast_new_draft_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status<>'DRAFT' OR NEW.issued_at IS NOT NULL THEN
          RAISE EXCEPTION 'New BAST must begin as DRAFT.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_bast_new_draft_only BEFORE INSERT ON handyman_bast_documents
        FOR EACH ROW EXECUTE FUNCTION hm_bast_new_draft_only();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      LOCK TABLE handyman_bast_official_documents IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM handyman_bast_official_documents) THEN
        RAISE EXCEPTION 'Cannot discard official BAST artifacts.'; END IF; END; $$;
      DROP TRIGGER hm_bast_new_draft_only ON handyman_bast_documents;
      DROP TRIGGER hm_bast_official_transition_guard ON handyman_bast_documents;
      DROP FUNCTION hm_bast_official_transition_guard();
      DROP FUNCTION hm_bast_new_draft_only();
      DROP TRIGGER hm_bast_official_issue_required ON handyman_bast_documents;
      DROP FUNCTION hm_bast_official_issue_required();
      DROP TABLE handyman_bast_official_documents;
      DROP FUNCTION hm_bast_official_insert_guard();
      DROP FUNCTION hm_bast_official_immutable();
      DROP SEQUENCE handyman_bast_official_document_number_seq;
    `);
  },
};
