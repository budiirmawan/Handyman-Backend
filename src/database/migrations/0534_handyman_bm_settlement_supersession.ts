import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BM-SETTLEMENT-01 PART 01 — stale preparation supersession.
 *
 * A prepared BM settlement pins the entitlement, commission-ledger chain,
 * approved tax case and beneficiary bank version that were authoritative
 * at prepare time. When any of those move on, the preparation becomes
 * STALE but stayed permanently bound to the entitlement: `UNIQUE
 * (entitlement_id)` plus the immutable triggers made replacement
 * impossible, while approve/payment/verify correctly refused it. This
 * migration opens exactly one controlled replacement path and nothing
 * else:
 *
 *   - `handyman_bm_settlements.supersedes_settlement_id` links the NEW
 *     preparation to the one it replaces (UNIQUE: one successor per
 *     preparation, so concurrent or repeated supersession conflicts) and
 *     `supersession_reason` records the explicit maker reason. The
 *     original row, its approval, payment evidence and reviewer history
 *     are never UPDATEd or DELETEd (0505 immutability is untouched).
 *   - The blanket `UNIQUE (entitlement_id)` becomes a partial unique
 *     index over non-superseding rows: one live preparation per BM
 *     entitlement, while superseded history rows remain.
 *   - `hm_bm_settlement_prepare_guard` additionally requires a
 *     supersession insert to name an active, unfinalized predecessor of
 *     the exact Client/Building/entitlement (a predecessor with payment
 *     or verification — a finalized or settled payout — can never be
 *     replaced) and to carry the supersession pair in its digest-locked
 *     snapshot.
 *   - `hm_bm_settlement_action_guard` rejects approve/payment/evidence/
 *     verification inserts against a superseded preparation, so stale
 *     approvals and duplicate payouts fail closed at the database too.
 *
 * New preparations created by supersession carry no approval: fresh
 * independent approval (0505) must be granted again. No payment, SETTLED
 * state, bank-transfer evidence, permission or PDF is invented here.
 */
