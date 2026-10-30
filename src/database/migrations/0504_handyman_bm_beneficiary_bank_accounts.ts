import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** BM bank details are a separate master, not a payment or independent bank verification. */
export const migration0504HandymanBmBeneficiaryBankAccounts: Migration = {
  id: '0504_handyman_bm_beneficiary_bank_accounts',
  async up(tx:PoolClient):Promise<void> {
    for(const [code,name] of [
      ['handyman.bm_bank_account.manage','Propose BM beneficiary bank account changes'],
      ['handyman.bm_bank_account.approve','Approve or reject BM beneficiary bank account changes'],
    ]) await tx.query(`INSERT INTO permissions(id,code,name,status) VALUES($1,$2,$3,'ACTIVE')
      ON CONFLICT(code) DO NOTHING`,[randomUUID(),code,name]);
    await tx.query(`
      CREATE TABLE handyman_bm_bank_account_versions (
        id UUID PRIMARY KEY, bank_account_id UUID NOT NULL,
        client_id UUID NOT NULL REFERENCES clients(id),
        counterparty_id UUID NOT NULL REFERENCES handyman_bm_legal_counterparties(id),
        beneficiary_verification_id UUID NOT NULL,
        version INTEGER NOT NULL CHECK(version>0),
        previous_version_id UUID REFERENCES handyman_bm_bank_account_versions(id),
        proposal_type TEXT NOT NULL CHECK(proposal_type IN ('CONTENT','STATE')),
        bank_code TEXT NOT NULL CHECK(bank_code ~ '^[A-Z][A-Z0-9]{1,15}$'),
        bank_name TEXT NOT NULL CHECK(char_length(btrim(bank_name)) BETWEEN 1 AND 200 AND bank_name=btrim(bank_name) AND bank_name !~ '[[:cntrl:]]'),
        account_number TEXT NOT NULL CHECK(account_number ~ '^[A-Za-z0-9-]{4,34}$' AND account_number ~ '[0-9]'),
        account_holder_name TEXT NOT NULL CHECK(char_length(btrim(account_holder_name)) BETWEEN 1 AND 200
          AND account_holder_name=btrim(account_holder_name) AND account_holder_name !~ '[[:cntrl:]]'),
        currency VARCHAR(3) NOT NULL REFERENCES currencies(code),
        proposed_status TEXT NOT NULL CHECK(proposed_status IN ('ACTIVE','SUSPENDED')),
        is_default BOOLEAN NOT NULL CHECK(proposed_status='ACTIVE' OR NOT is_default),
        verification_reference TEXT NOT NULL CHECK(char_length(btrim(verification_reference)) BETWEEN 3 AND 300
          AND verification_reference=btrim(verification_reference) AND verification_reference !~ '[[:cntrl:]]'),
        evidence_reference TEXT NOT NULL CHECK(char_length(btrim(evidence_reference)) BETWEEN 3 AND 500
          AND evidence_reference=btrim(evidence_reference) AND evidence_reference !~ '[[:cntrl:]]'),
        idempotency_key TEXT NOT NULL CHECK(char_length(btrim(idempotency_key)) BETWEEN 1 AND 200
          AND idempotency_key=btrim(idempotency_key) AND idempotency_key !~ '[[:cntrl:]]'),
        created_by_user_id UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY(beneficiary_verification_id,counterparty_id) REFERENCES handyman_bm_counterparty_verifications(id,counterparty_id),
        UNIQUE(bank_account_id,version), UNIQUE(counterparty_id,idempotency_key), UNIQUE(previous_version_id),
        CHECK(position(upper(account_number) in upper(bank_code))=0 AND position(upper(account_number) in upper(bank_name))=0
          AND position(upper(account_number) in upper(account_holder_name))=0 AND position(upper(account_number) in upper(verification_reference))=0
          AND position(upper(account_number) in upper(evidence_reference))=0),
        CHECK((version=1 AND previous_version_id IS NULL AND bank_account_id=id AND proposal_type='CONTENT')
          OR (version>1 AND previous_version_id IS NOT NULL AND bank_account_id<>id))
      );
      CREATE INDEX hm_bm_bank_owner_idx ON handyman_bm_bank_account_versions(client_id,counterparty_id,bank_account_id,version DESC);
      CREATE TABLE handyman_bm_bank_account_decisions (
        id UUID PRIMARY KEY, proposal_id UUID NOT NULL UNIQUE REFERENCES handyman_bm_bank_account_versions(id),
        client_id UUID NOT NULL REFERENCES clients(id), counterparty_id UUID NOT NULL REFERENCES handyman_bm_legal_counterparties(id),
        bank_account_id UUID NOT NULL, version INTEGER NOT NULL CHECK(version>0),
        decision TEXT NOT NULL CHECK(decision IN ('APPROVE','REJECT')),
        evidence_reference TEXT NOT NULL CHECK(char_length(btrim(evidence_reference)) BETWEEN 3 AND 500
          AND evidence_reference=btrim(evidence_reference) AND evidence_reference !~ '[[:cntrl:]]'),
        actor_user_id UUID NOT NULL REFERENCES users(id), occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      CREATE FUNCTION hm_bm_bank_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'BM bank account versions and decisions are immutable.' USING ERRCODE='23514'; END $$;
      CREATE TRIGGER hm_bm_bank_version_immutable BEFORE UPDATE OR DELETE ON handyman_bm_bank_account_versions
        FOR EACH ROW EXECUTE FUNCTION hm_bm_bank_immutable();
      CREATE TRIGGER hm_bm_bank_decision_immutable BEFORE UPDATE OR DELETE ON handyman_bm_bank_account_decisions
        FOR EACH ROW EXECUTE FUNCTION hm_bm_bank_immutable();

      -- The existing verified beneficiary row serializes all proposals and
      -- decisions for that BM, including direct SQL and competing defaults.
      CREATE FUNCTION hm_bm_bank_version_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE latest handyman_bm_bank_account_versions%ROWTYPE; current_version handyman_bm_bank_account_versions%ROWTYPE;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN
          RAISE EXCEPTION 'BM bank account writes require READ COMMITTED.' USING ERRCODE='23514'; END IF;
        PERFORM 1 FROM handyman_bm_legal_counterparties p JOIN clients c ON c.id=p.client_id
          JOIN handyman_bm_counterparty_verifications proof ON proof.counterparty_id=p.id
          WHERE p.id=NEW.counterparty_id AND p.client_id=NEW.client_id AND c.status='ACTIVE'
            AND proof.id=NEW.beneficiary_verification_id AND proof.verified_at<=clock_timestamp() FOR UPDATE OF p;
        IF NOT FOUND OR NOT hm_tax_rule_actor_authorized(NEW.created_by_user_id,NEW.client_id,'handyman.finance.read')
          OR NOT hm_tax_rule_actor_authorized(NEW.created_by_user_id,NEW.client_id,'handyman.finance.manage')
          OR NOT hm_tax_rule_actor_authorized(NEW.created_by_user_id,NEW.client_id,'handyman.bm_bank_account.manage') THEN
          RAISE EXCEPTION 'An authorized maker and exact verified BM beneficiary are required.' USING ERRCODE='23514'; END IF;
        IF NEW.proposed_status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM currencies WHERE code=NEW.currency AND status='ACTIVE') THEN
          RAISE EXCEPTION 'An active currency is required for activation.' USING ERRCODE='23514'; END IF;
        SELECT * INTO latest FROM handyman_bm_bank_account_versions WHERE bank_account_id=NEW.bank_account_id ORDER BY version DESC LIMIT 1;
        IF latest.id IS NULL THEN
          IF NEW.version<>1 OR NEW.id<>NEW.bank_account_id OR NEW.previous_version_id IS NOT NULL
            OR NEW.proposal_type<>'CONTENT' OR NEW.proposed_status<>'ACTIVE' THEN
            RAISE EXCEPTION 'The first account version must be a new activation proposal.' USING ERRCODE='23514'; END IF;
        ELSE
          IF latest.client_id<>NEW.client_id OR latest.counterparty_id<>NEW.counterparty_id
            OR latest.beneficiary_verification_id<>NEW.beneficiary_verification_id
            OR NEW.version<>latest.version+1 OR NEW.previous_version_id IS DISTINCT FROM latest.id
            OR NOT EXISTS(SELECT 1 FROM handyman_bm_bank_account_decisions WHERE proposal_id=latest.id) THEN
            RAISE EXCEPTION 'BM bank version conflicts or attempts beneficiary substitution.' USING ERRCODE='23514'; END IF;
          IF NEW.proposal_type='STATE' THEN
            SELECT v.* INTO current_version FROM handyman_bm_bank_account_versions v
              JOIN handyman_bm_bank_account_decisions d ON d.proposal_id=v.id AND d.decision='APPROVE'
              WHERE v.bank_account_id=NEW.bank_account_id ORDER BY v.version DESC LIMIT 1;
            IF current_version.id IS NULL OR (NEW.proposed_status='SUSPENDED' AND current_version.proposed_status<>'ACTIVE')
              OR NEW.bank_code IS DISTINCT FROM current_version.bank_code OR NEW.bank_name IS DISTINCT FROM current_version.bank_name
              OR NEW.account_number IS DISTINCT FROM current_version.account_number OR NEW.account_holder_name IS DISTINCT FROM current_version.account_holder_name
              OR NEW.currency IS DISTINCT FROM current_version.currency OR NEW.verification_reference IS DISTINCT FROM current_version.verification_reference THEN
              RAISE EXCEPTION 'A state change must preserve the exact previously approved bank account.' USING ERRCODE='23514'; END IF;
          ELSIF NEW.proposed_status<>'ACTIVE' THEN
            RAISE EXCEPTION 'A content change is an activation proposal, not a suspension.' USING ERRCODE='23514'; END IF;
        END IF;
        NEW.created_at:=clock_timestamp(); RETURN NEW;
      END $$;
      CREATE TRIGGER hm_bm_bank_version_insert BEFORE INSERT ON handyman_bm_bank_account_versions
        FOR EACH ROW EXECUTE FUNCTION hm_bm_bank_version_insert();

      CREATE FUNCTION hm_bm_bank_decision_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v handyman_bm_bank_account_versions%ROWTYPE; latest UUID;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN
          RAISE EXCEPTION 'BM bank account decisions require READ COMMITTED.' USING ERRCODE='23514'; END IF;
        PERFORM 1 FROM handyman_bm_legal_counterparties p JOIN clients c ON c.id=p.client_id
          WHERE p.id=NEW.counterparty_id AND p.client_id=NEW.client_id AND c.status='ACTIVE' FOR UPDATE OF p;
        IF NOT FOUND THEN RAISE EXCEPTION 'The exact active Client and BM beneficiary are required.' USING ERRCODE='23514'; END IF;
        SELECT * INTO v FROM handyman_bm_bank_account_versions WHERE id=NEW.proposal_id;
        SELECT id INTO latest FROM handyman_bm_bank_account_versions WHERE bank_account_id=NEW.bank_account_id ORDER BY version DESC LIMIT 1;
        IF v.id IS NULL OR v.id IS DISTINCT FROM latest OR v.client_id<>NEW.client_id OR v.counterparty_id<>NEW.counterparty_id
          OR v.bank_account_id<>NEW.bank_account_id OR v.version<>NEW.version OR v.created_by_user_id=NEW.actor_user_id
          OR position(upper(v.account_number) in upper(NEW.evidence_reference))>0
          OR NOT hm_tax_rule_actor_authorized(NEW.actor_user_id,NEW.client_id,'handyman.finance.read')
          OR NOT hm_tax_rule_actor_authorized(NEW.actor_user_id,NEW.client_id,'handyman.bm_bank_account.approve') THEN
          RAISE EXCEPTION 'An independent authorized checker must decide the current exact BM account version.' USING ERRCODE='23514'; END IF;
        IF NEW.decision='APPROVE' AND v.proposed_status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM currencies WHERE code=v.currency AND status='ACTIVE') THEN
          RAISE EXCEPTION 'An active currency is required for activation.' USING ERRCODE='23514'; END IF;
        IF NEW.decision='APPROVE' AND v.proposed_status='ACTIVE' AND v.is_default AND EXISTS(
          SELECT 1 FROM handyman_bm_bank_account_versions x JOIN handyman_bm_bank_account_decisions d ON d.proposal_id=x.id AND d.decision='APPROVE'
          WHERE x.client_id=v.client_id AND x.counterparty_id=v.counterparty_id AND x.bank_account_id<>v.bank_account_id
            AND x.currency=v.currency AND x.proposed_status='ACTIVE' AND x.is_default
            AND NOT EXISTS(SELECT 1 FROM handyman_bm_bank_account_versions newer
              JOIN handyman_bm_bank_account_decisions nd ON nd.proposal_id=newer.id AND nd.decision='APPROVE'
              WHERE newer.bank_account_id=x.bank_account_id AND newer.version>x.version)
        ) THEN RAISE EXCEPTION 'This BM already has a default ACTIVE account for this currency.' USING ERRCODE='23514'; END IF;
        NEW.occurred_at:=clock_timestamp(); RETURN NEW;
      END $$;
      CREATE TRIGGER hm_bm_bank_decision_insert BEFORE INSERT ON handyman_bm_bank_account_decisions
        FOR EACH ROW EXECUTE FUNCTION hm_bm_bank_decision_insert();
    `);
  },
  async down(tx:PoolClient):Promise<void> {
    await tx.query('LOCK TABLE handyman_bm_bank_account_versions, handyman_bm_bank_account_decisions IN ACCESS EXCLUSIVE MODE');
    if((await tx.query('SELECT EXISTS(SELECT 1 FROM handyman_bm_bank_account_versions) AS used')).rows[0].used)
      throw new Error('Refusing to remove populated BM bank account history.');
    await tx.query(`DROP TABLE handyman_bm_bank_account_decisions; DROP TABLE handyman_bm_bank_account_versions;
      DROP FUNCTION hm_bm_bank_decision_insert(); DROP FUNCTION hm_bm_bank_version_insert(); DROP FUNCTION hm_bm_bank_immutable();`);
  },
};
