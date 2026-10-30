import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** A new correction-specific Finance assertion; 0500/0501 history remains unchanged. */
export const migration0502HandymanBmCorrectionTaxApproval: Migration = {
  id: '0502_handyman_bm_correction_tax_approval',
  async up(tx:PoolClient):Promise<void> {
    await tx.query(`
      CREATE TABLE handyman_bm_correction_tax_cases (
        id UUID PRIMARY KEY, correction_id UUID NOT NULL REFERENCES handyman_entitlement_corrections(id),
        entitlement_id UUID NOT NULL REFERENCES handyman_entitlement_facts(id), client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id), version INTEGER NOT NULL CHECK(version>0),
        previous_case_id UUID REFERENCES handyman_bm_correction_tax_cases(id),
        idempotency_key TEXT NOT NULL CHECK(char_length(btrim(idempotency_key)) BETWEEN 1 AND 200 AND idempotency_key=btrim(idempotency_key)),
        snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'), digest TEXT NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
        created_by_user_id UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE(correction_id,version), UNIQUE(correction_id,idempotency_key)
      );
      CREATE TABLE handyman_bm_correction_tax_decisions (
        id UUID PRIMARY KEY, case_id UUID NOT NULL UNIQUE REFERENCES handyman_bm_correction_tax_cases(id),
        correction_id UUID NOT NULL REFERENCES handyman_entitlement_corrections(id),
        entitlement_id UUID NOT NULL REFERENCES handyman_entitlement_facts(id), client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id), version INTEGER NOT NULL CHECK(version>0),
        case_digest TEXT NOT NULL CHECK(case_digest ~ '^[0-9a-f]{64}$'), decision TEXT NOT NULL CHECK(decision IN ('APPROVE','REJECT')),
        ppn_evidence_id UUID NOT NULL, pph_evidence_id UUID NOT NULL, actor_user_id UUID NOT NULL REFERENCES users(id),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), decision_digest TEXT NOT NULL CHECK(decision_digest ~ '^[0-9a-f]{64}$')
      );
      CREATE TRIGGER hm_bm_correction_tax_case_immutable BEFORE UPDATE OR DELETE ON handyman_bm_correction_tax_cases
        FOR EACH ROW EXECUTE FUNCTION hm_bm_tax_case_immutable();
      CREATE TRIGGER hm_bm_correction_tax_decision_immutable BEFORE UPDATE OR DELETE ON handyman_bm_correction_tax_decisions
        FOR EACH ROW EXECUTE FUNCTION hm_bm_tax_case_immutable();

      -- Unlike 0500's scalar snapshots, this snapshot also pins the nested
      -- normalized maker intent. Match stableJson recursively for that digest.
      CREATE FUNCTION hm_bm_correction_tax_canonical(v JSONB) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS $$
      DECLARE result TEXT;
      BEGIN
        IF jsonb_typeof(v)='object' THEN
          SELECT '{'||COALESCE(string_agg(to_json(k)::text||':'||hm_bm_correction_tax_canonical(x),',' ORDER BY k COLLATE "C"),'')||'}'
            INTO result FROM jsonb_each(v) AS e(k,x);
          RETURN result;
        ELSIF jsonb_typeof(v)='array' THEN
          SELECT '['||COALESCE(string_agg(hm_bm_correction_tax_canonical(x),',' ORDER BY ord),'')||']'
            INTO result FROM jsonb_array_elements(v) WITH ORDINALITY AS e(x,ord);
          RETURN result;
        END IF;
        RETURN v::text;
      END $$;
      CREATE FUNCTION hm_bm_correction_tax_digest(v JSONB) RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT AS $$
        SELECT encode(digest(convert_to(hm_bm_correction_tax_canonical(v),'UTF8'),'sha256'),'hex');
      $$;

      -- Only a single, line-scoped recorded BM correction is supported. A
      -- historical 0500 case is a baseline witness, never this case's tax approval.
      CREATE FUNCTION hm_bm_correction_tax_sources_ok(s JSONB) RETURNS BOOLEAN LANGUAGE sql VOLATILE AS $$
        SELECT EXISTS(SELECT 1 FROM handyman_entitlement_facts f
          JOIN handyman_execution_scopes scope ON scope.id=f.execution_scope_id AND scope.client_id=f.client_id
          JOIN handyman_customer_transactions t ON t.id=f.transaction_id AND t.client_id=f.client_id AND t.execution_scope_id=scope.id
          JOIN handyman_entitlement_corrections e ON e.id=(s->>'correctionFactId')::uuid AND e.entitlement_id=f.id
          JOIN handyman_ledger_corrections lc ON lc.id=e.ledger_correction_id AND lc.transaction_id=f.transaction_id AND lc.client_id=f.client_id
          JOIN handyman_charge_lines l ON l.id=lc.source_charge_line_id AND l.transaction_id=t.id AND l.client_id=f.client_id
          JOIN handyman_bm_building_coverages cov ON cov.id=(s->>'coverageId')::uuid AND cov.client_id=f.client_id
            AND cov.building_id=scope.building_id
          JOIN handyman_bm_legal_counterparties party ON party.id=cov.counterparty_id AND party.client_id=f.client_id
          JOIN handyman_bm_counterparty_verifications proof ON proof.id=cov.verification_id AND proof.counterparty_id=party.id
          JOIN handyman_commercial_agreement_versions av ON av.id=cov.agreement_version_id AND av.agreement_id=f.agreement_id
          JOIN handyman_bm_tax_case_heads h ON h.entitlement_id=f.id AND h.client_id=f.client_id AND h.building_id=scope.building_id
          JOIN handyman_bm_tax_cases old ON old.id=h.case_id AND old.id=(s->>'baselineCaseId')::uuid
            AND old.entitlement_id=f.id AND old.version=(s->>'baselineCaseVersion')::int
          JOIN handyman_bm_tax_case_decisions od ON od.id=h.decision_id AND od.id=(s->>'baselineDecisionId')::uuid
            AND od.case_id=old.id AND od.entitlement_id=f.id AND od.client_id=f.client_id AND od.building_id=scope.building_id
          WHERE f.id=(s->>'entitlementId')::uuid AND f.client_id=(s->>'clientId')::uuid
            AND scope.building_id=(s->>'buildingId')::uuid AND f.execution_scope_id=(s->>'executionScopeId')::uuid
            AND f.transaction_id=(s->>'transactionId')::uuid AND f.entitlement_kind='BM_FEE' AND f.fact_state='EARNED'
            AND f.basis_kind='LABOR_ONLY' AND f.currency='IDR' AND f.ledger_contract_version='CR-HM-13-PART-06'
            AND t.currency=f.currency AND s->>'currency'='IDR' AND s->>'commissionBasis'='CORRECTED_BM_COMMISSION'
            AND f.amount=(s->>'originalCommissionGross')::numeric AND f.amount-e.amount=(s->>'commissionGross')::numeric
            AND f.amount>=e.amount AND e.fact_kind IN ('ADJUSTED_DECREASE','REVERSED')
            AND ((e.fact_kind='REVERSED' AND f.amount=e.amount) OR (e.fact_kind='ADJUSTED_DECREASE' AND f.amount>e.amount))
            AND s->>'signedAmount'='-'||e.amount::text AND s->>'ledgerCorrectionId'=lc.id::text
            AND lc.correction_kind='ADJUSTMENT' AND lc.source_kind='CHARGE_LINE' AND l.line_kind='LABOR'
            AND lc.currency=f.currency AND l.currency=f.currency AND lc.occurred_at>f.derived_at AND e.occurred_at>=lc.occurred_at
            AND (SELECT count(*) FROM handyman_entitlement_corrections x WHERE x.entitlement_id=f.id)=1
            AND (SELECT count(*) FROM handyman_ledger_corrections x WHERE x.transaction_id=t.id)=1
            AND NOT EXISTS(SELECT 1 FROM handyman_scope_variations x WHERE x.execution_scope_id=scope.id AND x.status='FINAL_CHARGE_ELIGIBILITY')
            AND f.agreement_id=(s->>'agreementId')::uuid AND f.agreement_version_id=(s->>'agreementVersionId')::uuid
            AND f.agreement_version_number=(s->>'agreementVersionNumber')::int AND av.version_number=f.agreement_version_number
            AND cov.counterparty_id=(s->>'counterpartyId')::uuid AND cov.verification_id=(s->>'verificationId')::uuid
            AND cov.agreement_version_id=f.agreement_version_id AND cov.created_at<=f.derived_at AND cov.cancelled_at IS NULL
            AND cov.effective_from<=f.ledger_posted_at AND (cov.effective_to IS NULL OR f.ledger_posted_at<cov.effective_to)
            AND proof.verified_at<=f.ledger_posted_at
            AND ((f.bm_beneficiary_kind='BM_LEGAL_COUNTERPARTY' AND cov.beneficiary_kind='BM_LEGAL_COUNTERPARTY'
                  AND f.bm_counterparty_id=cov.counterparty_id AND f.bm_coverage_id=cov.id AND f.bm_verification_id=cov.verification_id
                  AND f.bm_building_id=cov.building_id AND party.represented_client_id IS NULL)
              OR (f.bm_beneficiary_kind IS NULL AND cov.beneficiary_kind='CLIENT_ORGANIZATION'
                  AND cov.beneficiary_definition_id=f.bm_beneficiary_id AND f.bm_beneficiary_reference_id=f.client_id
                  AND party.represented_client_id=f.client_id))
            AND old.digest=(s->>'baselineCaseDigest') AND old.digest=hm_buyer_binding_digest(old.snapshot)
            AND old.snapshot->>'sourceChecksum'=s->>'originalSourceChecksum' AND old.snapshot->>'commissionGross'=s->>'originalCommissionGross'
            AND od.version=old.version AND od.case_digest=old.digest AND od.decision='APPROVE'
            AND od.decision_digest=s->>'baselineDecisionDigest' AND od.actor_user_id<>old.created_by_user_id
            AND od.occurred_at<lc.occurred_at
            AND s->>'correctionFactChecksum'=hm_buyer_binding_digest(jsonb_build_object(
              'schema','HANDYMAN_BM_CORRECTION_FACT_V1','id',e.id::text,'entitlementId',f.id::text,
              'ledgerCorrectionId',lc.id::text,'factKind',e.fact_kind,'recordedAmount',e.amount::text,
              'signedAmount','-'||e.amount::text,'actorUserId',e.actor_user_id::text,
              'occurredAt',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'idempotencyKey',e.idempotency_key,'sourceVersion','CR-HM-14-PART-02'))
            AND (s->>'ppnTaxPointAt')::timestamptz>=f.ledger_posted_at
            AND (s->>'pphTaxPointAt')::timestamptz>=f.ledger_posted_at
            AND ((s->>'ppnTaxPointAt')::timestamptz AT TIME ZONE 'Asia/Jakarta')::date=(s->>'ppnTaxDate')::date
            AND ((s->>'pphTaxPointAt')::timestamptz AT TIME ZONE 'Asia/Jakarta')::date=(s->>'pphTaxDate')::date)
          AND hm_bm_tax_case_rule_ok(s||jsonb_build_object('schema','HANDYMAN_BM_TAX_CASE_V2'),'ppn','PPN')
          AND hm_bm_tax_case_rule_ok(s||jsonb_build_object('schema','HANDYMAN_BM_TAX_CASE_V2'),'pph','PPH_WITHHOLDING')
          AND hm_bm_tax_case_identity_ok(s,'ppnBeneficiary','BM_BENEFICIARY','ppnTaxPointAt')
          AND hm_bm_tax_case_identity_ok(s,'ppnIssuer','HANDYMAN_ISSUER','ppnTaxPointAt')
          AND hm_bm_tax_case_identity_ok(s,'pphBeneficiary','BM_BENEFICIARY','pphTaxPointAt');
      $$;

      CREATE FUNCTION hm_bm_correction_tax_case_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE p handyman_bm_correction_tax_cases%ROWTYPE; s JSONB:=NEW.snapshot;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Correction tax writes require READ COMMITTED.' USING ERRCODE='23514'; END IF;
        PERFORM 1 FROM handyman_customer_transactions t JOIN handyman_entitlement_facts f ON f.transaction_id=t.id WHERE f.id=NEW.entitlement_id FOR UPDATE OF t;
        PERFORM 1 FROM handyman_entitlement_corrections WHERE id=NEW.correction_id FOR UPDATE;
        SELECT * INTO p FROM handyman_bm_correction_tax_cases WHERE correction_id=NEW.correction_id ORDER BY version DESC LIMIT 1;
        PERFORM profile_id FROM handyman_tax_identity_windows WHERE profile_id=ANY(ARRAY[
          (s->>'ppnBeneficiaryProfileId')::uuid,(s->>'ppnIssuerProfileId')::uuid,(s->>'pphBeneficiaryProfileId')::uuid]) ORDER BY profile_id FOR SHARE;
        PERFORM i.id FROM handyman_document_issuer_profiles i JOIN handyman_tax_identity_profiles x ON x.issuer_profile_id=i.id
          WHERE x.id=(s->>'ppnIssuerProfileId')::uuid FOR SHARE OF i;
        PERFORM rule_id FROM handyman_tax_rule_windows WHERE rule_id=ANY(ARRAY[
          (s->>'ppnRuleId')::uuid,(s->>'pphRuleId')::uuid]) ORDER BY rule_id FOR SHARE;
        IF NEW.version<>COALESCE(p.version,0)+1 OR NEW.previous_case_id IS DISTINCT FROM p.id
          OR (p.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM handyman_bm_correction_tax_decisions WHERE case_id=p.id))
          OR NOT hm_buyer_actor_allowed(NEW.created_by_user_id,NEW.client_id,NEW.building_id,'handyman.finance.read')
          OR NOT hm_buyer_actor_allowed(NEW.created_by_user_id,NEW.client_id,NEW.building_id,'handyman.finance.manage')
          OR s->>'schema' IS DISTINCT FROM 'HANDYMAN_BM_CORRECTION_TAX_CASE_V1' OR s->>'id' IS DISTINCT FROM NEW.id::text
          OR s->>'version' IS DISTINCT FROM NEW.version::text OR s->>'previousCaseId' IS DISTINCT FROM NEW.previous_case_id::text
          OR s->>'correctionFactId' IS DISTINCT FROM NEW.correction_id::text OR s->>'entitlementId' IS DISTINCT FROM NEW.entitlement_id::text
          OR s->>'clientId' IS DISTINCT FROM NEW.client_id::text OR s->>'buildingId' IS DISTINCT FROM NEW.building_id::text
          OR s->>'createdByUserId' IS DISTINCT FROM NEW.created_by_user_id::text OR s->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key
          OR NEW.digest IS DISTINCT FROM hm_bm_correction_tax_digest(s) OR jsonb_typeof(s->'intent') IS DISTINCT FROM 'object'
          OR NOT COALESCE((s->>'sourceChecksum') ~ '^[0-9a-f]{64}$' AND (s->>'intentDigest') ~ '^[0-9a-f]{64}$'
            AND (s->>'lineageChecksum') ~ '^[0-9a-f]{64}$' AND (s->>'originalAnchorChecksum') ~ '^[0-9a-f]{64}$',false)
          OR NOT COALESCE(s->>'ppnAmountBasis'='PPN_EXCLUSIVE' AND s->>'ppnApplicability' IN ('TAXABLE','EXEMPT','NON_TAXABLE','NOT_APPLICABLE')
            AND s->>'pphTreatment' IN ('WITHHOLD','EXEMPT','NON_WITHHOLD','NOT_APPLICABLE'),false)
          OR NOT COALESCE(CASE s->>'ppnApplicability' WHEN 'NOT_APPLICABLE' THEN true
            WHEN 'TAXABLE' THEN starts_with(s->>'ppnTaxpayerClassification','P02A_TAX_')
            WHEN 'EXEMPT' THEN starts_with(s->>'ppnTaxpayerClassification','P02A_EXEMPT_')
            WHEN 'NON_TAXABLE' THEN starts_with(s->>'ppnTaxpayerClassification','P02A_NON_TAX_') ELSE false END,false)
          OR NOT COALESCE(CASE s->>'pphTreatment' WHEN 'NOT_APPLICABLE' THEN true
            WHEN 'WITHHOLD' THEN starts_with(s->>'pphTaxpayerClassification','P02B_TAX_')
            WHEN 'EXEMPT' THEN starts_with(s->>'pphTaxpayerClassification','P02B_EXEMPT_')
            WHEN 'NON_WITHHOLD' THEN starts_with(s->>'pphTaxpayerClassification','P02B_NON_WITHHOLD_') ELSE false END,false)
          OR NOT COALESCE((s->>'transactionEvidenceReferenceId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND (s->>'ppnEvidenceReferenceId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND (s->>'pphEvidenceReferenceId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)
          OR s->>'transactionEvidenceReferenceId' IN ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','ffffffff-ffff-ffff-ffff-ffffffffffff')
          OR s->>'ppnEvidenceReferenceId' IN ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','ffffffff-ffff-ffff-ffff-ffffffffffff')
          OR s->>'pphEvidenceReferenceId' IN ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','ffffffff-ffff-ffff-ffff-ffffffffffff')
          OR NOT COALESCE(hm_bm_correction_tax_sources_ok(s),false) THEN
          RAISE EXCEPTION 'Correction tax case requires current linked facts and approved scoped tax sources.' USING ERRCODE='23514'; END IF;
        NEW.created_at:=date_trunc('milliseconds',clock_timestamp()); RETURN NEW;
      END $$;
      CREATE TRIGGER hm_bm_correction_tax_case_insert BEFORE INSERT ON handyman_bm_correction_tax_cases
        FOR EACH ROW EXECUTE FUNCTION hm_bm_correction_tax_case_insert();

      CREATE FUNCTION hm_bm_correction_tax_decide() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE c handyman_bm_correction_tax_cases%ROWTYPE; latest UUID;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Correction tax writes require READ COMMITTED.' USING ERRCODE='23514'; END IF;
        PERFORM 1 FROM handyman_customer_transactions t JOIN handyman_entitlement_facts f ON f.transaction_id=t.id WHERE f.id=NEW.entitlement_id FOR UPDATE OF t;
        PERFORM 1 FROM handyman_entitlement_corrections WHERE id=NEW.correction_id FOR UPDATE;
        SELECT id INTO latest FROM handyman_bm_correction_tax_cases WHERE correction_id=NEW.correction_id ORDER BY version DESC LIMIT 1;
        SELECT * INTO c FROM handyman_bm_correction_tax_cases WHERE id=NEW.case_id;
        IF c.id IS NOT NULL AND NEW.decision='APPROVE' THEN
          PERFORM profile_id FROM handyman_tax_identity_windows WHERE profile_id=ANY(ARRAY[
            (c.snapshot->>'ppnBeneficiaryProfileId')::uuid,(c.snapshot->>'ppnIssuerProfileId')::uuid,
            (c.snapshot->>'pphBeneficiaryProfileId')::uuid]) ORDER BY profile_id FOR SHARE;
          PERFORM i.id FROM handyman_document_issuer_profiles i JOIN handyman_tax_identity_profiles x ON x.issuer_profile_id=i.id
            WHERE x.id=(c.snapshot->>'ppnIssuerProfileId')::uuid FOR SHARE OF i;
          PERFORM rule_id FROM handyman_tax_rule_windows WHERE rule_id=ANY(ARRAY[
            (c.snapshot->>'ppnRuleId')::uuid,(c.snapshot->>'pphRuleId')::uuid]) ORDER BY rule_id FOR SHARE;
        END IF;
        IF c.id IS NULL OR latest IS DISTINCT FROM NEW.case_id OR c.correction_id<>NEW.correction_id OR c.entitlement_id<>NEW.entitlement_id
          OR c.client_id<>NEW.client_id OR c.building_id<>NEW.building_id OR c.version<>NEW.version OR c.digest<>NEW.case_digest
          OR c.digest<>hm_bm_correction_tax_digest(c.snapshot) OR c.created_by_user_id=NEW.actor_user_id
          OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,NEW.client_id,NEW.building_id,'handyman.finance.read')
          OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,NEW.client_id,NEW.building_id,'handyman.bm_tax_case.approve')
          OR NEW.ppn_evidence_id::text IN ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','ffffffff-ffff-ffff-ffff-ffffffffffff')
          OR NEW.pph_evidence_id::text IN ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','ffffffff-ffff-ffff-ffff-ffffffffffff')
          OR (NEW.decision='APPROVE' AND NOT COALESCE(hm_bm_correction_tax_sources_ok(c.snapshot),false)) THEN
          RAISE EXCEPTION 'Correction tax decision requires an independent scoped checker and current sources.' USING ERRCODE='23514'; END IF;
        NEW.occurred_at:=GREATEST(date_trunc('milliseconds',clock_timestamp())+interval '1 millisecond',c.created_at+interval '1 millisecond');
        NEW.decision_digest:=hm_buyer_binding_digest(jsonb_build_object('id',NEW.id::text,'caseId',NEW.case_id::text,
          'clientId',NEW.client_id::text,'buildingId',NEW.building_id::text,'entitlementId',NEW.entitlement_id::text,
          'correctionFactId',NEW.correction_id::text,'version',NEW.version,'caseDigest',NEW.case_digest,'decision',NEW.decision,
          'ppnReviewEvidenceReferenceId',NEW.ppn_evidence_id::text,'pphReviewEvidenceReferenceId',NEW.pph_evidence_id::text,
          'actorUserId',NEW.actor_user_id::text,'occurredAt',to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
        RETURN NEW;
      END $$;
      CREATE TRIGGER hm_bm_correction_tax_decide BEFORE INSERT ON handyman_bm_correction_tax_decisions
        FOR EACH ROW EXECUTE FUNCTION hm_bm_correction_tax_decide();
    `);
  },
  async down(tx:PoolClient):Promise<void> {
    await tx.query('LOCK TABLE handyman_bm_correction_tax_cases, handyman_bm_correction_tax_decisions IN ACCESS EXCLUSIVE MODE');
    if((await tx.query('SELECT EXISTS(SELECT 1 FROM handyman_bm_correction_tax_cases) AS used')).rows[0].used)
      throw new Error('Refusing to remove populated BM correction tax approval history.');
    await tx.query(`DROP TABLE handyman_bm_correction_tax_decisions; DROP TABLE handyman_bm_correction_tax_cases;
      DROP FUNCTION hm_bm_correction_tax_decide(); DROP FUNCTION hm_bm_correction_tax_case_insert();
      DROP FUNCTION hm_bm_correction_tax_sources_ok(JSONB); DROP FUNCTION hm_bm_correction_tax_digest(JSONB);
      DROP FUNCTION hm_bm_correction_tax_canonical(JSONB);`);
  },
};