export const migration0534HandymanBmSettlementSupersession: Migration = {
  id: '0534_handyman_bm_settlement_supersession',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      ALTER TABLE handyman_bm_settlements
        DROP CONSTRAINT handyman_bm_settlements_entitlement_id_key
    `);
    await tx.query(`
      ALTER TABLE handyman_bm_settlements
        ADD COLUMN supersedes_settlement_id UUID
          REFERENCES handyman_bm_settlements (id),
        ADD COLUMN supersession_reason TEXT,
        ADD CONSTRAINT handyman_bm_settlement_supersession_pair CHECK (
          (supersedes_settlement_id IS NULL AND supersession_reason IS NULL)
          OR (supersedes_settlement_id IS NOT NULL
            AND supersession_reason IS NOT NULL
            AND supersession_reason = btrim(supersession_reason)
            AND char_length(supersession_reason) BETWEEN 3 AND 500)
        ),
        ADD CONSTRAINT handyman_bm_settlement_supersession_no_self CHECK (
          supersedes_settlement_id IS DISTINCT FROM id
        )
    `);
    // One successor per preparation: double or concurrent supersession
    // serializes on this unique index and the loser conflicts.
    await tx.query(`
      CREATE UNIQUE INDEX handyman_bm_settlement_supersession_unique
        ON handyman_bm_settlements (supersedes_settlement_id)
    `);
    // Exactly one non-superseding (live) preparation per entitlement;
    // superseded rows are append-only history and stay addressable.
    await tx.query(`
      CREATE UNIQUE INDEX handyman_bm_settlement_live_entitlement
        ON handyman_bm_settlements (entitlement_id)
        WHERE supersedes_settlement_id IS NULL
    `);

    // Replaces the 0505 prepare guard: same anchor/permission/snapshot
    // rules plus the predecessor and supersession-pair rules above.
    await tx.query(`
      CREATE OR REPLACE FUNCTION hm_bm_settlement_prepare_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE predecessor handyman_bm_settlements%ROWTYPE;
      BEGIN
        PERFORM hm_bm_settlement_lock(NEW);
        IF NEW.supersedes_settlement_id IS NOT NULL THEN
          SELECT * INTO predecessor FROM handyman_bm_settlements
            WHERE id = NEW.supersedes_settlement_id;
          IF predecessor.id IS NULL OR predecessor.client_id<>NEW.client_id
            OR predecessor.building_id<>NEW.building_id
            OR predecessor.entitlement_id<>NEW.entitlement_id
            OR EXISTS(SELECT 1 FROM handyman_bm_settlements n
              WHERE n.supersedes_settlement_id=predecessor.id) THEN
            RAISE EXCEPTION 'BM settlement supersession requires the one live predecessor preparation of the same Client, Building and entitlement.'
              USING ERRCODE='23514';
          END IF;
          IF EXISTS(SELECT 1 FROM handyman_bm_settlement_payments
              WHERE settlement_id=predecessor.id)
            OR EXISTS(SELECT 1 FROM handyman_bm_settlement_verifications
              WHERE settlement_id=predecessor.id) THEN
            RAISE EXCEPTION 'A finalized or settled BM payout can never be superseded.'
              USING ERRCODE='23514';
          END IF;
        END IF;
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
          OR NEW.snapshot->>'supersedesSettlementId' IS DISTINCT FROM NEW.supersedes_settlement_id::text
          OR NEW.snapshot->>'supersessionReason' IS DISTINCT FROM NEW.supersession_reason
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
    `);

    // Replaces the 0505 action guard: identical maker/checker/verifier
    // rules plus a fail-closed wall for superseded preparations. The
    // check runs after hm_bm_settlement_lock so it observes a committed
    // supersession that raced this action.
    await tx.query(`
      CREATE OR REPLACE FUNCTION hm_bm_settlement_action_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s handyman_bm_settlements%ROWTYPE; a handyman_bm_settlement_approvals%ROWTYPE;
        p handyman_bm_settlement_payments%ROWTYPE; r handyman_bm_settlement_evidence_reads%ROWTYPE;
      BEGIN
        IF TG_TABLE_NAME='handyman_bm_settlement_evidence_reads' THEN
          SELECT * INTO p FROM handyman_bm_settlement_payments WHERE id=NEW.payment_id;
          SELECT * INTO s FROM handyman_bm_settlements WHERE id=p.settlement_id;
        ELSE SELECT * INTO s FROM handyman_bm_settlements WHERE id=NEW.settlement_id; END IF;
        IF s.id IS NULL THEN RAISE EXCEPTION 'BM settlement not found.' USING ERRCODE='23514'; END IF;
        PERFORM hm_bm_settlement_lock(s);
        IF EXISTS(SELECT 1 FROM handyman_bm_settlements n
            WHERE n.supersedes_settlement_id=s.id) THEN
          RAISE EXCEPTION 'BM settlement preparation was superseded; its approval, payment and review history is closed.'
            USING ERRCODE='23514';
        END IF;
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
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      LOCK TABLE handyman_bm_settlements,handyman_bm_settlement_approvals,handyman_bm_settlement_payments,handyman_bm_settlement_evidence_reads,handyman_bm_settlement_verifications IN ACCESS EXCLUSIVE MODE`);
    if ((await tx.query(
      `SELECT EXISTS(SELECT 1 FROM handyman_bm_settlements WHERE supersedes_settlement_id IS NOT NULL) AS used`,
    )).rows[0].used) {
      throw new Error('Refusing to remove BM settlement supersession history.');
    }
    // The supersession columns are dropped, so both replaced guards go
    // back to their exact 0505 bodies first.
    await tx.query(`
      CREATE OR REPLACE FUNCTION hm_bm_settlement_prepare_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
    `);
    await tx.query(`
      CREATE OR REPLACE FUNCTION hm_bm_settlement_action_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
    `);
    await tx.query(`
      DROP INDEX handyman_bm_settlement_live_entitlement;
      DROP INDEX handyman_bm_settlement_supersession_unique;
      ALTER TABLE handyman_bm_settlements
        DROP CONSTRAINT handyman_bm_settlement_supersession_no_self,
        DROP CONSTRAINT handyman_bm_settlement_supersession_pair,
        DROP COLUMN supersession_reason,
        DROP COLUMN supersedes_settlement_id,
        ADD CONSTRAINT handyman_bm_settlements_entitlement_id_key UNIQUE (entitlement_id);
    `);
  },
};
