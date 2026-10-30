import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Commission calculations only: no settlement, withholding, remittance or payment assertion. */
export const migration0503HandymanBmCommissionLedger: Migration = {
  id: '0503_handyman_bm_commission_ledger',
  async up(tx:PoolClient):Promise<void> {
    await tx.query(`
      -- These source writers now participate in the same ledger-row fence,
      -- including direct SQL inserts. No existing fact is changed.
      CREATE FUNCTION hm_bm_commission_source_lock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM 1 FROM handyman_customer_transactions WHERE id=NEW.transaction_id FOR UPDATE;
        RETURN NEW;
      END $$;
      CREATE TRIGGER a_hm_bm_commission_charge_lock BEFORE INSERT ON handyman_charge_lines
        FOR EACH ROW EXECUTE FUNCTION hm_bm_commission_source_lock();
      CREATE TRIGGER a_hm_bm_commission_event_lock BEFORE INSERT ON handyman_customer_transaction_events
        FOR EACH ROW EXECUTE FUNCTION hm_bm_commission_source_lock();
      CREATE TRIGGER a_hm_bm_commission_correction_lock BEFORE INSERT ON handyman_ledger_corrections
        FOR EACH ROW EXECUTE FUNCTION hm_bm_commission_source_lock();

      -- QC finalization uses scope -> variation. Posting uses scope -> ledger.
      CREATE FUNCTION hm_bm_commission_final_variation_lock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM 1 FROM handyman_execution_scopes WHERE id=NEW.execution_scope_id FOR UPDATE;
        RETURN NEW;
      END $$;
      CREATE TRIGGER a_hm_bm_commission_final_variation_insert BEFORE INSERT ON handyman_scope_variations
        FOR EACH ROW WHEN (NEW.status='FINAL_CHARGE_ELIGIBILITY')
        EXECUTE FUNCTION hm_bm_commission_final_variation_lock();
      CREATE TRIGGER a_hm_bm_commission_final_variation_update BEFORE UPDATE OF status ON handyman_scope_variations
        FOR EACH ROW WHEN (NEW.status='FINAL_CHARGE_ELIGIBILITY' AND OLD.status IS DISTINCT FROM NEW.status)
        EXECUTE FUNCTION hm_bm_commission_final_variation_lock();

      CREATE TABLE handyman_bm_commission_ledger (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        counterparty_id UUID NOT NULL REFERENCES handyman_bm_legal_counterparties(id),
        entitlement_id UUID NOT NULL REFERENCES handyman_entitlement_facts(id),
        correction_id UUID REFERENCES handyman_entitlement_corrections(id),
        original_case_id UUID NOT NULL REFERENCES handyman_bm_tax_cases(id),
        original_decision_id UUID NOT NULL REFERENCES handyman_bm_tax_case_decisions(id),
        correction_case_id UUID REFERENCES handyman_bm_correction_tax_cases(id),
        correction_decision_id UUID REFERENCES handyman_bm_correction_tax_decisions(id),
        previous_entry_id UUID REFERENCES handyman_bm_commission_ledger(id),
        entry_type TEXT NOT NULL CHECK(entry_type IN ('ORIGINAL','CORRECTION_ADJUSTMENT')),
        sequence INTEGER NOT NULL CHECK(sequence IN (1,2)),
        currency TEXT NOT NULL DEFAULT 'IDR' CHECK(currency='IDR'),
        gross NUMERIC(18,2) NOT NULL CHECK(gross>=0),
        ppn NUMERIC(18,2) NOT NULL CHECK(ppn>=0),
        pph_withholding_projection NUMERIC(18,2) NOT NULL CHECK(pph_withholding_projection>=0),
        net_payable NUMERIC(18,2) NOT NULL CHECK(net_payable>=0 AND net_payable=gross+ppn-pph_withholding_projection),
        gross_delta NUMERIC(18,2) NOT NULL,
        ppn_delta NUMERIC(18,2) NOT NULL,
        pph_delta NUMERIC(18,2) NOT NULL,
        net_delta NUMERIC(18,2) NOT NULL CHECK(net_delta=gross_delta+ppn_delta-pph_delta),
        source_checksum TEXT NOT NULL CHECK(source_checksum ~ '^[0-9a-f]{64}$'),
        projection_checksum TEXT NOT NULL CHECK(projection_checksum ~ '^[0-9a-f]{64}$'),
        intent_checksum TEXT NOT NULL CHECK(intent_checksum ~ '^[0-9a-f]{64}$'),
        idempotency_key TEXT NOT NULL CHECK(char_length(btrim(idempotency_key)) BETWEEN 1 AND 200 AND idempotency_key=btrim(idempotency_key)),
        snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
        digest TEXT NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
        created_by_user_id UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE(entitlement_id,sequence), UNIQUE(entitlement_id,idempotency_key), UNIQUE(correction_id),
        CHECK((entry_type='ORIGINAL' AND sequence=1 AND previous_entry_id IS NULL AND correction_id IS NULL
              AND correction_case_id IS NULL AND correction_decision_id IS NULL)
           OR (entry_type='CORRECTION_ADJUSTMENT' AND sequence=2 AND previous_entry_id IS NOT NULL AND correction_id IS NOT NULL
              AND correction_case_id IS NOT NULL AND correction_decision_id IS NOT NULL))
      );
      CREATE TRIGGER hm_bm_commission_ledger_immutable BEFORE UPDATE OR DELETE ON handyman_bm_commission_ledger
        FOR EACH ROW EXECUTE FUNCTION hm_bm_tax_case_immutable();

      -- Checksums, case authority, source freshness, sequence and exact deltas
      -- are database backstops. Tax arithmetic is supplied exclusively by the
      -- existing verified calculators in the scoped posting service.
      CREATE FUNCTION hm_bm_commission_ledger_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE f handyman_entitlement_facts%ROWTYPE; prior handyman_bm_commission_ledger%ROWTYPE;
        s JSONB; p JSONB:=NEW.snapshot->'projection'; pin JSONB:=NEW.snapshot->'approval';
        actual_case_digest TEXT; actual_decision_digest TEXT; current_case UUID; approved BOOLEAN;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN
          RAISE EXCEPTION 'BM commission ledger writes require READ COMMITTED.' USING ERRCODE='23514'; END IF;
        PERFORM 1 FROM handyman_execution_scopes scope JOIN handyman_entitlement_facts e ON e.execution_scope_id=scope.id
          WHERE e.id=NEW.entitlement_id AND e.client_id=NEW.client_id FOR UPDATE OF scope;
        SELECT * INTO f FROM handyman_entitlement_facts WHERE id=NEW.entitlement_id AND client_id=NEW.client_id;
        IF f.id IS NULL THEN RAISE EXCEPTION 'BM entitlement source missing.' USING ERRCODE='23514'; END IF;
        PERFORM 1 FROM handyman_customer_transactions WHERE id=f.transaction_id FOR UPDATE;
        SELECT * INTO prior FROM handyman_bm_commission_ledger WHERE entitlement_id=NEW.entitlement_id ORDER BY sequence DESC LIMIT 1;

        IF NEW.entry_type='ORIGINAL' THEN
          SELECT c.snapshot,c.digest,d.decision_digest,h.case_id,d.decision='APPROVE'
            INTO s,actual_case_digest,actual_decision_digest,current_case,approved
            FROM handyman_bm_tax_case_heads h JOIN handyman_bm_tax_cases c ON c.id=h.case_id
            JOIN handyman_bm_tax_case_decisions d ON d.id=h.decision_id AND d.case_id=c.id
           WHERE h.entitlement_id=NEW.entitlement_id AND c.id=NEW.original_case_id AND d.id=NEW.original_decision_id
             AND c.client_id=NEW.client_id AND c.building_id=NEW.building_id AND c.created_by_user_id<>d.actor_user_id;
          IF prior.id IS NOT NULL OR EXISTS(SELECT 1 FROM handyman_ledger_corrections WHERE transaction_id=f.transaction_id)
            OR EXISTS(SELECT 1 FROM handyman_scope_variations WHERE execution_scope_id=f.execution_scope_id AND status='FINAL_CHARGE_ELIGIBILITY')
            OR NEW.gross_delta<>NEW.gross OR NEW.ppn_delta<>NEW.ppn OR NEW.pph_delta<>NEW.pph_withholding_projection OR NEW.net_delta<>NEW.net_payable
            OR p->>'schema' IS DISTINCT FROM 'HANDYMAN_BM_COMMISSION_TAX_PROJECTION_V1'
            OR p#>>'{ppn,source,checksum}' IS DISTINCT FROM NEW.source_checksum
            OR p#>>'{pph,source,checksum}' IS DISTINCT FROM NEW.source_checksum
            OR p->>'netPayableProjection' IS DISTINCT FROM NEW.net_payable::text
            OR s->>'sourceChecksum' IS DISTINCT FROM NEW.source_checksum THEN
            RAISE EXCEPTION 'Original commission source is corrected, unlinked or already posted.' USING ERRCODE='23514'; END IF;
        ELSE
          SELECT c.snapshot,c.digest,d.decision_digest,
            (SELECT id FROM handyman_bm_correction_tax_cases WHERE correction_id=NEW.correction_id ORDER BY version DESC LIMIT 1),d.decision='APPROVE'
            INTO s,actual_case_digest,actual_decision_digest,current_case,approved
            FROM handyman_bm_correction_tax_cases c JOIN handyman_bm_correction_tax_decisions d ON d.case_id=c.id
           WHERE c.id=NEW.correction_case_id AND d.id=NEW.correction_decision_id AND c.correction_id=NEW.correction_id
             AND c.entitlement_id=NEW.entitlement_id AND c.client_id=NEW.client_id AND c.building_id=NEW.building_id
             AND c.created_by_user_id<>d.actor_user_id;
          IF prior.id IS NULL OR prior.entry_type<>'ORIGINAL' OR NEW.previous_entry_id IS DISTINCT FROM prior.id
            OR prior.original_case_id IS DISTINCT FROM NEW.original_case_id OR prior.original_decision_id IS DISTINCT FROM NEW.original_decision_id
            OR s->>'baselineCaseId' IS DISTINCT FROM prior.original_case_id::text
            OR s->>'baselineDecisionId' IS DISTINCT FROM prior.original_decision_id::text
            OR s->>'baselineCaseDigest' IS DISTINCT FROM prior.snapshot#>>'{approval,digest}'
            OR s->>'baselineDecisionDigest' IS DISTINCT FROM prior.snapshot#>>'{approval,decisionDigest}'
            OR s->>'originalSourceChecksum' IS DISTINCT FROM prior.source_checksum
            OR NEW.gross_delta<>NEW.gross-prior.gross OR NEW.ppn_delta<>NEW.ppn-prior.ppn
            OR NEW.pph_delta<>NEW.pph_withholding_projection-prior.pph_withholding_projection OR NEW.net_delta<>NEW.net_payable-prior.net_payable
            OR p->>'schema' IS DISTINCT FROM 'HANDYMAN_CORRECTED_BM_COMMISSION_TAX_PROJECTION_V1'
            OR p#>>'{source,checksum}' IS DISTINCT FROM NEW.source_checksum
            OR p#>>'{source,correctionFactId}' IS DISTINCT FROM NEW.correction_id::text
            OR p->>'netCommissionProjection' IS DISTINCT FROM NEW.net_payable::text
            OR s->>'sourceChecksum' IS DISTINCT FROM NEW.source_checksum THEN
            RAISE EXCEPTION 'Correction requires its pre-correction original ledger witness and matching approved baseline.' USING ERRCODE='23514'; END IF;
        END IF;
        IF s IS NULL OR approved IS DISTINCT FROM true OR current_case IS DISTINCT FROM (CASE WHEN NEW.correction_id IS NULL THEN NEW.original_case_id ELSE NEW.correction_case_id END)
          OR actual_case_digest IS DISTINCT FROM pin->>'digest' OR actual_decision_digest IS DISTINCT FROM pin->>'decisionDigest'
          OR pin->>'caseId' IS DISTINCT FROM current_case::text
          OR pin->>'decisionId' IS DISTINCT FROM (CASE WHEN NEW.correction_id IS NULL THEN NEW.original_decision_id ELSE NEW.correction_decision_id END)::text
          OR pin->>'version' IS DISTINCT FROM s->>'version' THEN
          RAISE EXCEPTION 'Current independently approved BM tax case is required.' USING ERRCODE='23514'; END IF;
        PERFORM profile_id FROM handyman_tax_identity_windows WHERE profile_id=ANY(ARRAY[
          (s->>'ppnBeneficiaryProfileId')::uuid,(s->>'ppnIssuerProfileId')::uuid,(s->>'pphBeneficiaryProfileId')::uuid]) ORDER BY profile_id FOR SHARE;
        PERFORM i.id FROM handyman_document_issuer_profiles i JOIN handyman_tax_identity_profiles x ON x.issuer_profile_id=i.id
          WHERE x.id=(s->>'ppnIssuerProfileId')::uuid FOR SHARE OF i;
        PERFORM rule_id FROM handyman_tax_rule_windows WHERE rule_id=ANY(ARRAY[(s->>'ppnRuleId')::uuid,(s->>'pphRuleId')::uuid]) ORDER BY rule_id FOR SHARE;
        PERFORM cov.id FROM handyman_bm_building_coverages cov JOIN handyman_commercial_agreement_versions v ON v.id=cov.agreement_version_id
          WHERE cov.id=(s->>'coverageId')::uuid AND v.id=(s->>'agreementVersionId')::uuid FOR SHARE OF cov,v;
        IF (s->>'ppnTaxPointAt')::timestamptz>clock_timestamp() OR (s->>'pphTaxPointAt')::timestamptz>clock_timestamp()
          OR NOT COALESCE(CASE WHEN NEW.correction_id IS NULL THEN hm_bm_tax_case_sources_ok(s) ELSE hm_bm_correction_tax_sources_ok(s) END,false)
          OR (CASE WHEN NEW.correction_id IS NULL THEN hm_buyer_binding_digest(s) ELSE hm_bm_correction_tax_digest(s) END) IS DISTINCT FROM actual_case_digest
          OR s->>'commissionGross' IS DISTINCT FROM NEW.gross::text OR s->>'counterpartyId' IS DISTINCT FROM NEW.counterparty_id::text
          OR s->>'buildingId' IS DISTINCT FROM NEW.building_id::text
          OR NEW.snapshot->>'schema' IS DISTINCT FROM 'HANDYMAN_BM_COMMISSION_LEDGER_V1'
          OR NEW.snapshot->>'currency' IS DISTINCT FROM 'IDR' OR p->>'currency' IS DISTINCT FROM 'IDR'
          OR NEW.snapshot#>>'{assertions,withholding}' IS DISTINCT FROM 'NOT_ASSERTED'
          OR NEW.snapshot#>>'{assertions,remittance}' IS DISTINCT FROM 'NOT_ASSERTED'
          OR NEW.snapshot#>>'{assertions,payment}' IS DISTINCT FROM 'NOT_ASSERTED'
          OR NEW.snapshot->>'id' IS DISTINCT FROM NEW.id::text OR NEW.snapshot->>'clientId' IS DISTINCT FROM NEW.client_id::text
          OR NEW.snapshot->>'buildingId' IS DISTINCT FROM NEW.building_id::text OR NEW.snapshot->>'counterpartyId' IS DISTINCT FROM NEW.counterparty_id::text
          OR NEW.snapshot->>'entitlementId' IS DISTINCT FROM NEW.entitlement_id::text OR NEW.snapshot->>'correctionFactId' IS DISTINCT FROM NEW.correction_id::text
          OR NEW.snapshot->>'previousEntryId' IS DISTINCT FROM NEW.previous_entry_id::text OR NEW.snapshot->>'entryType' IS DISTINCT FROM NEW.entry_type
          OR NEW.snapshot->>'sequence' IS DISTINCT FROM NEW.sequence::text OR NEW.snapshot->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key
          OR NEW.snapshot->>'createdByUserId' IS DISTINCT FROM NEW.created_by_user_id::text OR NEW.snapshot->>'intentChecksum' IS DISTINCT FROM NEW.intent_checksum
          OR NEW.snapshot->>'sourceChecksum' IS DISTINCT FROM NEW.source_checksum OR NEW.snapshot->>'projectionChecksum' IS DISTINCT FROM NEW.projection_checksum
          OR NEW.snapshot#>>'{amounts,gross}' IS DISTINCT FROM NEW.gross::text OR NEW.snapshot#>>'{amounts,ppn}' IS DISTINCT FROM NEW.ppn::text
          OR NEW.snapshot#>>'{amounts,pph}' IS DISTINCT FROM NEW.pph_withholding_projection::text OR NEW.snapshot#>>'{amounts,net}' IS DISTINCT FROM NEW.net_payable::text
          OR NEW.snapshot#>>'{delta,gross}' IS DISTINCT FROM NEW.gross_delta::text OR NEW.snapshot#>>'{delta,ppn}' IS DISTINCT FROM NEW.ppn_delta::text
          OR NEW.snapshot#>>'{delta,pph}' IS DISTINCT FROM NEW.pph_delta::text OR NEW.snapshot#>>'{delta,net}' IS DISTINCT FROM NEW.net_delta::text
          OR p->>'commissionGross' IS DISTINCT FROM NEW.gross::text OR p->>'ppnAmount' IS DISTINCT FROM NEW.ppn::text
          OR p->>'pphWithheld' IS DISTINCT FROM NEW.pph_withholding_projection::text
          OR p#>>'{ppn,sourceAmount}' IS DISTINCT FROM NEW.gross::text OR p#>>'{pph,commissionGross}' IS DISTINCT FROM NEW.gross::text
          OR p#>>'{ppn,taxPointAt}' IS DISTINCT FROM s->>'ppnTaxPointAt' OR p#>>'{pph,taxPointAt}' IS DISTINCT FROM s->>'pphTaxPointAt'
          OR p#>>'{ppn,rule,id}' IS DISTINCT FROM s->>'ppnRuleId' OR p#>>'{ppn,rule,digest}' IS DISTINCT FROM s->>'ppnRuleDigest'
          OR p#>>'{pph,rule,id}' IS DISTINCT FROM s->>'pphRuleId' OR p#>>'{pph,rule,digest}' IS DISTINCT FROM s->>'pphRuleDigest'
          OR p#>>'{ppn,supplier,profileId}' IS DISTINCT FROM s->>'ppnBeneficiaryProfileId'
          OR p#>>'{ppn,recipient,profileId}' IS DISTINCT FROM s->>'ppnIssuerProfileId'
          OR p#>>'{pph,beneficiaryTaxIdentity,profileId}' IS DISTINCT FROM s->>'pphBeneficiaryProfileId'
          OR p#>>'{ppn,determination,caseId}' IS DISTINCT FROM pin->>'caseId'
          OR p#>>'{ppn,determination,digest}' IS DISTINCT FROM pin->>'digest'
          OR p#>>'{ppn,determination,decisionId}' IS DISTINCT FROM pin->>'decisionId'
          OR p#>>'{ppn,determination,decisionDigest}' IS DISTINCT FROM pin->>'decisionDigest'
          OR p#>>'{pph,determination,caseId}' IS DISTINCT FROM pin->>'caseId'
          OR p#>>'{pph,determination,digest}' IS DISTINCT FROM pin->>'digest'
          OR p#>>'{pph,determination,decisionId}' IS DISTINCT FROM pin->>'decisionId'
          OR p#>>'{pph,determination,decisionDigest}' IS DISTINCT FROM pin->>'decisionDigest'
          OR hm_bm_correction_tax_digest((p->'ppn')-'checksum'-'checksumAlgorithm') IS DISTINCT FROM p#>>'{ppn,checksum}'
          OR hm_bm_correction_tax_digest((p->'pph')-'checksum'-'checksumAlgorithm') IS DISTINCT FROM p#>>'{pph,checksum}'
          OR p->>'checksum' IS DISTINCT FROM NEW.projection_checksum
          OR hm_bm_correction_tax_digest(p-'checksum'-'checksumAlgorithm') IS DISTINCT FROM NEW.projection_checksum
          OR hm_bm_correction_tax_digest(NEW.snapshot) IS DISTINCT FROM NEW.digest
          OR NOT hm_buyer_actor_allowed(NEW.created_by_user_id,NEW.client_id,NEW.building_id,'handyman.finance.read')
          OR NOT hm_buyer_actor_allowed(NEW.created_by_user_id,NEW.client_id,NEW.building_id,'handyman.finance.manage') THEN
          RAISE EXCEPTION 'BM commission ledger requires current verified sources, approval, calculation and scoped Finance authority.' USING ERRCODE='23514'; END IF;
        NEW.created_at:=clock_timestamp(); RETURN NEW;
      END $$;
      CREATE TRIGGER hm_bm_commission_ledger_insert BEFORE INSERT ON handyman_bm_commission_ledger
        FOR EACH ROW EXECUTE FUNCTION hm_bm_commission_ledger_insert();
    `);
  },
  async down(tx:PoolClient):Promise<void> {
    await tx.query('LOCK TABLE handyman_bm_commission_ledger IN ACCESS EXCLUSIVE MODE');
    if((await tx.query('SELECT EXISTS(SELECT 1 FROM handyman_bm_commission_ledger) AS used')).rows[0].used)
      throw new Error('Refusing to remove populated BM commission ledger history.');
    await tx.query(`DROP TABLE handyman_bm_commission_ledger; DROP FUNCTION hm_bm_commission_ledger_insert();
      DROP TRIGGER a_hm_bm_commission_final_variation_update ON handyman_scope_variations;
      DROP TRIGGER a_hm_bm_commission_final_variation_insert ON handyman_scope_variations;
      DROP FUNCTION hm_bm_commission_final_variation_lock();
      DROP TRIGGER a_hm_bm_commission_correction_lock ON handyman_ledger_corrections;
      DROP TRIGGER a_hm_bm_commission_event_lock ON handyman_customer_transaction_events;
      DROP TRIGGER a_hm_bm_commission_charge_lock ON handyman_charge_lines;
      DROP FUNCTION hm_bm_commission_source_lock();`);
  },
};
