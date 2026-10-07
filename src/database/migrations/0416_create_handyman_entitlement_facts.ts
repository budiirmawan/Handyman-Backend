import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** CR-HM-14 PART 01: immutable EARNED fact anchors only.
 * No command/derivation path is published here. Later PARTs must gate on
 * the CR-HM-13 PART 06 read and CR-HM-12 PART 06 configuration read before
 * inserting; lifecycle transitions/corrections require separate facts.
 */
export const migration0416CreateHandymanEntitlementFacts: Migration = {
  id: '0416_create_handyman_entitlement_facts',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_entitlement_facts (
        id                         UUID PRIMARY KEY,
        client_id                  UUID NOT NULL REFERENCES clients (id),
        transaction_id             UUID NOT NULL,
        execution_scope_id         UUID NOT NULL REFERENCES handyman_execution_scopes (id),
        currency                   VARCHAR(3) NOT NULL,
        ledger_posted_at           TIMESTAMPTZ NOT NULL,
        ledger_contract_version    TEXT NOT NULL,
        entitlement_kind           TEXT NOT NULL,
        fact_state                 TEXT NOT NULL,
        basis_kind                 TEXT NOT NULL,
        charged_net                NUMERIC(18, 2) NOT NULL,
        labor_net                  NUMERIC(18, 2) NOT NULL,
        material_net               NUMERIC(18, 2) NOT NULL,
        adjusted_transaction_scope NUMERIC(18, 2) NOT NULL,
        amount                     NUMERIC(18, 2) NOT NULL,
        assignment_id              UUID REFERENCES handyman_execution_scope_assignments (id),
        provider_context_id        UUID REFERENCES handyman_provider_contexts (id),
        crew_id                    UUID REFERENCES handyman_work_crews (id),
        lead_worker_id             UUID REFERENCES handyman_worker_contexts (id),
        lead_user_id               UUID REFERENCES users (id),
        agreement_id               UUID REFERENCES handyman_commercial_agreements (id),
        agreement_version_id       UUID REFERENCES handyman_commercial_agreement_versions (id),
        agreement_version_number   INTEGER,
        agreement_effective_from   TIMESTAMPTZ,
        agreement_effective_to     TIMESTAMPTZ,
        bm_rule_id                 UUID REFERENCES handyman_bm_fee_rule_definitions (id),
        bm_term_id                 UUID REFERENCES handyman_bm_fee_term_definitions (id),
        bm_term_rate_percent       NUMERIC(7, 4),
        bm_beneficiary_id          UUID REFERENCES handyman_bm_fee_beneficiary_definitions (id),
        bm_beneficiary_reference_id UUID REFERENCES clients (id),
        idempotency_key            TEXT NOT NULL UNIQUE,
        derived_by_user_id         UUID NOT NULL REFERENCES users (id),
        derived_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT hm_entitlement_tx_client_fk
          FOREIGN KEY (transaction_id, client_id)
          REFERENCES handyman_customer_transactions (id, client_id),
        CONSTRAINT hm_entitlement_tx_currency_fk
          FOREIGN KEY (transaction_id, currency)
          REFERENCES handyman_customer_transactions (id, currency),
        CONSTRAINT hm_entitlement_currency_check
          CHECK (currency IN ('IDR', 'USD', 'SGD', 'MYR', 'AUD',
                              'EUR', 'GBP', 'JPY', 'CNY')),
        CONSTRAINT hm_entitlement_contract_check
          CHECK (ledger_contract_version = 'CR-HM-13-PART-06'),
        CONSTRAINT hm_entitlement_kind_check
          CHECK (entitlement_kind IN ('PROVIDER', 'BM_FEE')),
        -- PART 03 owns subsequent states as separate transition facts.
        CONSTRAINT hm_entitlement_state_check CHECK (fact_state = 'EARNED'),
        CONSTRAINT hm_entitlement_basis_check
          CHECK ((entitlement_kind = 'PROVIDER' AND basis_kind = 'TRANSACTION_NET_CHARGED')
              OR (entitlement_kind = 'BM_FEE' AND basis_kind = 'LABOR_ONLY')),
        CONSTRAINT hm_entitlement_money_check
          CHECK (charged_net >= 0 AND labor_net >= 0 AND material_net >= 0
             AND adjusted_transaction_scope >= 0 AND amount >= 0
             AND amount <= charged_net
             AND (entitlement_kind <> 'BM_FEE' OR amount <= labor_net)),
        CONSTRAINT hm_entitlement_key_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT hm_entitlement_kind_anchors_check CHECK (
          (entitlement_kind = 'PROVIDER'
           AND assignment_id IS NOT NULL AND provider_context_id IS NOT NULL
           AND crew_id IS NOT NULL AND lead_worker_id IS NOT NULL
           AND lead_user_id IS NOT NULL
           AND agreement_id IS NULL AND agreement_version_id IS NULL
           AND agreement_version_number IS NULL
           AND agreement_effective_from IS NULL AND agreement_effective_to IS NULL
           AND bm_rule_id IS NULL AND bm_term_id IS NULL
           AND bm_term_rate_percent IS NULL AND bm_beneficiary_id IS NULL
           AND bm_beneficiary_reference_id IS NULL)
          OR
          (entitlement_kind = 'BM_FEE'
           AND assignment_id IS NULL AND provider_context_id IS NULL
           AND crew_id IS NULL AND lead_worker_id IS NULL AND lead_user_id IS NULL
           AND agreement_id IS NOT NULL AND agreement_version_id IS NOT NULL
           AND agreement_version_number IS NOT NULL
           AND agreement_effective_from IS NOT NULL
           AND bm_rule_id IS NOT NULL AND bm_term_id IS NOT NULL
           AND bm_term_rate_percent IS NOT NULL
           AND bm_beneficiary_id IS NOT NULL
           AND bm_beneficiary_reference_id IS NOT NULL)
        ),
        -- Stronger than the per-basis uniqueness: reassignment or a new
        -- rule cannot mint a second earned claim against the same ledger.
        -- Forward corrections belong to separate facts in a later PART.
        CONSTRAINT hm_entitlement_one_earned_per_kind
          UNIQUE (transaction_id, entitlement_kind)
      )
    `);
    await client.query(`
      CREATE INDEX hm_entitlement_client_idx
        ON handyman_entitlement_facts (client_id, derived_at, id)
    `);
    // FK existence alone cannot prove the *same* transaction, provider,
    // or agreement version. These guards validate anchors, not amounts or
    // derivation eligibility. Missing referents fall through to FK checks.
    await client.query(`
      CREATE FUNCTION handyman_entitlement_anchor_check()
      RETURNS trigger AS $$
      DECLARE
        tx handyman_customer_transactions%ROWTYPE;
        a handyman_execution_scope_assignments%ROWTYPE;
        v handyman_commercial_agreement_versions%ROWTYPE;
        agreement_client UUID;
        rule_version UUID;
        rule_mode TEXT;
        rule_basis TEXT;
        term_version UUID;
        term_kind TEXT;
        term_rate NUMERIC(7,4);
        beneficiary_version UUID;
        beneficiary_kind TEXT;
        beneficiary_ref UUID;
        lead_crew UUID;
        lead_worker UUID;
        lead_user UUID;
      BEGIN
        SELECT * INTO tx FROM handyman_customer_transactions WHERE id = NEW.transaction_id;
        IF FOUND AND (NEW.execution_scope_id IS DISTINCT FROM tx.execution_scope_id
                      OR NEW.ledger_posted_at IS DISTINCT FROM date_trunc('milliseconds', tx.created_at)) THEN
          RAISE EXCEPTION 'Entitlement ledger scope/posted instant mismatch.';
        END IF;
        IF NEW.entitlement_kind = 'PROVIDER' THEN
          SELECT * INTO a FROM handyman_execution_scope_assignments WHERE id = NEW.assignment_id;
          IF FOUND AND (a.client_id IS DISTINCT FROM NEW.client_id
                        OR a.execution_scope_id IS DISTINCT FROM NEW.execution_scope_id
                        OR a.handyman_provider_context_id IS DISTINCT FROM NEW.provider_context_id
                        OR a.handyman_crew_id IS DISTINCT FROM NEW.crew_id
                        OR a.status IS DISTINCT FROM 'ACTIVE') THEN
            RAISE EXCEPTION 'Entitlement assignment/provider/crew anchor mismatch.';
          END IF;
          SELECT m.handyman_crew_id, m.handyman_worker_context_id, p.user_id
            INTO lead_crew, lead_worker, lead_user
            FROM handyman_crew_leads l
            JOIN handyman_crew_memberships m ON m.id = l.handyman_crew_membership_id
            JOIN handyman_worker_contexts w ON w.id = m.handyman_worker_context_id
            JOIN workforce_profiles p ON p.id = w.workforce_profile_id
            WHERE l.id = (SELECT id FROM handyman_crew_leads
                           WHERE handyman_crew_id = NEW.crew_id
                           ORDER BY lead_seq DESC LIMIT 1);
          IF lead_crew IS NULL OR lead_crew IS DISTINCT FROM NEW.crew_id
             OR lead_worker IS DISTINCT FROM NEW.lead_worker_id
             OR lead_user IS DISTINCT FROM NEW.lead_user_id THEN
            RAISE EXCEPTION 'Entitlement lead snapshot mismatch.';
          END IF;
        ELSE
          SELECT * INTO v FROM handyman_commercial_agreement_versions
            WHERE id = NEW.agreement_version_id;
          SELECT client_id INTO agreement_client FROM handyman_commercial_agreements
            WHERE id = NEW.agreement_id;
          IF v.id IS NOT NULL AND
             (v.agreement_id IS DISTINCT FROM NEW.agreement_id
              OR v.version_number IS DISTINCT FROM NEW.agreement_version_number
              OR v.effective_from IS DISTINCT FROM NEW.agreement_effective_from
              OR v.effective_to IS DISTINCT FROM NEW.agreement_effective_to
              OR agreement_client IS DISTINCT FROM NEW.client_id
              OR NEW.ledger_posted_at < v.effective_from
              OR (v.effective_to IS NOT NULL AND NEW.ledger_posted_at >= v.effective_to)) THEN
            RAISE EXCEPTION 'Entitlement agreement binding mismatch.';
          END IF;
          SELECT agreement_version_id, mode, basis INTO rule_version, rule_mode, rule_basis
            FROM handyman_bm_fee_rule_definitions WHERE id = NEW.bm_rule_id;
          SELECT t.agreement_version_id, t.term_kind, t.rate_percent
            INTO term_version, term_kind, term_rate
            FROM handyman_bm_fee_term_definitions t WHERE t.id = NEW.bm_term_id;
          SELECT b.agreement_version_id, b.beneficiary_kind, b.beneficiary_reference_id
            INTO beneficiary_version, beneficiary_kind, beneficiary_ref
            FROM handyman_bm_fee_beneficiary_definitions b WHERE b.id = NEW.bm_beneficiary_id;
          IF rule_version IS DISTINCT FROM NEW.agreement_version_id
             OR rule_mode IS DISTINCT FROM 'DEFAULT' OR rule_basis IS DISTINCT FROM 'LABOR_ONLY'
             OR term_version IS DISTINCT FROM NEW.agreement_version_id
             OR term_kind IS DISTINCT FROM 'PERCENTAGE_OF_BASIS'
             OR term_rate IS DISTINCT FROM NEW.bm_term_rate_percent
             OR beneficiary_version IS DISTINCT FROM NEW.agreement_version_id
             OR beneficiary_kind IS DISTINCT FROM 'CLIENT_ORGANIZATION'
             OR beneficiary_ref IS DISTINCT FROM NEW.client_id
             OR beneficiary_ref IS DISTINCT FROM NEW.bm_beneficiary_reference_id THEN
            RAISE EXCEPTION 'Entitlement BM rule/term/beneficiary binding mismatch.';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER hm_entitlement_anchor_guard
        BEFORE INSERT ON handyman_entitlement_facts
        FOR EACH ROW EXECUTE FUNCTION handyman_entitlement_anchor_check()
    `);
    await client.query(`
      CREATE FUNCTION handyman_entitlement_no_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman entitlement facts are append-only.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER hm_entitlement_immutable
        BEFORE UPDATE OR DELETE ON handyman_entitlement_facts
        FOR EACH ROW EXECUTE FUNCTION handyman_entitlement_no_mutation()
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_entitlement_facts');
    await client.query('DROP FUNCTION IF EXISTS handyman_entitlement_anchor_check()');
    await client.query('DROP FUNCTION IF EXISTS handyman_entitlement_no_mutation()');
  },
};
