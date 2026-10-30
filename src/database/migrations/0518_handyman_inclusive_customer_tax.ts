import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Extend the existing immutable, independently verified classification to a
 * source-pinned inclusive invoice case. Existing V1 rows and guards remain
 * unchanged. No historical classification or financial fact is rewritten. */
export const migration0518HandymanInclusiveCustomerTax: Migration = {
  id: '0518_handyman_inclusive_customer_tax',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE OR REPLACE FUNCTION hm_customer_tax_class_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE h handyman_customer_tax_heads%ROWTYPE; bh handyman_buyer_binding_heads%ROWTYPE;
        b handyman_buyer_bindings%ROWTYPE; bd handyman_buyer_binding_decisions%ROWTYPE;
        r handyman_tax_rules%ROWTYPE; rw handyman_tax_rule_windows%ROWTYPE; rd handyman_tax_rule_approval_events%ROWTYPE;
      BEGIN
        SELECT * INTO h FROM handyman_customer_tax_heads WHERE request_id=NEW.request_id FOR UPDATE;
        SELECT * INTO bh FROM handyman_buyer_binding_heads WHERE request_id=NEW.request_id FOR SHARE;
        SELECT * INTO b FROM handyman_buyer_bindings WHERE id=NEW.buyer_binding_id;
        SELECT * INTO bd FROM handyman_buyer_binding_decisions WHERE id=NEW.buyer_decision_id;
        SELECT * INTO r FROM handyman_tax_rules WHERE id=NEW.rule_id;
        SELECT * INTO rw FROM handyman_tax_rule_windows WHERE rule_id=NEW.rule_id FOR SHARE;
        SELECT * INTO rd FROM handyman_tax_rule_approval_events WHERE id=NEW.rule_decision_id;
        IF h.request_id IS NULL OR h.client_id<>NEW.client_id OR h.building_id<>NEW.building_id
          OR NEW.version<>h.version+1 OR NEW.previous_classification_id IS DISTINCT FROM h.classification_id
          OR NOT hm_buyer_actor_allowed(NEW.created_by_user_id,NEW.client_id,NEW.building_id,'handyman.finance.manage')
          OR NOT hm_buyer_actor_allowed(NEW.created_by_user_id,NEW.client_id,NEW.building_id,'handyman.finance.read')
          OR NOT hm_buyer_actor_allowed(NEW.created_by_user_id,NEW.client_id,NEW.building_id,'handyman.customer_tax.read')
          OR bh.binding_id IS DISTINCT FROM b.id OR bh.decision_id IS DISTINCT FROM bd.id OR bd.decision IS DISTINCT FROM 'VERIFY'
          OR b.request_id IS DISTINCT FROM NEW.request_id OR b.client_id IS DISTINCT FROM NEW.client_id OR b.building_id IS DISTINCT FROM NEW.building_id
          OR bd.binding_id IS DISTINCT FROM b.id OR bd.binding_digest IS DISTINCT FROM b.digest OR bd.binding_version IS DISTINCT FROM b.version
          OR b.digest IS DISTINCT FROM hm_buyer_binding_digest(b.snapshot)
          OR r.id IS NULL OR r.client_id<>NEW.client_id OR r.transaction_context<>'CUSTOMER_SERVICE_BILLING' OR r.tax_code<>'PPN'
          OR rd.rule_id IS DISTINCT FROM r.id OR rd.event_type IS DISTINCT FROM 'APPROVE' OR rd.source_validation IS DISTINCT FROM 'FINANCE_VALIDATED'
          OR rd.rule_digest IS DISTINCT FROM hm_tax_rule_payload_digest(r.id) OR rd.rule_version IS DISTINCT FROM r.version
          OR rw.rule_id IS NULL OR rw.client_id<>NEW.client_id OR rw.transaction_context<>r.transaction_context
          OR rw.tax_code<>r.tax_code OR rw.taxpayer_classification<>r.taxpayer_classification
          OR (NEW.snapshot->>'taxDate')::date < rw.effective_from
          OR (rw.effective_to IS NOT NULL AND (NEW.snapshot->>'taxDate')::date >= rw.effective_to)
          OR bd.occurred_at > clock_timestamp() OR rd.occurred_at > clock_timestamp()
          OR bd.occurred_at > (NEW.snapshot->>'taxPointAt')::timestamptz OR rd.occurred_at > (NEW.snapshot->>'taxPointAt')::timestamptz
          OR NOT COALESCE((NEW.snapshot->>'schema'='HANDYMAN_CUSTOMER_TAX_V1' AND NEW.snapshot->>'amountBasis'='PPN_EXCLUSIVE')
            OR (NEW.snapshot->>'schema'='HANDYMAN_CUSTOMER_TAX_V2' AND NEW.snapshot->>'amountBasis'='PPN_INCLUSIVE'
              AND jsonb_typeof(NEW.snapshot->'invoice')='object'),false)
          OR NEW.snapshot->>'id' IS DISTINCT FROM NEW.id::text OR NEW.snapshot->>'version' IS DISTINCT FROM NEW.version::text
          OR NEW.snapshot->>'previousClassificationId' IS DISTINCT FROM NEW.previous_classification_id::text
          OR NEW.snapshot->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.snapshot->>'clientId' IS DISTINCT FROM NEW.client_id::text
          OR NEW.snapshot->>'buildingId' IS DISTINCT FROM NEW.building_id::text OR NEW.snapshot->>'createdByUserId' IS DISTINCT FROM NEW.created_by_user_id::text
          OR NEW.snapshot->>'buyerBindingId' IS DISTINCT FROM b.id::text OR NEW.snapshot->>'buyerBindingVersion' IS DISTINCT FROM b.version::text
          OR NEW.snapshot->>'buyerBindingDigest' IS DISTINCT FROM b.digest OR NEW.snapshot->>'buyerDecisionId' IS DISTINCT FROM bd.id::text
          OR NEW.snapshot->>'buyerDecisionDigest' IS DISTINCT FROM bd.decision_digest
          OR NEW.snapshot->>'buyerTenantCompanyId' IS DISTINCT FROM b.buyer_tenant_company_id::text
          OR NEW.snapshot->>'buyerKind' IS DISTINCT FROM b.snapshot->>'buyerKind'
          OR NEW.snapshot->>'ruleId' IS DISTINCT FROM r.id::text OR NEW.snapshot->>'ruleVersion' IS DISTINCT FROM r.version::text
          OR NEW.snapshot->>'ruleDigest' IS DISTINCT FROM rd.rule_digest OR NEW.snapshot->>'ruleDecisionId' IS DISTINCT FROM rd.id::text
          OR NEW.snapshot->>'taxpayerClassification' IS DISTINCT FROM r.taxpayer_classification
          OR NEW.snapshot->>'currency' IS DISTINCT FROM 'IDR'
          OR NOT COALESCE(NEW.snapshot->>'applicability' IN ('TAXABLE','EXEMPT','NON_TAXABLE'),false)
          OR NOT COALESCE((NEW.snapshot->>'sourceAmount') ~ '^(0|[1-9][0-9]{0,15})[.]00$',false)
          OR NOT COALESCE((NEW.snapshot->>'taxDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',false)
          OR NOT COALESCE((NEW.snapshot->>'taxPointAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$',false)
          OR NOT COALESCE((NEW.snapshot->>'transactionEvidenceReferenceId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)
          OR NEW.snapshot->>'transactionEvidenceReferenceId' IN ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','ffffffff-ffff-ffff-ffff-ffffffffffff')
          OR NOT COALESCE(NEW.snapshot->>'identifierKind' IN ('NPWP_15','NPWP_16','NIK_16','NIK_NPWP_16','PASSPORT','NONE'),false)
          OR NOT COALESCE((NEW.snapshot->>'identifierKind'='NONE' AND NEW.snapshot->>'identifierReferenceId' IS NULL)
            OR (NEW.snapshot->>'identifierKind'<>'NONE' AND (NEW.snapshot->>'identifierReferenceId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              AND NEW.snapshot->>'identifierReferenceId' NOT IN ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','ffffffff-ffff-ffff-ffff-ffffffffffff')),false)
          OR NOT COALESCE((NEW.snapshot->>'documentClass'='ORDINARY' AND NEW.snapshot->>'identifierKind'<>'NONE'
              AND NEW.snapshot->'retailSellerEligible'='null'::jsonb AND NEW.snapshot->'retailDirect'='null'::jsonb
              AND NEW.snapshot->'retailFinalConsumption'='null'::jsonb AND NEW.snapshot->'retailForResale'='null'::jsonb
              AND NEW.snapshot->'retailEvidenceReferenceId'='null'::jsonb)
            OR (NEW.snapshot->>'documentClass'='FINAL_CONSUMER' AND NEW.snapshot->'retailSellerEligible'='true'::jsonb
              AND NEW.snapshot->'retailDirect'='true'::jsonb AND NEW.snapshot->'retailFinalConsumption'='true'::jsonb
              AND NEW.snapshot->'retailForResale'='false'::jsonb
              AND (NEW.snapshot->>'retailEvidenceReferenceId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              AND NEW.snapshot->>'retailEvidenceReferenceId' NOT IN ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','ffffffff-ffff-ffff-ffff-ffffffffffff')),false)
          OR (SELECT count(*) FROM jsonb_object_keys(NEW.snapshot))<>(CASE WHEN NEW.snapshot->>'schema'='HANDYMAN_CUSTOMER_TAX_V2' THEN 37 ELSE 36 END)
          OR (NEW.snapshot->>'schema'='HANDYMAN_CUSTOMER_TAX_V1' AND NEW.snapshot ? 'invoice')
          OR NEW.snapshot - ARRAY['schema','id','version','previousClassificationId','clientId','buildingId','requestId','buyerTenantCompanyId',
              'buyerKind','buyerBindingId','buyerBindingVersion','buyerBindingDigest','buyerDecisionId','buyerDecisionDigest','ruleId','ruleVersion',
              'ruleDigest','ruleDecisionId','taxpayerClassification','applicability','taxDate','taxPointAt','currency','amountBasis','sourceAmount','documentClass',
              'identifierKind','identifierReferenceId','retailSellerEligible','retailDirect','retailFinalConsumption','retailForResale','retailEvidenceReferenceId',
              'transactionEvidenceReferenceId','distinctFromSupplier','createdByUserId','invoice']::text[] <> '{}'::jsonb
          OR EXISTS(SELECT 1 FROM jsonb_each(NEW.snapshot) x WHERE jsonb_typeof(x.value) IN ('object','array')
              AND NOT (NEW.snapshot->>'schema'='HANDYMAN_CUSTOMER_TAX_V2' AND x.key='invoice' AND jsonb_typeof(x.value)='object'))
          OR NEW.snapshot->'distinctFromSupplier' IS DISTINCT FROM 'true'::jsonb
          OR NEW.digest IS DISTINCT FROM (CASE WHEN NEW.snapshot->>'schema'='HANDYMAN_CUSTOMER_TAX_V2'
            THEN hm_bm_correction_tax_digest(NEW.snapshot) ELSE hm_buyer_binding_digest(NEW.snapshot) END) THEN
          RAISE EXCEPTION 'Classification requires the current reviewed buyer and exact Finance-approved rule.' USING ERRCODE='23514';
        END IF;
        NEW.created_at := date_trunc('milliseconds',clock_timestamp()) + interval '1 millisecond';
        RETURN NEW;
      END $$;
    `);
    await tx.query(`
      CREATE OR REPLACE FUNCTION hm_customer_tax_decision_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE h handyman_customer_tax_heads%ROWTYPE; c handyman_customer_tax_classifications%ROWTYPE;
        bh handyman_buyer_binding_heads%ROWTYPE;
      BEGIN
        SELECT * INTO h FROM handyman_customer_tax_heads WHERE request_id=NEW.request_id FOR UPDATE;
        SELECT * INTO c FROM handyman_customer_tax_classifications WHERE id=NEW.classification_id;
        SELECT * INTO bh FROM handyman_buyer_binding_heads WHERE request_id=NEW.request_id FOR SHARE;
        IF h.classification_id IS DISTINCT FROM NEW.classification_id OR h.decision_id IS NOT NULL OR c.id IS NULL
          OR h.client_id<>NEW.client_id OR h.building_id<>NEW.building_id OR h.version<>NEW.version
          OR c.client_id<>NEW.client_id OR c.building_id<>NEW.building_id OR c.request_id<>NEW.request_id OR c.version<>NEW.version
          OR c.digest<>NEW.classification_digest OR c.digest<>(CASE WHEN c.snapshot->>'schema'='HANDYMAN_CUSTOMER_TAX_V2' THEN hm_bm_correction_tax_digest(c.snapshot) ELSE hm_buyer_binding_digest(c.snapshot) END)
          OR bh.binding_id IS DISTINCT FROM c.buyer_binding_id OR bh.decision_id IS DISTINCT FROM c.buyer_decision_id
          OR c.created_by_user_id=NEW.actor_user_id
          OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,NEW.client_id,NEW.building_id,'handyman.finance.read')
          OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,NEW.client_id,NEW.building_id,'handyman.customer_tax.read')
          OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,NEW.client_id,NEW.building_id,'handyman.tax_identity.approve') THEN
          RAISE EXCEPTION 'Customer classification requires an independent scoped checker.' USING ERRCODE='23514';
        END IF;
        NEW.occurred_at := GREATEST(date_trunc('milliseconds',clock_timestamp()) + interval '1 millisecond',c.created_at + interval '1 millisecond');
        NEW.decision_digest := hm_buyer_binding_digest(jsonb_build_object(
          'id',NEW.id::text,'classificationId',NEW.classification_id::text,'requestId',NEW.request_id::text,
          'clientId',NEW.client_id::text,'buildingId',NEW.building_id::text,'version',NEW.version,'classificationDigest',NEW.classification_digest,
          'decision',NEW.decision,'evidenceReferenceId',NEW.evidence_reference_id::text,'actorUserId',NEW.actor_user_id::text,
          'occurredAt',to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ));
        RETURN NEW;
      END $$;
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    if ((await tx.query("SELECT 1 FROM handyman_customer_tax_classifications WHERE snapshot->>'schema'='HANDYMAN_CUSTOMER_TAX_V2' LIMIT 1")).rowCount)
      throw new Error('Cannot remove inclusive customer tax classification history.');
    await tx.query(`
      CREATE OR REPLACE FUNCTION hm_customer_tax_class_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE h handyman_customer_tax_heads%ROWTYPE; bh handyman_buyer_binding_heads%ROWTYPE;
        b handyman_buyer_bindings%ROWTYPE; bd handyman_buyer_binding_decisions%ROWTYPE;
        r handyman_tax_rules%ROWTYPE; rw handyman_tax_rule_windows%ROWTYPE; rd handyman_tax_rule_approval_events%ROWTYPE;
      BEGIN
        SELECT * INTO h FROM handyman_customer_tax_heads WHERE request_id=NEW.request_id FOR UPDATE;
        SELECT * INTO bh FROM handyman_buyer_binding_heads WHERE request_id=NEW.request_id FOR SHARE;
        SELECT * INTO b FROM handyman_buyer_bindings WHERE id=NEW.buyer_binding_id;
        SELECT * INTO bd FROM handyman_buyer_binding_decisions WHERE id=NEW.buyer_decision_id;
        SELECT * INTO r FROM handyman_tax_rules WHERE id=NEW.rule_id;
        SELECT * INTO rw FROM handyman_tax_rule_windows WHERE rule_id=NEW.rule_id FOR SHARE;
        SELECT * INTO rd FROM handyman_tax_rule_approval_events WHERE id=NEW.rule_decision_id;
        IF h.request_id IS NULL OR h.client_id<>NEW.client_id OR h.building_id<>NEW.building_id
          OR NEW.version<>h.version+1 OR NEW.previous_classification_id IS DISTINCT FROM h.classification_id
          OR NOT hm_buyer_actor_allowed(NEW.created_by_user_id,NEW.client_id,NEW.building_id,'handyman.finance.manage')
          OR NOT hm_buyer_actor_allowed(NEW.created_by_user_id,NEW.client_id,NEW.building_id,'handyman.finance.read')
          OR NOT hm_buyer_actor_allowed(NEW.created_by_user_id,NEW.client_id,NEW.building_id,'handyman.customer_tax.read')
          OR bh.binding_id IS DISTINCT FROM b.id OR bh.decision_id IS DISTINCT FROM bd.id OR bd.decision IS DISTINCT FROM 'VERIFY'
          OR b.request_id IS DISTINCT FROM NEW.request_id OR b.client_id IS DISTINCT FROM NEW.client_id OR b.building_id IS DISTINCT FROM NEW.building_id
          OR bd.binding_id IS DISTINCT FROM b.id OR bd.binding_digest IS DISTINCT FROM b.digest OR bd.binding_version IS DISTINCT FROM b.version
          OR b.digest IS DISTINCT FROM hm_buyer_binding_digest(b.snapshot)
          OR r.id IS NULL OR r.client_id<>NEW.client_id OR r.transaction_context<>'CUSTOMER_SERVICE_BILLING' OR r.tax_code<>'PPN'
          OR rd.rule_id IS DISTINCT FROM r.id OR rd.event_type IS DISTINCT FROM 'APPROVE' OR rd.source_validation IS DISTINCT FROM 'FINANCE_VALIDATED'
          OR rd.rule_digest IS DISTINCT FROM hm_tax_rule_payload_digest(r.id) OR rd.rule_version IS DISTINCT FROM r.version
          OR rw.rule_id IS NULL OR rw.client_id<>NEW.client_id OR rw.transaction_context<>r.transaction_context
          OR rw.tax_code<>r.tax_code OR rw.taxpayer_classification<>r.taxpayer_classification
          OR (NEW.snapshot->>'taxDate')::date < rw.effective_from
          OR (rw.effective_to IS NOT NULL AND (NEW.snapshot->>'taxDate')::date >= rw.effective_to)
          OR bd.occurred_at > clock_timestamp() OR rd.occurred_at > clock_timestamp()
          OR bd.occurred_at > (NEW.snapshot->>'taxPointAt')::timestamptz OR rd.occurred_at > (NEW.snapshot->>'taxPointAt')::timestamptz
          OR NEW.snapshot->>'schema' IS DISTINCT FROM 'HANDYMAN_CUSTOMER_TAX_V1'
          OR NEW.snapshot->>'id' IS DISTINCT FROM NEW.id::text OR NEW.snapshot->>'version' IS DISTINCT FROM NEW.version::text
          OR NEW.snapshot->>'previousClassificationId' IS DISTINCT FROM NEW.previous_classification_id::text
          OR NEW.snapshot->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.snapshot->>'clientId' IS DISTINCT FROM NEW.client_id::text
          OR NEW.snapshot->>'buildingId' IS DISTINCT FROM NEW.building_id::text OR NEW.snapshot->>'createdByUserId' IS DISTINCT FROM NEW.created_by_user_id::text
          OR NEW.snapshot->>'buyerBindingId' IS DISTINCT FROM b.id::text OR NEW.snapshot->>'buyerBindingVersion' IS DISTINCT FROM b.version::text
          OR NEW.snapshot->>'buyerBindingDigest' IS DISTINCT FROM b.digest OR NEW.snapshot->>'buyerDecisionId' IS DISTINCT FROM bd.id::text
          OR NEW.snapshot->>'buyerDecisionDigest' IS DISTINCT FROM bd.decision_digest
          OR NEW.snapshot->>'buyerTenantCompanyId' IS DISTINCT FROM b.buyer_tenant_company_id::text
          OR NEW.snapshot->>'buyerKind' IS DISTINCT FROM b.snapshot->>'buyerKind'
          OR NEW.snapshot->>'ruleId' IS DISTINCT FROM r.id::text OR NEW.snapshot->>'ruleVersion' IS DISTINCT FROM r.version::text
          OR NEW.snapshot->>'ruleDigest' IS DISTINCT FROM rd.rule_digest OR NEW.snapshot->>'ruleDecisionId' IS DISTINCT FROM rd.id::text
          OR NEW.snapshot->>'taxpayerClassification' IS DISTINCT FROM r.taxpayer_classification
          OR NEW.snapshot->>'currency' IS DISTINCT FROM 'IDR' OR NEW.snapshot->>'amountBasis' IS DISTINCT FROM 'PPN_EXCLUSIVE'
          OR NOT COALESCE(NEW.snapshot->>'applicability' IN ('TAXABLE','EXEMPT','NON_TAXABLE'),false)
          OR NOT COALESCE((NEW.snapshot->>'sourceAmount') ~ '^(0|[1-9][0-9]{0,15})[.]00$',false)
          OR NOT COALESCE((NEW.snapshot->>'taxDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',false)
          OR NOT COALESCE((NEW.snapshot->>'taxPointAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$',false)
          OR NOT COALESCE((NEW.snapshot->>'transactionEvidenceReferenceId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)
          OR NEW.snapshot->>'transactionEvidenceReferenceId' IN ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','ffffffff-ffff-ffff-ffff-ffffffffffff')
          OR NOT COALESCE(NEW.snapshot->>'identifierKind' IN ('NPWP_15','NPWP_16','NIK_16','NIK_NPWP_16','PASSPORT','NONE'),false)
          OR NOT COALESCE((NEW.snapshot->>'identifierKind'='NONE' AND NEW.snapshot->>'identifierReferenceId' IS NULL)
            OR (NEW.snapshot->>'identifierKind'<>'NONE' AND (NEW.snapshot->>'identifierReferenceId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              AND NEW.snapshot->>'identifierReferenceId' NOT IN ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','ffffffff-ffff-ffff-ffff-ffffffffffff')),false)
          OR NOT COALESCE((NEW.snapshot->>'documentClass'='ORDINARY' AND NEW.snapshot->>'identifierKind'<>'NONE'
              AND NEW.snapshot->'retailSellerEligible'='null'::jsonb AND NEW.snapshot->'retailDirect'='null'::jsonb
              AND NEW.snapshot->'retailFinalConsumption'='null'::jsonb AND NEW.snapshot->'retailForResale'='null'::jsonb
              AND NEW.snapshot->'retailEvidenceReferenceId'='null'::jsonb)
            OR (NEW.snapshot->>'documentClass'='FINAL_CONSUMER' AND NEW.snapshot->'retailSellerEligible'='true'::jsonb
              AND NEW.snapshot->'retailDirect'='true'::jsonb AND NEW.snapshot->'retailFinalConsumption'='true'::jsonb
              AND NEW.snapshot->'retailForResale'='false'::jsonb
              AND (NEW.snapshot->>'retailEvidenceReferenceId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              AND NEW.snapshot->>'retailEvidenceReferenceId' NOT IN ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','ffffffff-ffff-ffff-ffff-ffffffffffff')),false)
          OR (SELECT count(*) FROM jsonb_object_keys(NEW.snapshot))<>36
          OR NEW.snapshot - ARRAY['schema','id','version','previousClassificationId','clientId','buildingId','requestId','buyerTenantCompanyId',
              'buyerKind','buyerBindingId','buyerBindingVersion','buyerBindingDigest','buyerDecisionId','buyerDecisionDigest','ruleId','ruleVersion',
              'ruleDigest','ruleDecisionId','taxpayerClassification','applicability','taxDate','taxPointAt','currency','amountBasis','sourceAmount','documentClass',
              'identifierKind','identifierReferenceId','retailSellerEligible','retailDirect','retailFinalConsumption','retailForResale','retailEvidenceReferenceId',
              'transactionEvidenceReferenceId','distinctFromSupplier','createdByUserId']::text[] <> '{}'::jsonb
          OR EXISTS(SELECT 1 FROM jsonb_each(NEW.snapshot) x WHERE jsonb_typeof(x.value) IN ('object','array'))
          OR NEW.snapshot->'distinctFromSupplier' IS DISTINCT FROM 'true'::jsonb
          OR NEW.digest IS DISTINCT FROM hm_buyer_binding_digest(NEW.snapshot) THEN
          RAISE EXCEPTION 'Classification requires the current reviewed buyer and exact Finance-approved rule.' USING ERRCODE='23514';
        END IF;
        NEW.created_at := date_trunc('milliseconds',clock_timestamp()) + interval '1 millisecond';
        RETURN NEW;
      END $$;
    `);
    await tx.query(`
      CREATE OR REPLACE FUNCTION hm_customer_tax_decision_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE h handyman_customer_tax_heads%ROWTYPE; c handyman_customer_tax_classifications%ROWTYPE;
        bh handyman_buyer_binding_heads%ROWTYPE;
      BEGIN
        SELECT * INTO h FROM handyman_customer_tax_heads WHERE request_id=NEW.request_id FOR UPDATE;
        SELECT * INTO c FROM handyman_customer_tax_classifications WHERE id=NEW.classification_id;
        SELECT * INTO bh FROM handyman_buyer_binding_heads WHERE request_id=NEW.request_id FOR SHARE;
        IF h.classification_id IS DISTINCT FROM NEW.classification_id OR h.decision_id IS NOT NULL OR c.id IS NULL
          OR h.client_id<>NEW.client_id OR h.building_id<>NEW.building_id OR h.version<>NEW.version
          OR c.client_id<>NEW.client_id OR c.building_id<>NEW.building_id OR c.request_id<>NEW.request_id OR c.version<>NEW.version
          OR c.digest<>NEW.classification_digest OR c.digest<>hm_buyer_binding_digest(c.snapshot)
          OR bh.binding_id IS DISTINCT FROM c.buyer_binding_id OR bh.decision_id IS DISTINCT FROM c.buyer_decision_id
          OR c.created_by_user_id=NEW.actor_user_id
          OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,NEW.client_id,NEW.building_id,'handyman.finance.read')
          OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,NEW.client_id,NEW.building_id,'handyman.customer_tax.read')
          OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,NEW.client_id,NEW.building_id,'handyman.tax_identity.approve') THEN
          RAISE EXCEPTION 'Customer classification requires an independent scoped checker.' USING ERRCODE='23514';
        END IF;
        NEW.occurred_at := GREATEST(date_trunc('milliseconds',clock_timestamp()) + interval '1 millisecond',c.created_at + interval '1 millisecond');
        NEW.decision_digest := hm_buyer_binding_digest(jsonb_build_object(
          'id',NEW.id::text,'classificationId',NEW.classification_id::text,'requestId',NEW.request_id::text,
          'clientId',NEW.client_id::text,'buildingId',NEW.building_id::text,'version',NEW.version,'classificationDigest',NEW.classification_digest,
          'decision',NEW.decision,'evidenceReferenceId',NEW.evidence_reference_id::text,'actorUserId',NEW.actor_user_id::text,
          'occurredAt',to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ));
        RETURN NEW;
      END $$;
    `);
  },
};
