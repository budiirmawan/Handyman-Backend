import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Extend 0500 without changing its stored snapshots, source checks or maker/checker history. */
export const migration0501HandymanBmTaxNonApplicability: Migration = {
  id: '0501_handyman_bm_tax_non_applicability',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`

      -- A citation/source is an assertion to be reviewed, not proof that the law applies.
      CREATE FUNCTION hm_bm_tax_legal_basis_text_ok(v TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
        SELECT COALESCE(char_length(v) BETWEEN 4 AND 512 AND v=btrim(v) AND v ~ '[A-Za-z]'
          AND v !~ '[[:cntrl:]]' AND lower(v) NOT IN
            ('unknown','none','unspecified','n/a','na','tbd','pending','default','null','not applicable'),false);
      $$;
      CREATE FUNCTION hm_bm_tax_case_not_applicable_ok(s JSONB, prefix TEXT, family TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
        SELECT COALESCE(s->>'schema'='HANDYMAN_BM_TAX_CASE_V2'
          AND ((prefix='ppn' AND family='PPN' AND s->>'ppnApplicability'='NOT_APPLICABLE')
            OR (prefix='pph' AND family='PPH_WITHHOLDING' AND s->>'pphTreatment'='NOT_APPLICABLE'))
          AND s->(prefix||'TaxpayerClassification')='null'::jsonb
          AND s->(prefix||'RuleId')='null'::jsonb AND s->(prefix||'RuleVersion')='null'::jsonb
          AND s->(prefix||'RuleDigest')='null'::jsonb AND s->(prefix||'RuleDecisionId')='null'::jsonb
          AND jsonb_typeof(s->(prefix||'LegalReference'))='string' AND jsonb_typeof(s->(prefix||'LegalSource'))='string'
          AND hm_bm_tax_legal_basis_text_ok(s->>(prefix||'LegalReference'))
          AND hm_bm_tax_legal_basis_text_ok(s->>(prefix||'LegalSource')),false);
      $$;

      CREATE FUNCTION hm_bm_tax_case_rule_ok_0500(s JSONB, prefix TEXT, family TEXT) RETURNS BOOLEAN LANGUAGE sql VOLATILE AS $$
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
      -- 0500 source verification still runs. Only an explicit, complete V2 assertion can replace a rule.
      CREATE OR REPLACE FUNCTION hm_bm_tax_case_rule_ok(s JSONB, prefix TEXT, family TEXT) RETURNS BOOLEAN LANGUAGE sql VOLATILE AS $$
        SELECT CASE WHEN s->>'schema'='HANDYMAN_BM_TAX_CASE_V2' AND
          ((prefix='ppn' AND family='PPN' AND s->>'ppnApplicability'='NOT_APPLICABLE') OR
           (prefix='pph' AND family='PPH_WITHHOLDING' AND s->>'pphTreatment'='NOT_APPLICABLE'))
        THEN hm_bm_tax_case_not_applicable_ok(s,prefix,family)
        ELSE hm_bm_tax_case_rule_ok_0500(s,prefix,family) END;
      $$;

      CREATE FUNCTION hm_bm_tax_case_insert_v2() RETURNS trigger LANGUAGE plpgsql AS $$
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
          OR s->>'schema' IS DISTINCT FROM 'HANDYMAN_BM_TAX_CASE_V2' OR s->>'id' IS DISTINCT FROM NEW.id::text
          OR s->>'version' IS DISTINCT FROM NEW.version::text OR s->>'previousCaseId' IS DISTINCT FROM NEW.previous_case_id::text
          OR s->>'entitlementId' IS DISTINCT FROM NEW.entitlement_id::text OR s->>'clientId' IS DISTINCT FROM NEW.client_id::text
          OR s->>'buildingId' IS DISTINCT FROM NEW.building_id::text OR s->>'createdByUserId' IS DISTINCT FROM NEW.created_by_user_id::text
          OR s->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key OR NEW.digest IS DISTINCT FROM hm_buyer_binding_digest(s)
          OR (SELECT count(*) FROM jsonb_object_keys(s))<>60 OR NOT s ?& ARRAY[
            'schema','id','version','previousCaseId','clientId','buildingId','entitlementId','executionScopeId','transactionId',
            'sourceChecksum','commissionGross','currency','commissionBasis','counterpartyId','verificationId','coverageId',
            'agreementId','agreementVersionId','agreementVersionNumber','transactionClassification','serviceClassification',
            'transactionEvidenceReferenceId','ppnTaxDate','ppnTaxPointAt','ppnAmountBasis','ppnApplicability','ppnTaxpayerClassification',
            'ppnEvidenceReferenceId','ppnRuleId','ppnRuleVersion','ppnRuleDigest','ppnRuleDecisionId','ppnBeneficiaryProfileId',
            'ppnBeneficiaryVersion','ppnBeneficiaryDigest','ppnBeneficiaryDecisionId','ppnIssuerProfileId','ppnIssuerVersion','ppnIssuerDigest',
            'ppnIssuerDecisionId','pphTaxDate','pphTaxPointAt','pphTreatment','pphTaxpayerClassification','pphEvidenceReferenceId',
            'pphRuleId','pphRuleVersion','pphRuleDigest','pphRuleDecisionId','pphBeneficiaryProfileId','pphBeneficiaryVersion',
            'pphBeneficiaryDigest','pphBeneficiaryDecisionId','createdByUserId','idempotencyKey','intentDigest',
            'ppnLegalReference','ppnLegalSource','pphLegalReference','pphLegalSource']
          OR EXISTS(SELECT 1 FROM jsonb_each(s) AS e(k,v) WHERE jsonb_typeof(v) IN ('object','array'))
          OR NOT COALESCE((s->>'intentDigest') ~ '^[0-9a-f]{64}$',false)
          OR NOT COALESCE((s->>'sourceChecksum') ~ '^[0-9a-f]{64}$',false)
          OR NOT COALESCE((s->>'transactionClassification') ~ '^[A-Z][A-Z0-9_]{1,63}$',false)
          OR NOT COALESCE((s->>'serviceClassification') ~ '^[A-Z][A-Z0-9_]{1,63}$',false)
          OR NOT COALESCE(s->>'ppnAmountBasis'='PPN_EXCLUSIVE',false)
          OR NOT COALESCE(s->>'ppnApplicability'='NOT_APPLICABLE' OR s->>'pphTreatment'='NOT_APPLICABLE',false)
          OR NOT COALESCE(CASE s->>'ppnApplicability'
            WHEN 'NOT_APPLICABLE' THEN hm_bm_tax_case_not_applicable_ok(s,'ppn','PPN')
            WHEN 'TAXABLE' THEN s->'ppnLegalReference'='null'::jsonb AND s->'ppnLegalSource'='null'::jsonb AND starts_with(s->>'ppnTaxpayerClassification','P02A_TAX_')
            WHEN 'EXEMPT' THEN s->'ppnLegalReference'='null'::jsonb AND s->'ppnLegalSource'='null'::jsonb AND starts_with(s->>'ppnTaxpayerClassification','P02A_EXEMPT_')
            WHEN 'NON_TAXABLE' THEN s->'ppnLegalReference'='null'::jsonb AND s->'ppnLegalSource'='null'::jsonb AND starts_with(s->>'ppnTaxpayerClassification','P02A_NON_TAX_')
            ELSE false END,false)
          OR NOT COALESCE(CASE s->>'pphTreatment'
            WHEN 'NOT_APPLICABLE' THEN hm_bm_tax_case_not_applicable_ok(s,'pph','PPH_WITHHOLDING')
            WHEN 'WITHHOLD' THEN s->'pphLegalReference'='null'::jsonb AND s->'pphLegalSource'='null'::jsonb AND starts_with(s->>'pphTaxpayerClassification','P02B_TAX_')
            WHEN 'EXEMPT' THEN s->'pphLegalReference'='null'::jsonb AND s->'pphLegalSource'='null'::jsonb AND starts_with(s->>'pphTaxpayerClassification','P02B_EXEMPT_')
            WHEN 'NON_WITHHOLD' THEN s->'pphLegalReference'='null'::jsonb AND s->'pphLegalSource'='null'::jsonb AND starts_with(s->>'pphTaxpayerClassification','P02B_NON_WITHHOLD_')
            ELSE false END,false)
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

      DROP TRIGGER hm_bm_tax_case_insert ON handyman_bm_tax_cases;
      CREATE TRIGGER hm_bm_tax_case_insert_v1 BEFORE INSERT ON handyman_bm_tax_cases
        FOR EACH ROW WHEN (NEW.snapshot->>'schema'='HANDYMAN_BM_TAX_CASE_V1') EXECUTE FUNCTION hm_bm_tax_case_insert();
      CREATE TRIGGER hm_bm_tax_case_insert_v2 BEFORE INSERT ON handyman_bm_tax_cases
        FOR EACH ROW WHEN (NEW.snapshot->>'schema' IS DISTINCT FROM 'HANDYMAN_BM_TAX_CASE_V1') EXECUTE FUNCTION hm_bm_tax_case_insert_v2();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    // Prevent an in-flight V2 insert from committing between the history check and trigger replacement.
    await tx.query('LOCK TABLE handyman_bm_tax_cases IN ACCESS EXCLUSIVE MODE');
    const used=await tx.query("SELECT EXISTS(SELECT 1 FROM handyman_bm_tax_cases WHERE snapshot->>'schema'='HANDYMAN_BM_TAX_CASE_V2') AS used");
    if(used.rows[0].used) throw new Error('Refusing to remove populated BM non-applicability case history.');
    await tx.query(`
      DROP TRIGGER hm_bm_tax_case_insert_v2 ON handyman_bm_tax_cases;
      DROP TRIGGER hm_bm_tax_case_insert_v1 ON handyman_bm_tax_cases;
      CREATE TRIGGER hm_bm_tax_case_insert BEFORE INSERT ON handyman_bm_tax_cases
        FOR EACH ROW EXECUTE FUNCTION hm_bm_tax_case_insert();

      CREATE OR REPLACE FUNCTION hm_bm_tax_case_rule_ok(s JSONB, prefix TEXT, family TEXT) RETURNS BOOLEAN LANGUAGE sql VOLATILE AS $$
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

      DROP FUNCTION hm_bm_tax_case_insert_v2();
      DROP FUNCTION hm_bm_tax_case_rule_ok_0500(JSONB,TEXT,TEXT);
      DROP FUNCTION hm_bm_tax_case_not_applicable_ok(JSONB,TEXT,TEXT);
      DROP FUNCTION hm_bm_tax_legal_basis_text_ok(TEXT);
    `);
  },
};
