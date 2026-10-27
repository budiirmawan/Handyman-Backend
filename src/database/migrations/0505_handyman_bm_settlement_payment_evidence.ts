import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Manual evidence only: no payment execution, tax remittance, or mutation of earlier facts. */
export const migration0505HandymanBmSettlementPaymentEvidence:Migration={
  id:'0505_handyman_bm_settlement_payment_evidence',
  async up(tx:PoolClient):Promise<void>{
    for(const [code,name] of [
      ['handyman.bm_settlement.approve','Approve BM settlement authorization'],
      ['handyman.bm_settlement.verify_payment','Verify BM settlement payment evidence'],
    ]) await tx.query(`INSERT INTO permissions(id,code,name,status) VALUES($1,$2,$3,'ACTIVE') ON CONFLICT(code) DO NOTHING`,[randomUUID(),code,name]);
    await tx.query(`
      CREATE TABLE handyman_bm_settlements (
        id UUID PRIMARY KEY, client_id UUID NOT NULL REFERENCES clients(id), building_id UUID NOT NULL REFERENCES buildings(id),
        counterparty_id UUID NOT NULL REFERENCES handyman_bm_legal_counterparties(id),
        entitlement_id UUID NOT NULL UNIQUE REFERENCES handyman_entitlement_facts(id),
        agreement_version_id UUID NOT NULL REFERENCES handyman_commercial_agreement_versions(id),
        original_entry_id UUID NOT NULL REFERENCES handyman_bm_commission_ledger(id),
        latest_entry_id UUID NOT NULL REFERENCES handyman_bm_commission_ledger(id),
        bank_version_id UUID NOT NULL REFERENCES handyman_bm_bank_account_versions(id),
        bank_decision_id UUID NOT NULL REFERENCES handyman_bm_bank_account_decisions(id),
        currency TEXT NOT NULL CHECK(currency='IDR'), net_payable NUMERIC(18,2) NOT NULL CHECK(net_payable>0),
        snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'), digest TEXT NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
        idempotency_key TEXT NOT NULL CHECK(char_length(btrim(idempotency_key)) BETWEEN 1 AND 200 AND idempotency_key=btrim(idempotency_key)),
        evidence_reference TEXT NOT NULL CHECK(char_length(btrim(evidence_reference)) BETWEEN 3 AND 500 AND evidence_reference=btrim(evidence_reference)),
        created_by_user_id UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE(client_id,idempotency_key)
      );
      CREATE TABLE handyman_bm_settlement_approvals (
        id UUID PRIMARY KEY, settlement_id UUID NOT NULL UNIQUE REFERENCES handyman_bm_settlements(id),
        settlement_digest TEXT NOT NULL CHECK(settlement_digest ~ '^[0-9a-f]{64}$'),
        evidence_reference TEXT NOT NULL CHECK(char_length(btrim(evidence_reference)) BETWEEN 3 AND 500 AND evidence_reference=btrim(evidence_reference)),
        actor_user_id UUID NOT NULL REFERENCES users(id), occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE handyman_bm_settlement_payments (
        id UUID PRIMARY KEY, settlement_id UUID NOT NULL UNIQUE REFERENCES handyman_bm_settlements(id),
        client_id UUID NOT NULL REFERENCES clients(id), approval_id UUID NOT NULL REFERENCES handyman_bm_settlement_approvals(id),
        transfer_reference TEXT NOT NULL CHECK(char_length(btrim(transfer_reference)) BETWEEN 3 AND 200 AND transfer_reference=btrim(transfer_reference)),
        amount NUMERIC(18,2) NOT NULL CHECK(amount>0), currency TEXT NOT NULL CHECK(currency='IDR'),
        transferred_at TIMESTAMPTZ NOT NULL, evidence_id UUID NOT NULL UNIQUE,
        storage_key TEXT NOT NULL UNIQUE CHECK(storage_key='evidence/' || evidence_id::text),
        content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
        file_size INTEGER NOT NULL CHECK(file_size BETWEEN 1 AND 10485760),
        mime_type TEXT NOT NULL CHECK(mime_type IN ('application/pdf','image/jpeg','image/png','image/webp')),
        idempotency_key TEXT NOT NULL CHECK(char_length(btrim(idempotency_key)) BETWEEN 1 AND 200 AND idempotency_key=btrim(idempotency_key)),
        recorded_by_user_id UUID NOT NULL REFERENCES users(id), occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE(client_id,idempotency_key)
      );
      CREATE UNIQUE INDEX hm_bm_payment_transfer_reference_unique ON handyman_bm_settlement_payments(client_id,upper(transfer_reference));
      CREATE TABLE handyman_bm_settlement_evidence_reads (
        id UUID PRIMARY KEY, payment_id UUID NOT NULL REFERENCES handyman_bm_settlement_payments(id),
        actor_user_id UUID NOT NULL REFERENCES users(id), content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE handyman_bm_settlement_verifications (
        id UUID PRIMARY KEY, settlement_id UUID NOT NULL UNIQUE REFERENCES handyman_bm_settlements(id),
        payment_id UUID NOT NULL UNIQUE REFERENCES handyman_bm_settlement_payments(id),
        evidence_read_id UUID NOT NULL REFERENCES handyman_bm_settlement_evidence_reads(id),
        content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
        evidence_reference TEXT NOT NULL CHECK(char_length(btrim(evidence_reference)) BETWEEN 3 AND 500 AND evidence_reference=btrim(evidence_reference)),
        method TEXT NOT NULL CHECK(method='FINANCE_MANUAL_DOCUMENT_REVIEW'),
        actor_user_id UUID NOT NULL REFERENCES users(id), occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      CREATE FUNCTION hm_bm_settlement_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'BM settlement and payment evidence history is immutable.' USING ERRCODE='23514'; END $$;
      CREATE TRIGGER hm_bm_settlement_immutable BEFORE UPDATE OR DELETE ON handyman_bm_settlements FOR EACH ROW EXECUTE FUNCTION hm_bm_settlement_immutable();
      CREATE TRIGGER hm_bm_settlement_approval_immutable BEFORE UPDATE OR DELETE ON handyman_bm_settlement_approvals FOR EACH ROW EXECUTE FUNCTION hm_bm_settlement_immutable();
      CREATE TRIGGER hm_bm_settlement_payment_immutable BEFORE UPDATE OR DELETE ON handyman_bm_settlement_payments FOR EACH ROW EXECUTE FUNCTION hm_bm_settlement_immutable();
      CREATE TRIGGER hm_bm_settlement_evidence_read_immutable BEFORE UPDATE OR DELETE ON handyman_bm_settlement_evidence_reads FOR EACH ROW EXECUTE FUNCTION hm_bm_settlement_immutable();
      CREATE TRIGGER hm_bm_settlement_verification_immutable BEFORE UPDATE OR DELETE ON handyman_bm_settlement_verifications FOR EACH ROW EXECUTE FUNCTION hm_bm_settlement_immutable();

      -- All writers share the 0503 scope -> customer transaction fence and
      -- then the 0504 beneficiary fence. This also protects legacy 0418 claims.
      CREATE FUNCTION hm_bm_settlement_lock(s handyman_bm_settlements) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE tax_source JSONB;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN
          RAISE EXCEPTION 'BM settlement writes require READ COMMITTED.' USING ERRCODE='23514'; END IF;
        PERFORM 1 FROM handyman_execution_scopes x JOIN handyman_entitlement_facts f ON f.execution_scope_id=x.id
          WHERE f.id=s.entitlement_id AND f.client_id=s.client_id FOR UPDATE OF x;
        PERFORM 1 FROM handyman_customer_transactions t JOIN handyman_entitlement_facts f ON f.transaction_id=t.id
          WHERE f.id=s.entitlement_id FOR UPDATE OF t;
        PERFORM 1 FROM handyman_bm_legal_counterparties WHERE id=s.counterparty_id AND client_id=s.client_id FOR UPDATE;
        SELECT COALESCE(cc.snapshot,c.snapshot) INTO tax_source FROM handyman_bm_commission_ledger l
          LEFT JOIN handyman_bm_tax_cases c ON c.id=l.original_case_id
          LEFT JOIN handyman_bm_correction_tax_cases cc ON cc.id=l.correction_case_id WHERE l.id=s.latest_entry_id;
        PERFORM profile_id FROM handyman_tax_identity_windows WHERE profile_id=ANY(ARRAY[
          (tax_source->>'ppnBeneficiaryProfileId')::uuid,(tax_source->>'ppnIssuerProfileId')::uuid,(tax_source->>'pphBeneficiaryProfileId')::uuid])
          ORDER BY profile_id FOR SHARE;
        PERFORM i.id FROM handyman_document_issuer_profiles i JOIN handyman_tax_identity_profiles p ON p.issuer_profile_id=i.id
          WHERE p.id=(tax_source->>'ppnIssuerProfileId')::uuid FOR SHARE OF i;
        PERFORM rule_id FROM handyman_tax_rule_windows WHERE rule_id=ANY(ARRAY[(tax_source->>'ppnRuleId')::uuid,(tax_source->>'pphRuleId')::uuid])
          ORDER BY rule_id FOR SHARE;
        PERFORM c.id FROM handyman_bm_building_coverages c JOIN handyman_commercial_agreement_versions v ON v.id=c.agreement_version_id
          WHERE c.id=(tax_source->>'coverageId')::uuid AND v.id=(tax_source->>'agreementVersionId')::uuid FOR SHARE OF c,v;
      END $$;
      CREATE FUNCTION hm_bm_settlement_anchors_valid(s handyman_bm_settlements, current_bank BOOLEAN) RETURNS BOOLEAN LANGUAGE sql VOLATILE AS $$
        SELECT EXISTS(SELECT 1 FROM handyman_entitlement_facts f
          JOIN handyman_execution_scopes x ON x.id=f.execution_scope_id AND x.client_id=f.client_id AND x.building_id=s.building_id
          JOIN handyman_customer_transactions t ON t.id=f.transaction_id AND t.client_id=f.client_id
          JOIN handyman_bm_commission_ledger first ON first.id=s.original_entry_id AND first.entitlement_id=f.id AND first.sequence=1
          JOIN handyman_bm_commission_ledger last ON last.id=s.latest_entry_id AND last.entitlement_id=f.id
          JOIN handyman_bm_bank_account_versions b ON b.id=s.bank_version_id AND b.client_id=s.client_id AND b.counterparty_id=s.counterparty_id
          JOIN handyman_bm_bank_account_decisions bd ON bd.id=s.bank_decision_id AND bd.proposal_id=b.id AND bd.decision='APPROVE'
          WHERE f.id=s.entitlement_id AND f.client_id=s.client_id AND f.entitlement_kind='BM_FEE' AND f.fact_state='EARNED'
            AND f.agreement_version_id=s.agreement_version_id AND f.currency=s.currency AND t.currency=s.currency
            AND first.client_id=s.client_id AND first.building_id=s.building_id AND first.counterparty_id=s.counterparty_id
            AND last.client_id=s.client_id AND last.building_id=s.building_id AND last.counterparty_id=s.counterparty_id
            AND last.net_payable=s.net_payable AND last.net_payable>0 AND first.currency=s.currency AND last.currency=s.currency
            AND first.digest=hm_bm_correction_tax_digest(first.snapshot) AND last.digest=hm_bm_correction_tax_digest(last.snapshot)
            AND b.currency=s.currency AND b.proposed_status='ACTIVE'
            AND (NOT current_bank OR NOT EXISTS(SELECT 1 FROM handyman_bm_bank_account_versions newer
              JOIN handyman_bm_bank_account_decisions nd ON nd.proposal_id=newer.id AND nd.decision='APPROVE'
              WHERE newer.bank_account_id=b.bank_account_id AND newer.version>b.version))
            AND (SELECT count(*) FROM handyman_bm_commission_ledger l WHERE l.entitlement_id=f.id)=last.sequence
            AND NOT EXISTS(SELECT 1 FROM handyman_bm_commission_ledger l WHERE l.entitlement_id=f.id AND l.sequence>last.sequence)
            AND ((last.sequence=1 AND last.id=first.id) OR (last.sequence=2 AND last.previous_entry_id=first.id))
            AND NOT EXISTS(SELECT 1 FROM handyman_settlement_inclusions old WHERE old.entitlement_id=f.id)
            AND NOT EXISTS(SELECT 1 FROM handyman_customer_payments pending WHERE pending.transaction_id=t.id AND pending.status='PENDING')
            AND CASE WHEN last.sequence=1 THEN
              NOT EXISTS(SELECT 1 FROM handyman_ledger_corrections c WHERE c.transaction_id=t.id)
              AND NOT EXISTS(SELECT 1 FROM handyman_scope_variations v WHERE v.execution_scope_id=x.id AND v.status='FINAL_CHARGE_ELIGIBILITY')
              AND EXISTS(SELECT 1 FROM handyman_bm_tax_case_heads h JOIN handyman_bm_tax_cases c ON c.id=h.case_id
                JOIN handyman_bm_tax_case_decisions d ON d.id=h.decision_id AND d.case_id=c.id
                WHERE h.entitlement_id=f.id AND c.id=last.original_case_id AND d.id=last.original_decision_id
                  AND d.decision='APPROVE' AND hm_bm_tax_case_sources_ok(c.snapshot))
            ELSE EXISTS(SELECT 1 FROM handyman_bm_correction_tax_cases c JOIN handyman_bm_correction_tax_decisions d ON d.case_id=c.id
                WHERE c.id=last.correction_case_id AND d.id=last.correction_decision_id AND c.correction_id=last.correction_id
                  AND d.decision='APPROVE' AND c.id=(SELECT id FROM handyman_bm_correction_tax_cases WHERE correction_id=last.correction_id ORDER BY version DESC LIMIT 1)
                  AND hm_bm_correction_tax_sources_ok(c.snapshot)) END
        );
      $$;
      CREATE FUNCTION hm_bm_settlement_prepare_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM hm_bm_settlement_lock(NEW);
        IF NOT hm_buyer_actor_allowed(NEW.created_by_user_id,NEW.client_id,NEW.building_id,'handyman.finance.read')
          OR NOT hm_buyer_actor_allowed(NEW.created_by_user_id,NEW.client_id,NEW.building_id,'handyman.finance.manage')
          OR NOT hm_buyer_actor_allowed(NEW.created_by_user_id,NEW.client_id,NEW.building_id,'handyman.settlement.manage')
          OR NOT hm_bm_settlement_anchors_valid(NEW,true)
          OR NEW.snapshot->>'schema' IS DISTINCT FROM 'HANDYMAN_BM_SETTLEMENT_V1'
          OR NEW.snapshot->>'id' IS DISTINCT FROM NEW.id::text OR NEW.snapshot->>'clientId' IS DISTINCT FROM NEW.client_id::text
          OR NEW.snapshot->>'buildingId' IS DISTINCT FROM NEW.building_id::text OR NEW.snapshot->>'counterpartyId' IS DISTINCT FROM NEW.counterparty_id::text
          OR NEW.snapshot->>'entitlementId' IS DISTINCT FROM NEW.entitlement_id::text OR NEW.snapshot->>'agreementVersionId' IS DISTINCT FROM NEW.agreement_version_id::text
          OR NEW.snapshot->>'bankVersionId' IS DISTINCT FROM NEW.bank_version_id::text OR NEW.snapshot->>'bankDecisionId' IS DISTINCT FROM NEW.bank_decision_id::text
          OR NEW.snapshot->>'currency' IS DISTINCT FROM NEW.currency OR NEW.snapshot->>'netPayable' IS DISTINCT FROM NEW.net_payable::text
          OR NEW.snapshot->>'pphWithholdingProjection' IS DISTINCT FROM (SELECT pph_withholding_projection::text FROM handyman_bm_commission_ledger WHERE id=NEW.latest_entry_id)
          OR NEW.snapshot->>'createdByUserId' IS DISTINCT FROM NEW.created_by_user_id::text OR NEW.snapshot->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key
          OR NEW.snapshot->>'evidenceReference' IS DISTINCT FROM NEW.evidence_reference
          OR NEW.snapshot#>>'{assertions,withholding}' IS DISTINCT FROM 'NOT_ASSERTED'
          OR NEW.snapshot#>>'{assertions,remittance}' IS DISTINCT FROM 'NOT_ASSERTED'
          OR NEW.snapshot->'ledgerEntries' IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('id',l.id::text,'digest',l.digest) ORDER BY l.sequence)
            FROM handyman_bm_commission_ledger l WHERE l.entitlement_id=NEW.entitlement_id)
          OR NEW.digest IS DISTINCT FROM hm_bm_correction_tax_digest(NEW.snapshot)
          OR EXISTS(SELECT 1 FROM handyman_bm_bank_account_versions b WHERE b.id=NEW.bank_version_id
            AND position(upper(b.account_number) in upper(NEW.evidence_reference))>0) THEN
          RAISE EXCEPTION 'BM settlement requires exact current ledger, approved bank version and scoped Finance maker.' USING ERRCODE='23514'; END IF;
        NEW.created_at:=clock_timestamp();RETURN NEW;
      END $$;
      CREATE TRIGGER hm_bm_settlement_prepare BEFORE INSERT ON handyman_bm_settlements FOR EACH ROW EXECUTE FUNCTION hm_bm_settlement_prepare_guard();

      CREATE FUNCTION hm_bm_settlement_action_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s handyman_bm_settlements%ROWTYPE; a handyman_bm_settlement_approvals%ROWTYPE;
        p handyman_bm_settlement_payments%ROWTYPE; r handyman_bm_settlement_evidence_reads%ROWTYPE;
      BEGIN
        IF TG_TABLE_NAME='handyman_bm_settlement_evidence_reads' THEN
          SELECT * INTO p FROM handyman_bm_settlement_payments WHERE id=NEW.payment_id;
          SELECT * INTO s FROM handyman_bm_settlements WHERE id=p.settlement_id;
        ELSE SELECT * INTO s FROM handyman_bm_settlements WHERE id=NEW.settlement_id; END IF;
        IF s.id IS NULL THEN RAISE EXCEPTION 'BM settlement not found.' USING ERRCODE='23514'; END IF;
        PERFORM hm_bm_settlement_lock(s);
        IF NOT hm_bm_settlement_anchors_valid(s,TG_TABLE_NAME IN ('handyman_bm_settlement_approvals','handyman_bm_settlement_payments')) THEN
          RAISE EXCEPTION 'BM settlement ledger or bank version is stale.' USING ERRCODE='23514'; END IF;
        IF TG_TABLE_NAME='handyman_bm_settlement_approvals' THEN
          IF NEW.settlement_digest<>s.digest OR NEW.actor_user_id=s.created_by_user_id
            OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,s.client_id,s.building_id,'handyman.finance.read')
            OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,s.client_id,s.building_id,'handyman.bm_settlement.approve')
            OR position(upper((SELECT account_number FROM handyman_bm_bank_account_versions WHERE id=s.bank_version_id)) in upper(NEW.evidence_reference))>0 THEN
            RAISE EXCEPTION 'An independent authorized Finance approval is required.' USING ERRCODE='23514'; END IF;
        ELSIF TG_TABLE_NAME='handyman_bm_settlement_payments' THEN
          SELECT * INTO a FROM handyman_bm_settlement_approvals WHERE settlement_id=s.id;
          IF a.id IS NULL OR a.id<>NEW.approval_id OR NEW.client_id<>s.client_id OR NEW.amount<>s.net_payable OR NEW.currency<>s.currency
            OR NEW.transferred_at<a.occurred_at OR NEW.transferred_at>clock_timestamp()
            OR NOT hm_buyer_actor_allowed(NEW.recorded_by_user_id,s.client_id,s.building_id,'handyman.finance.read')
            OR NOT hm_buyer_actor_allowed(NEW.recorded_by_user_id,s.client_id,s.building_id,'handyman.finance.manage')
            OR NOT hm_buyer_actor_allowed(NEW.recorded_by_user_id,s.client_id,s.building_id,'handyman.settlement.manage')
            OR position(upper((SELECT account_number FROM handyman_bm_bank_account_versions WHERE id=s.bank_version_id)) in upper(NEW.transfer_reference))>0 THEN
            RAISE EXCEPTION 'Exact approved settlement and authorized payment recording are required.' USING ERRCODE='23514'; END IF;
        ELSIF TG_TABLE_NAME='handyman_bm_settlement_evidence_reads' THEN
          IF p.id IS NULL OR NEW.content_sha256<>p.content_sha256 OR NEW.actor_user_id=s.created_by_user_id OR NEW.actor_user_id=p.recorded_by_user_id
            OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,s.client_id,s.building_id,'handyman.finance.read')
            OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,s.client_id,s.building_id,'handyman.bm_settlement.verify_payment') THEN
            RAISE EXCEPTION 'An independent authorized evidence reviewer is required.' USING ERRCODE='23514'; END IF;
        ELSE
          SELECT * INTO p FROM handyman_bm_settlement_payments WHERE id=NEW.payment_id AND settlement_id=s.id;
          SELECT * INTO r FROM handyman_bm_settlement_evidence_reads WHERE id=NEW.evidence_read_id AND payment_id=p.id;
          IF p.id IS NULL OR r.id IS NULL OR NEW.actor_user_id<>r.actor_user_id OR NEW.actor_user_id=s.created_by_user_id
            OR NEW.actor_user_id=p.recorded_by_user_id OR NEW.content_sha256<>p.content_sha256 OR r.content_sha256<>p.content_sha256
            OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,s.client_id,s.building_id,'handyman.finance.read')
            OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,s.client_id,s.building_id,'handyman.bm_settlement.verify_payment')
            OR position(upper((SELECT account_number FROM handyman_bm_bank_account_versions WHERE id=s.bank_version_id)) in upper(NEW.evidence_reference))>0 THEN
            RAISE EXCEPTION 'Actual payment evidence requires an independent Finance review.' USING ERRCODE='23514'; END IF;
        END IF;
        NEW.occurred_at:=clock_timestamp();RETURN NEW;
      END $$;
      CREATE TRIGGER hm_bm_settlement_approval BEFORE INSERT ON handyman_bm_settlement_approvals FOR EACH ROW EXECUTE FUNCTION hm_bm_settlement_action_guard();
      CREATE TRIGGER hm_bm_settlement_payment BEFORE INSERT ON handyman_bm_settlement_payments FOR EACH ROW EXECUTE FUNCTION hm_bm_settlement_action_guard();
      CREATE TRIGGER hm_bm_settlement_evidence_read BEFORE INSERT ON handyman_bm_settlement_evidence_reads FOR EACH ROW EXECUTE FUNCTION hm_bm_settlement_action_guard();
      CREATE TRIGGER hm_bm_settlement_verification BEFORE INSERT ON handyman_bm_settlement_verifications FOR EACH ROW EXECUTE FUNCTION hm_bm_settlement_action_guard();

      CREATE FUNCTION hm_bm_settlement_legacy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE transaction_uuid UUID;
      BEGIN
        SELECT transaction_id INTO transaction_uuid FROM handyman_entitlement_facts WHERE id=NEW.entitlement_id;
        PERFORM 1 FROM handyman_customer_transactions WHERE id=transaction_uuid FOR UPDATE;
        IF EXISTS(SELECT 1 FROM handyman_bm_settlements WHERE entitlement_id=NEW.entitlement_id) THEN
          RAISE EXCEPTION 'BM entitlement is already bound to a separate settlement.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER a_hm_bm_settlement_legacy_guard BEFORE INSERT ON handyman_settlement_inclusions
        FOR EACH ROW EXECUTE FUNCTION hm_bm_settlement_legacy_guard();
    `);
  },
  async down(tx:PoolClient):Promise<void>{
    await tx.query('LOCK TABLE handyman_bm_settlements,handyman_bm_settlement_approvals,handyman_bm_settlement_payments,handyman_bm_settlement_evidence_reads,handyman_bm_settlement_verifications IN ACCESS EXCLUSIVE MODE');
    if((await tx.query('SELECT EXISTS(SELECT 1 FROM handyman_bm_settlements) AS used')).rows[0].used)
      throw new Error('Refusing to remove populated BM settlement payment history.');
    await tx.query(`DROP TRIGGER a_hm_bm_settlement_legacy_guard ON handyman_settlement_inclusions;
      DROP FUNCTION hm_bm_settlement_legacy_guard();
      DROP TRIGGER hm_bm_settlement_prepare ON handyman_bm_settlements;
      DROP TRIGGER hm_bm_settlement_approval ON handyman_bm_settlement_approvals;
      DROP TRIGGER hm_bm_settlement_payment ON handyman_bm_settlement_payments;
      DROP TRIGGER hm_bm_settlement_evidence_read ON handyman_bm_settlement_evidence_reads;
      DROP TRIGGER hm_bm_settlement_verification ON handyman_bm_settlement_verifications;
      DROP TRIGGER hm_bm_settlement_immutable ON handyman_bm_settlements;
      DROP TRIGGER hm_bm_settlement_approval_immutable ON handyman_bm_settlement_approvals;
      DROP TRIGGER hm_bm_settlement_payment_immutable ON handyman_bm_settlement_payments;
      DROP TRIGGER hm_bm_settlement_evidence_read_immutable ON handyman_bm_settlement_evidence_reads;
      DROP TRIGGER hm_bm_settlement_verification_immutable ON handyman_bm_settlement_verifications;
      DROP FUNCTION hm_bm_settlement_action_guard(); DROP FUNCTION hm_bm_settlement_prepare_guard();
      DROP FUNCTION hm_bm_settlement_anchors_valid(handyman_bm_settlements,boolean); DROP FUNCTION hm_bm_settlement_lock(handyman_bm_settlements);
      DROP FUNCTION hm_bm_settlement_immutable();
      DROP TABLE handyman_bm_settlement_verifications,handyman_bm_settlement_evidence_reads,handyman_bm_settlement_payments,
        handyman_bm_settlement_approvals,handyman_bm_settlements;`);
  },
};
