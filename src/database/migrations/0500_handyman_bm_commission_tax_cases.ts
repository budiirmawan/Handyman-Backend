import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Transaction-bound Finance assertions only. No fiscal, entitlement or settlement writes. */
export const migration0500HandymanBmCommissionTaxCases: Migration = {
  id: '0500_handyman_bm_commission_tax_cases',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`INSERT INTO permissions(id,code,name,status)
      VALUES($1,'handyman.bm_tax_case.approve','Approve or reject BM commission tax cases','ACTIVE')
      ON CONFLICT(code) DO NOTHING`,[randomUUID()]);
    await tx.query(`
      CREATE TABLE handyman_bm_tax_case_heads (
        entitlement_id UUID PRIMARY KEY REFERENCES handyman_entitlement_facts(id),
        client_id UUID NOT NULL REFERENCES clients(id), building_id UUID NOT NULL REFERENCES buildings(id),
        version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), case_id UUID, decision_id UUID,
        CHECK((version=0 AND case_id IS NULL AND decision_id IS NULL) OR (version>0 AND case_id IS NOT NULL))
      );
      CREATE TABLE handyman_bm_tax_cases (
        id UUID PRIMARY KEY, entitlement_id UUID NOT NULL REFERENCES handyman_entitlement_facts(id),
        client_id UUID NOT NULL REFERENCES clients(id), building_id UUID NOT NULL REFERENCES buildings(id),
        version INTEGER NOT NULL CHECK(version>0), previous_case_id UUID REFERENCES handyman_bm_tax_cases(id),
        idempotency_key TEXT NOT NULL CHECK(char_length(btrim(idempotency_key)) BETWEEN 1 AND 200 AND idempotency_key=btrim(idempotency_key)),
        snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'), digest TEXT NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
        created_by_user_id UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE(entitlement_id,version), UNIQUE(entitlement_id,idempotency_key), UNIQUE(entitlement_id,previous_case_id)
      );
      CREATE TABLE handyman_bm_tax_case_decisions (
        id UUID PRIMARY KEY, case_id UUID NOT NULL UNIQUE REFERENCES handyman_bm_tax_cases(id),
        entitlement_id UUID NOT NULL REFERENCES handyman_entitlement_facts(id), client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id), version INTEGER NOT NULL CHECK(version>0),
        case_digest TEXT NOT NULL CHECK(case_digest ~ '^[0-9a-f]{64}$'), decision TEXT NOT NULL CHECK(decision IN ('APPROVE','REJECT')),
        ppn_evidence_id UUID NOT NULL, pph_evidence_id UUID NOT NULL, actor_user_id UUID NOT NULL REFERENCES users(id),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), decision_digest TEXT NOT NULL CHECK(decision_digest ~ '^[0-9a-f]{64}$')
      );
      ALTER TABLE handyman_bm_tax_case_heads ADD FOREIGN KEY(case_id) REFERENCES handyman_bm_tax_cases(id),
        ADD FOREIGN KEY(decision_id) REFERENCES handyman_bm_tax_case_decisions(id);
      CREATE INDEX hm_bm_tax_case_scope_idx ON handyman_bm_tax_cases(client_id,building_id,entitlement_id);

      CREATE FUNCTION hm_bm_tax_case_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'BM tax case and decision history is immutable.' USING ERRCODE='23514'; END $$;
      CREATE TRIGGER hm_bm_tax_case_immutable BEFORE UPDATE OR DELETE ON handyman_bm_tax_cases
        FOR EACH ROW EXECUTE FUNCTION hm_bm_tax_case_immutable();
      CREATE TRIGGER hm_bm_tax_decision_immutable BEFORE UPDATE OR DELETE ON handyman_bm_tax_case_decisions
        FOR EACH ROW EXECUTE FUNCTION hm_bm_tax_case_immutable();

      -- Serialize even direct correction inserts with determination validation on the ledger row.
      CREATE FUNCTION hm_bm_tax_correction_lock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM 1 FROM handyman_customer_transactions t JOIN handyman_entitlement_facts f ON f.transaction_id=t.id
          WHERE f.id=NEW.entitlement_id AND f.entitlement_kind='BM_FEE' FOR UPDATE OF t;
        RETURN NEW;
      END $$;
      CREATE TRIGGER hm_bm_tax_correction_lock BEFORE INSERT ON handyman_entitlement_corrections
        FOR EACH ROW EXECUTE FUNCTION hm_bm_tax_correction_lock();

      -- Each rule is separately pinned to its own tax family, classification, date and Finance decision.
      CREATE FUNCTION hm_bm_tax_case_rule_ok(s JSONB, prefix TEXT, family TEXT) RETURNS BOOLEAN LANGUAGE sql VOLATILE AS $$
        SELECT EXISTS(SELECT 1 FROM handyman_tax_rules r
          JOIN handyman_tax_rule_windows w ON w.rule_id=r.id
          LEFT JOIN handyman_tax_rule_closures c ON c.rule_id=r.id
          JOIN handyman_tax_rule_approval_events d ON d.id=(s->>(prefix||'RuleDecisionId'))::uuid
          JOIN handyman_tax_rule_approval_events sub ON sub.id=d.submission_id
          WHERE r.id=(s->>(prefix||'RuleId'))::uuid AND r.client_id=(s->>'clientId')::uuid
            AND r.version=(s->>(prefix||'RuleVersion'))::int AND r.transaction_context='BM_COMMISSION' AND r.tax_code=family
            AND r.taxpayer_classification=s->>(prefix||'TaxpayerClassification')
            AND w.client_id=r.client_id AND w.transaction_context=r.transaction_context AND w.tax_code=r.tax_code
            AND w.taxpayer_classification=r.taxpayer_classification AND w.effective_from=r.effective_from
            AND w.effective_to IS NOT DISTINCT FROM COALESCE(c.effective_to,r.declared_effective_to)
            AND (s->>(prefix||'TaxDate'))::date >= w.effective_from
            AND (w.effective_to IS NULL OR (s->>(prefix||'TaxDate'))::date < w.effective_to)
            AND d.rule_id=r.id AND d.client_id=r.client_id AND d.rule_version=r.version
            AND d.rule_digest=s->>(prefix||'RuleDigest') AND d.rule_digest=hm_tax_rule_payload_digest(r.id)
            AND d.event_type='APPROVE' AND d.source_validation='FINANCE_VALIDATED'
            AND sub.event_type='SUBMIT' AND sub.rule_id=r.id AND sub.rule_digest=d.rule_digest
            AND d.actor_user_id<>sub.actor_user_id AND d.actor_user_id<>r.created_by_user_id
            AND d.occurred_at>sub.occurred_at AND d.occurred_at <= clock_timestamp()
            AND d.occurred_at <= (s->>(prefix||'TaxPointAt'))::timestamptz);
      $$;
      CREATE FUNCTION hm_bm_tax_case_identity_ok(s JSONB, prefix TEXT, requested_owner_kind TEXT, point TEXT) RETURNS BOOLEAN LANGUAGE sql VOLATILE AS $$
        SELECT EXISTS(SELECT 1 FROM handyman_tax_identity_profiles p
          JOIN handyman_tax_identity_windows w ON w.profile_id=p.id
          LEFT JOIN handyman_tax_identity_closures c ON c.profile_id=p.id
          LEFT JOIN handyman_document_issuer_profiles i ON i.id=p.issuer_profile_id
          JOIN handyman_tax_identity_approval_events d ON d.id=(s->>(prefix||'DecisionId'))::uuid
          JOIN handyman_tax_identity_approval_events sub ON sub.id=d.submission_id
          WHERE p.id=(s->>(prefix||'ProfileId'))::uuid AND p.client_id=(s->>'clientId')::uuid
            AND p.version=(s->>(prefix||'Version'))::int AND p.owner_kind=requested_owner_kind
            AND ((requested_owner_kind='BM_BENEFICIARY' AND p.owner_id=(s->>'counterpartyId')::uuid
                  AND p.counterparty_id=p.owner_id AND p.verification_id=(s->>'verificationId')::uuid)
              OR (requested_owner_kind='HANDYMAN_ISSUER' AND p.owner_id=p.client_id AND i.client_id=p.client_id
                  AND i.legal_name=p.legal_name AND i.effective_from <= (s->>point)::timestamptz
                  AND (i.superseded_at IS NULL OR (s->>point)::timestamptz < i.superseded_at)))
            AND w.owner_kind=p.owner_kind AND w.owner_id=p.owner_id AND w.effective_from=p.effective_from
            AND w.effective_to IS NOT DISTINCT FROM COALESCE(c.effective_to,p.declared_effective_to)
            AND w.effective_from <= (s->>point)::timestamptz AND (w.effective_to IS NULL OR (s->>point)::timestamptz < w.effective_to)
            AND d.event_type='APPROVE' AND d.profile_id=p.id AND d.client_id=p.client_id
            AND d.owner_kind=p.owner_kind AND d.owner_id=p.owner_id AND d.profile_version=p.version
            AND d.profile_digest=s->>(prefix||'Digest') AND d.profile_digest=hm_tax_identity_payload_digest(p.id)
            AND sub.event_type='SUBMIT' AND sub.profile_id=p.id AND sub.profile_digest=d.profile_digest
            AND d.actor_user_id<>sub.actor_user_id AND d.actor_user_id<>p.created_by_user_id AND d.occurred_at>sub.occurred_at
            AND d.approved_from <= (s->>point)::timestamptz AND (d.approved_to IS NULL OR (s->>point)::timestamptz < d.approved_to)
            AND d.occurred_at <= clock_timestamp() AND d.occurred_at <= (s->>point)::timestamptz);
      $$;
      CREATE FUNCTION hm_bm_tax_case_sources_ok(s JSONB) RETURNS BOOLEAN LANGUAGE sql VOLATILE AS $$
        SELECT EXISTS(SELECT 1 FROM handyman_entitlement_facts f
          JOIN handyman_execution_scopes scope ON scope.id=f.execution_scope_id AND scope.client_id=f.client_id
          JOIN handyman_customer_transactions t ON t.id=f.transaction_id AND t.execution_scope_id=scope.id AND t.client_id=f.client_id
          JOIN handyman_bm_building_coverages c ON c.id=(s->>'coverageId')::uuid AND c.client_id=f.client_id AND c.building_id=scope.building_id
          JOIN handyman_bm_legal_counterparties p ON p.id=c.counterparty_id AND p.client_id=f.client_id
          JOIN handyman_bm_counterparty_verifications proof ON proof.id=c.verification_id AND proof.counterparty_id=p.id
          JOIN handyman_commercial_agreement_versions v ON v.id=c.agreement_version_id AND v.agreement_id=f.agreement_id
          WHERE f.id=(s->>'entitlementId')::uuid AND f.client_id=(s->>'clientId')::uuid AND scope.building_id=(s->>'buildingId')::uuid
            AND f.execution_scope_id=(s->>'executionScopeId')::uuid AND f.transaction_id=(s->>'transactionId')::uuid
            AND f.entitlement_kind='BM_FEE' AND f.fact_state='EARNED' AND f.basis_kind='LABOR_ONLY'
            AND f.ledger_contract_version='CR-HM-13-PART-06' AND f.currency='IDR' AND t.currency=f.currency
            AND f.amount=(s->>'commissionGross')::numeric AND s->>'currency'='IDR' AND s->>'commissionBasis'='EARNED_BM_COMMISSION'
            AND f.agreement_id=(s->>'agreementId')::uuid AND f.agreement_version_id=(s->>'agreementVersionId')::uuid
            AND f.agreement_version_number=(s->>'agreementVersionNumber')::int AND v.version_number=f.agreement_version_number
            AND c.counterparty_id=(s->>'counterpartyId')::uuid AND c.verification_id=(s->>'verificationId')::uuid
            AND c.agreement_version_id=f.agreement_version_id AND c.created_at <= f.derived_at AND c.cancelled_at IS NULL
            AND c.effective_from <= f.ledger_posted_at AND (c.effective_to IS NULL OR f.ledger_posted_at < c.effective_to)
            AND proof.verified_at <= f.ledger_posted_at
            AND ((f.bm_beneficiary_kind='BM_LEGAL_COUNTERPARTY' AND c.beneficiary_kind='BM_LEGAL_COUNTERPARTY'
                  AND f.bm_counterparty_id=c.counterparty_id AND f.bm_coverage_id=c.id AND f.bm_verification_id=c.verification_id
                  AND f.bm_building_id=c.building_id AND p.represented_client_id IS NULL)
              OR (f.bm_beneficiary_kind IS NULL AND c.beneficiary_kind='CLIENT_ORGANIZATION'
                  AND c.beneficiary_definition_id=f.bm_beneficiary_id AND f.bm_beneficiary_reference_id=f.client_id
                  AND p.represented_client_id=f.client_id))
            AND (s->>'ppnTaxPointAt')::timestamptz >= f.ledger_posted_at
            AND (s->>'pphTaxPointAt')::timestamptz >= f.ledger_posted_at
            AND ((s->>'ppnTaxPointAt')::timestamptz AT TIME ZONE 'Asia/Jakarta')::date=(s->>'ppnTaxDate')::date
            AND ((s->>'pphTaxPointAt')::timestamptz AT TIME ZONE 'Asia/Jakarta')::date=(s->>'pphTaxDate')::date
            AND NOT EXISTS(SELECT 1 FROM handyman_entitlement_corrections ec WHERE ec.entitlement_id=f.id)
            AND f.labor_net=COALESCE((SELECT SUM(l.amount) FROM handyman_charge_lines l WHERE l.transaction_id=t.id AND l.line_kind='LABOR'),0)
              -COALESCE((SELECT SUM(a.amount) FROM handyman_ledger_corrections a JOIN handyman_charge_lines l ON l.id=a.source_charge_line_id
                WHERE a.transaction_id=t.id AND a.correction_kind='ADJUSTMENT' AND l.line_kind='LABOR'),0)
            AND f.material_net=COALESCE((SELECT SUM(l.amount) FROM handyman_charge_lines l WHERE l.transaction_id=t.id AND l.line_kind='MATERIAL'),0)
              -COALESCE((SELECT SUM(a.amount) FROM handyman_ledger_corrections a JOIN handyman_charge_lines l ON l.id=a.source_charge_line_id
                WHERE a.transaction_id=t.id AND a.correction_kind='ADJUSTMENT' AND l.line_kind='MATERIAL'),0)
            AND f.adjusted_transaction_scope=COALESCE((SELECT SUM(a.amount) FROM handyman_ledger_corrections a
              WHERE a.transaction_id=t.id AND a.correction_kind='ADJUSTMENT' AND a.source_kind='TRANSACTION'),0)
            AND f.charged_net=f.labor_net+f.material_net-f.adjusted_transaction_scope)
          AND hm_bm_tax_case_rule_ok(s,'ppn','PPN') AND hm_bm_tax_case_rule_ok(s,'pph','PPH_WITHHOLDING')
          AND hm_bm_tax_case_identity_ok(s,'ppnBeneficiary','BM_BENEFICIARY','ppnTaxPointAt')
          AND hm_bm_tax_case_identity_ok(s,'ppnIssuer','HANDYMAN_ISSUER','ppnTaxPointAt')
          AND hm_bm_tax_case_identity_ok(s,'pphBeneficiary','BM_BENEFICIARY','pphTaxPointAt');
      $$;

      CREATE FUNCTION hm_bm_tax_case_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE h handyman_bm_tax_case_heads%ROWTYPE; s JSONB:=NEW.snapshot;
      BEGIN
        IF current_setting('transaction_isolation') <> 'read committed' THEN
          RAISE EXCEPTION 'BM tax case writes require READ COMMITTED.' USING ERRCODE='23514'; END IF;
        PERFORM 1 FROM handyman_customer_transactions t JOIN handyman_entitlement_facts f ON f.transaction_id=t.id
          WHERE f.id=NEW.entitlement_id FOR UPDATE OF t;
        SELECT * INTO h FROM handyman_bm_tax_case_heads WHERE entitlement_id=NEW.entitlement_id FOR UPDATE;
        PERFORM profile_id FROM handyman_tax_identity_windows WHERE profile_id=ANY(ARRAY[
          (s->>'ppnBeneficiaryProfileId')::uuid,(s->>'ppnIssuerProfileId')::uuid,(s->>'pphBeneficiaryProfileId')::uuid]) ORDER BY profile_id FOR SHARE;
        PERFORM i.id FROM handyman_document_issuer_profiles i JOIN handyman_tax_identity_profiles p ON p.issuer_profile_id=i.id
          WHERE p.id=(s->>'ppnIssuerProfileId')::uuid FOR SHARE OF i;
        PERFORM rule_id FROM handyman_tax_rule_windows WHERE rule_id=ANY(ARRAY[
          (s->>'ppnRuleId')::uuid,(s->>'pphRuleId')::uuid]) ORDER BY rule_id FOR SHARE;
        IF h.entitlement_id IS NULL OR h.client_id<>NEW.client_id OR h.building_id<>NEW.building_id
          OR NEW.version<>h.version+1 OR NEW.previous_case_id IS DISTINCT FROM h.case_id
          OR (h.version>0 AND h.decision_id IS NULL)
          OR NOT hm_buyer_actor_allowed(NEW.created_by_user_id,NEW.client_id,NEW.building_id,'handyman.finance.read')
          OR NOT hm_buyer_actor_allowed(NEW.created_by_user_id,NEW.client_id,NEW.building_id,'handyman.finance.manage')
          OR s->>'schema' IS DISTINCT FROM 'HANDYMAN_BM_TAX_CASE_V1' OR s->>'id' IS DISTINCT FROM NEW.id::text
          OR s->>'version' IS DISTINCT FROM NEW.version::text OR s->>'previousCaseId' IS DISTINCT FROM NEW.previous_case_id::text
          OR s->>'entitlementId' IS DISTINCT FROM NEW.entitlement_id::text OR s->>'clientId' IS DISTINCT FROM NEW.client_id::text
          OR s->>'buildingId' IS DISTINCT FROM NEW.building_id::text OR s->>'createdByUserId' IS DISTINCT FROM NEW.created_by_user_id::text
          OR s->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key OR NEW.digest IS DISTINCT FROM hm_buyer_binding_digest(s)
          OR (SELECT count(*) FROM jsonb_object_keys(s))<>56 OR NOT s ?& ARRAY[
            'schema','id','version','previousCaseId','clientId','buildingId','entitlementId','executionScopeId','transactionId',
            'sourceChecksum','commissionGross','currency','commissionBasis','counterpartyId','verificationId','coverageId',
            'agreementId','agreementVersionId','agreementVersionNumber','transactionClassification','serviceClassification',
            'transactionEvidenceReferenceId','ppnTaxDate','ppnTaxPointAt','ppnAmountBasis','ppnApplicability','ppnTaxpayerClassification',
            'ppnEvidenceReferenceId','ppnRuleId','ppnRuleVersion','ppnRuleDigest','ppnRuleDecisionId','ppnBeneficiaryProfileId',
            'ppnBeneficiaryVersion','ppnBeneficiaryDigest','ppnBeneficiaryDecisionId','ppnIssuerProfileId','ppnIssuerVersion','ppnIssuerDigest',
            'ppnIssuerDecisionId','pphTaxDate','pphTaxPointAt','pphTreatment','pphTaxpayerClassification','pphEvidenceReferenceId',
            'pphRuleId','pphRuleVersion','pphRuleDigest','pphRuleDecisionId','pphBeneficiaryProfileId','pphBeneficiaryVersion',
            'pphBeneficiaryDigest','pphBeneficiaryDecisionId','createdByUserId','idempotencyKey','intentDigest']
          OR EXISTS(SELECT 1 FROM jsonb_each(s) AS e(k,v) WHERE jsonb_typeof(v) IN ('object','array'))
          OR NOT COALESCE((s->>'intentDigest') ~ '^[0-9a-f]{64}$',false)
          OR NOT COALESCE((s->>'sourceChecksum') ~ '^[0-9a-f]{64}$',false)
          OR NOT COALESCE((s->>'transactionClassification') ~ '^[A-Z][A-Z0-9_]{1,63}$',false)
          OR NOT COALESCE((s->>'serviceClassification') ~ '^[A-Z][A-Z0-9_]{1,63}$',false)
          OR NOT COALESCE(s->>'ppnAmountBasis'='PPN_EXCLUSIVE' AND s->>'ppnApplicability' IN ('TAXABLE','EXEMPT','NON_TAXABLE'),false)
          OR NOT COALESCE(s->>'pphTreatment' IN ('WITHHOLD','EXEMPT','NON_WITHHOLD'),false)
          OR NOT COALESCE(starts_with(s->>'ppnTaxpayerClassification', CASE s->>'ppnApplicability'
            WHEN 'TAXABLE' THEN 'P02A_TAX_' WHEN 'EXEMPT' THEN 'P02A_EXEMPT_' ELSE 'P02A_NON_TAX_' END),false)
          OR NOT COALESCE(starts_with(s->>'pphTaxpayerClassification', CASE s->>'pphTreatment'
            WHEN 'WITHHOLD' THEN 'P02B_TAX_' WHEN 'EXEMPT' THEN 'P02B_EXEMPT_' ELSE 'P02B_NON_WITHHOLD_' END),false)
          OR NOT COALESCE((s->>'transactionEvidenceReferenceId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND
             (s->>'ppnEvidenceReferenceId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND
             (s->>'pphEvidenceReferenceId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)
          OR s->>'transactionEvidenceReferenceId' IN ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','ffffffff-ffff-ffff-ffff-ffffffffffff')
          OR s->>'ppnEvidenceReferenceId' IN ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','ffffffff-ffff-ffff-ffff-ffffffffffff')
          OR s->>'pphEvidenceReferenceId' IN ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','ffffffff-ffff-ffff-ffff-ffffffffffff')
          OR NOT COALESCE(hm_bm_tax_case_sources_ok(s),false) THEN
          RAISE EXCEPTION 'BM tax case source, evidence, scope, version or independent tax rules are invalid.' USING ERRCODE='23514';
        END IF;
        NEW.created_at:=date_trunc('milliseconds',clock_timestamp()); RETURN NEW;
      END $$;
      CREATE TRIGGER hm_bm_tax_case_insert BEFORE INSERT ON handyman_bm_tax_cases FOR EACH ROW EXECUTE FUNCTION hm_bm_tax_case_insert();

      CREATE FUNCTION hm_bm_tax_case_decide() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE h handyman_bm_tax_case_heads%ROWTYPE; c handyman_bm_tax_cases%ROWTYPE;
      BEGIN
        IF current_setting('transaction_isolation') <> 'read committed' THEN
          RAISE EXCEPTION 'BM tax case writes require READ COMMITTED.' USING ERRCODE='23514'; END IF;
        PERFORM 1 FROM handyman_customer_transactions t JOIN handyman_entitlement_facts f ON f.transaction_id=t.id
          WHERE f.id=NEW.entitlement_id FOR UPDATE OF t;
        SELECT * INTO h FROM handyman_bm_tax_case_heads WHERE entitlement_id=NEW.entitlement_id FOR UPDATE;
        SELECT * INTO c FROM handyman_bm_tax_cases WHERE id=NEW.case_id;
        IF c.id IS NOT NULL AND NEW.decision='APPROVE' THEN
          PERFORM profile_id FROM handyman_tax_identity_windows WHERE profile_id=ANY(ARRAY[
            (c.snapshot->>'ppnBeneficiaryProfileId')::uuid,(c.snapshot->>'ppnIssuerProfileId')::uuid,
            (c.snapshot->>'pphBeneficiaryProfileId')::uuid]) ORDER BY profile_id FOR SHARE;
          PERFORM i.id FROM handyman_document_issuer_profiles i JOIN handyman_tax_identity_profiles p ON p.issuer_profile_id=i.id
            WHERE p.id=(c.snapshot->>'ppnIssuerProfileId')::uuid FOR SHARE OF i;
          PERFORM rule_id FROM handyman_tax_rule_windows WHERE rule_id=ANY(ARRAY[
            (c.snapshot->>'ppnRuleId')::uuid,(c.snapshot->>'pphRuleId')::uuid]) ORDER BY rule_id FOR SHARE;
        END IF;
        IF h.case_id IS DISTINCT FROM NEW.case_id OR h.decision_id IS NOT NULL OR c.id IS NULL
          OR h.client_id<>NEW.client_id OR h.building_id<>NEW.building_id OR h.version<>NEW.version
          OR c.client_id<>NEW.client_id OR c.building_id<>NEW.building_id OR c.entitlement_id<>NEW.entitlement_id
          OR c.version<>NEW.version OR c.digest<>NEW.case_digest OR c.digest<>hm_buyer_binding_digest(c.snapshot)
          OR c.created_by_user_id=NEW.actor_user_id
          OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,NEW.client_id,NEW.building_id,'handyman.finance.read')
          OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,NEW.client_id,NEW.building_id,'handyman.bm_tax_case.approve')
          OR NEW.ppn_evidence_id::text IN ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','ffffffff-ffff-ffff-ffff-ffffffffffff')
          OR NEW.pph_evidence_id::text IN ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','ffffffff-ffff-ffff-ffff-ffffffffffff')
          OR (NEW.decision='APPROVE' AND NOT COALESCE(hm_bm_tax_case_sources_ok(c.snapshot),false)) THEN
          RAISE EXCEPTION 'BM tax case requires an independent scoped checker and current sources.' USING ERRCODE='23514'; END IF;
        NEW.occurred_at:=GREATEST(date_trunc('milliseconds',clock_timestamp())+interval '1 millisecond',c.created_at+interval '1 millisecond');
        NEW.decision_digest:=hm_buyer_binding_digest(jsonb_build_object('id',NEW.id::text,'caseId',NEW.case_id::text,
          'clientId',NEW.client_id::text,'buildingId',NEW.building_id::text,'entitlementId',NEW.entitlement_id::text,
          'version',NEW.version,'caseDigest',NEW.case_digest,'decision',NEW.decision,
          'ppnReviewEvidenceReferenceId',NEW.ppn_evidence_id::text,'pphReviewEvidenceReferenceId',NEW.pph_evidence_id::text,
          'actorUserId',NEW.actor_user_id::text,'occurredAt',to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
        RETURN NEW;
      END $$;
      CREATE TRIGGER hm_bm_tax_case_decide BEFORE INSERT ON handyman_bm_tax_case_decisions FOR EACH ROW EXECUTE FUNCTION hm_bm_tax_case_decide();

      CREATE FUNCTION hm_bm_tax_case_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BM tax case head cannot be deleted.' USING ERRCODE='23514'; END IF;
        IF TG_OP='INSERT' THEN
          IF NEW.version<>0 OR NEW.case_id IS NOT NULL OR NEW.decision_id IS NOT NULL OR NOT EXISTS(
            SELECT 1 FROM handyman_entitlement_facts f JOIN handyman_execution_scopes s ON s.id=f.execution_scope_id
             WHERE f.id=NEW.entitlement_id AND f.client_id=NEW.client_id AND s.client_id=NEW.client_id AND s.building_id=NEW.building_id
               AND f.entitlement_kind='BM_FEE' AND f.fact_state='EARNED') THEN
            RAISE EXCEPTION 'BM tax case head must start empty on its exact entitlement.' USING ERRCODE='23514'; END IF;
          RETURN NEW;
        END IF;
        IF NEW.entitlement_id<>OLD.entitlement_id OR NEW.client_id<>OLD.client_id OR NEW.building_id<>OLD.building_id THEN
          RAISE EXCEPTION 'BM tax case head scope cannot change.' USING ERRCODE='23514'; END IF;
        IF NEW.version=OLD.version+1 AND NEW.decision_id IS NULL AND (OLD.version=0 OR OLD.decision_id IS NOT NULL) AND EXISTS(
          SELECT 1 FROM handyman_bm_tax_cases c WHERE c.id=NEW.case_id AND c.entitlement_id=NEW.entitlement_id
            AND c.client_id=NEW.client_id AND c.building_id=NEW.building_id AND c.version=NEW.version
            AND c.previous_case_id IS NOT DISTINCT FROM OLD.case_id) THEN RETURN NEW; END IF;
        IF NEW.version=OLD.version AND NEW.case_id=OLD.case_id AND OLD.decision_id IS NULL AND EXISTS(
          SELECT 1 FROM handyman_bm_tax_case_decisions d WHERE d.id=NEW.decision_id AND d.case_id=NEW.case_id
            AND d.entitlement_id=NEW.entitlement_id AND d.client_id=NEW.client_id AND d.building_id=NEW.building_id
            AND d.version=NEW.version) THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'Invalid BM tax case head transition.' USING ERRCODE='23514';
      END $$;
      CREATE TRIGGER hm_bm_tax_case_head_guard BEFORE INSERT OR UPDATE OR DELETE ON handyman_bm_tax_case_heads
        FOR EACH ROW EXECUTE FUNCTION hm_bm_tax_case_head_guard();
      CREATE FUNCTION hm_bm_tax_case_head_required() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE h handyman_bm_tax_case_heads%ROWTYPE;
      BEGIN
        SELECT * INTO h FROM handyman_bm_tax_case_heads WHERE entitlement_id=NEW.entitlement_id;
        IF TG_TABLE_NAME='handyman_bm_tax_cases' THEN
          IF h.case_id IS DISTINCT FROM NEW.id OR h.version<>NEW.version THEN
            RAISE EXCEPTION 'BM tax case must advance its head.' USING ERRCODE='23514'; END IF;
        ELSE
          IF h.decision_id IS DISTINCT FROM NEW.id THEN
            RAISE EXCEPTION 'BM tax decision must advance its head.' USING ERRCODE='23514'; END IF;
        END IF; RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER hm_bm_tax_case_head_required AFTER INSERT ON handyman_bm_tax_cases
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hm_bm_tax_case_head_required();
      CREATE CONSTRAINT TRIGGER hm_bm_tax_decision_head_required AFTER INSERT ON handyman_bm_tax_case_decisions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hm_bm_tax_case_head_required();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    const result=await tx.query('SELECT EXISTS(SELECT 1 FROM handyman_bm_tax_case_heads) AS used');
    if(result.rows[0].used) throw new Error('Refusing to remove populated BM tax case history.');
    await tx.query(`DROP TRIGGER hm_bm_tax_correction_lock ON handyman_entitlement_corrections;
      DROP FUNCTION hm_bm_tax_correction_lock();
      DROP TABLE handyman_bm_tax_case_heads; DROP TABLE handyman_bm_tax_case_decisions; DROP TABLE handyman_bm_tax_cases;
      DROP FUNCTION hm_bm_tax_case_head_required(); DROP FUNCTION hm_bm_tax_case_head_guard(); DROP FUNCTION hm_bm_tax_case_decide();
      DROP FUNCTION hm_bm_tax_case_insert(); DROP FUNCTION hm_bm_tax_case_sources_ok(JSONB);
      DROP FUNCTION hm_bm_tax_case_identity_ok(JSONB,TEXT,TEXT,TEXT); DROP FUNCTION hm_bm_tax_case_rule_ok(JSONB,TEXT,TEXT);
      DROP FUNCTION hm_bm_tax_case_immutable();`);
    // Do not revoke a deliberately granted checker permission.
  },
};
