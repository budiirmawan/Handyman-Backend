import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** CR-HM-BM-COMMISSION-01 PART 01C.
 * Add a distinct legal BM variant without changing any legacy fact. The
 * existing Client and provider anchor functions remain the authority for
 * their rows; only the new variant takes the separate, exact-coverage path.
 * No fiscal profile, payable or settlement authority is introduced here.
 */
export const migration0494HandymanDistinctBmEntitlements: Migration = {
  id: '0494_handyman_distinct_bm_entitlements',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      -- Non-financial conflict claims: no historical rows are backfilled.
      -- Unique claims prevent stale REPEATABLE READ snapshots from allowing
      -- a distinct entitlement and settlement/fiscal facts to race through
      -- each other's otherwise-invisible INSERTs.
      CREATE TABLE handyman_bm_entitlement_guards (
        transaction_id UUID REFERENCES handyman_customer_transactions(id),
        entitlement_id UUID REFERENCES handyman_entitlement_facts(id) DEFERRABLE INITIALLY DEFERRED,
        guard_kind TEXT NOT NULL,
        CONSTRAINT hm_bm_guard_transaction_unique UNIQUE (transaction_id),
        CONSTRAINT hm_bm_guard_entitlement_unique UNIQUE (entitlement_id),
        CONSTRAINT hm_bm_guard_variant_check CHECK (
          (transaction_id IS NOT NULL AND entitlement_id IS NULL AND guard_kind IN ('DISTINCT', 'SETTLEMENT'))
          OR (transaction_id IS NULL AND entitlement_id IS NOT NULL AND guard_kind IN ('DISTINCT', 'FISCAL'))
        )
      );
      CREATE FUNCTION hm_bm_guard_no_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'BM entitlement conflict claims are immutable.' USING ERRCODE = '23514';
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_bm_guard_immutable BEFORE UPDATE OR DELETE ON handyman_bm_entitlement_guards
        FOR EACH ROW EXECUTE FUNCTION hm_bm_guard_no_mutation();
      CREATE FUNCTION hm_bm_transaction_claim(ledger_id UUID, requested TEXT) RETURNS void AS $$
      DECLARE actual TEXT;
      BEGIN
        INSERT INTO handyman_bm_entitlement_guards (transaction_id, guard_kind)
          VALUES (ledger_id, requested) ON CONFLICT (transaction_id) DO NOTHING;
        SELECT guard_kind INTO actual FROM handyman_bm_entitlement_guards WHERE transaction_id = ledger_id;
        IF actual IS DISTINCT FROM requested THEN
          IF requested = 'DISTINCT' THEN
            RAISE EXCEPTION 'Distinct BM entitlement cannot replace existing settlement history.' USING ERRCODE = '23514';
          END IF;
          RAISE EXCEPTION 'Distinct BM settlement is not supported.' USING ERRCODE = '23514';
        END IF;
      END; $$ LANGUAGE plpgsql;
      CREATE FUNCTION hm_bm_entitlement_claim(fact_id UUID, requested TEXT) RETURNS void AS $$
      DECLARE actual TEXT;
      BEGIN
        INSERT INTO handyman_bm_entitlement_guards (entitlement_id, guard_kind)
          VALUES (fact_id, requested) ON CONFLICT (entitlement_id) DO NOTHING;
        SELECT guard_kind INTO actual FROM handyman_bm_entitlement_guards WHERE entitlement_id = fact_id;
        IF actual IS DISTINCT FROM requested THEN
          RAISE EXCEPTION 'Distinct BM fiscal binding is not supported.' USING ERRCODE = '23514';
        END IF;
      END; $$ LANGUAGE plpgsql;
    `);
    await client.query(`
      ALTER TABLE handyman_entitlement_facts
        ADD COLUMN bm_beneficiary_kind TEXT,
        ADD COLUMN bm_counterparty_id UUID REFERENCES handyman_bm_legal_counterparties(id),
        ADD COLUMN bm_building_id UUID REFERENCES buildings(id),
        ADD COLUMN bm_coverage_id UUID REFERENCES handyman_bm_building_coverages(id),
        ADD COLUMN bm_verification_id UUID,
        ADD COLUMN bm_coverage_effective_from TIMESTAMPTZ,
        ADD COLUMN bm_coverage_effective_to TIMESTAMPTZ,
        ADD CONSTRAINT hm_entitlement_bm_verification_fk
          FOREIGN KEY (bm_verification_id, bm_counterparty_id)
          REFERENCES handyman_bm_counterparty_verifications(id, counterparty_id),
        DROP CONSTRAINT hm_entitlement_kind_anchors_check;

      ALTER TABLE handyman_entitlement_facts ADD CONSTRAINT hm_entitlement_kind_anchors_check
        CHECK (COALESCE((
          (entitlement_kind = 'PROVIDER'
           AND assignment_id IS NOT NULL AND provider_context_id IS NOT NULL
           AND crew_id IS NOT NULL AND lead_worker_id IS NOT NULL AND lead_user_id IS NOT NULL
           AND agreement_id IS NULL AND agreement_version_id IS NULL
           AND agreement_version_number IS NULL
           AND agreement_effective_from IS NULL AND agreement_effective_to IS NULL
           AND bm_rule_id IS NULL AND bm_term_id IS NULL AND bm_term_rate_percent IS NULL
           AND bm_beneficiary_id IS NULL AND bm_beneficiary_reference_id IS NULL
           AND bm_beneficiary_kind IS NULL AND bm_counterparty_id IS NULL
           AND bm_building_id IS NULL AND bm_coverage_id IS NULL AND bm_verification_id IS NULL
           AND bm_coverage_effective_from IS NULL AND bm_coverage_effective_to IS NULL)
          OR
          (entitlement_kind = 'BM_FEE'
           AND assignment_id IS NULL AND provider_context_id IS NULL
           AND crew_id IS NULL AND lead_worker_id IS NULL AND lead_user_id IS NULL
           AND agreement_id IS NOT NULL AND agreement_version_id IS NOT NULL
           AND agreement_version_number IS NOT NULL AND agreement_effective_from IS NOT NULL
           AND bm_rule_id IS NOT NULL AND bm_term_id IS NOT NULL AND bm_term_rate_percent IS NOT NULL
           AND (
             (bm_beneficiary_kind IS NULL AND bm_beneficiary_id IS NOT NULL
              AND bm_beneficiary_reference_id IS NOT NULL AND bm_counterparty_id IS NULL
              AND bm_building_id IS NULL AND bm_coverage_id IS NULL AND bm_verification_id IS NULL
              AND bm_coverage_effective_from IS NULL AND bm_coverage_effective_to IS NULL)
             OR
             (bm_beneficiary_kind = 'BM_LEGAL_COUNTERPARTY'
              AND bm_beneficiary_id IS NULL AND bm_beneficiary_reference_id IS NULL
              AND bm_counterparty_id IS NOT NULL AND bm_building_id IS NOT NULL
              AND bm_coverage_id IS NOT NULL AND bm_verification_id IS NOT NULL
              AND bm_coverage_effective_from IS NOT NULL
              AND (bm_coverage_effective_to IS NULL OR bm_coverage_effective_to > bm_coverage_effective_from))
           ))
        ), FALSE));

      -- Keep the original functions intact, including their legacy behavior.
      DROP TRIGGER hm_entitlement_anchor_guard ON handyman_entitlement_facts;
      CREATE TRIGGER hm_entitlement_anchor_guard BEFORE INSERT ON handyman_entitlement_facts
        FOR EACH ROW WHEN (NEW.bm_beneficiary_kind IS NULL)
        EXECUTE FUNCTION handyman_entitlement_anchor_check();
      DROP TRIGGER hm_bm_entitlement_coverage ON handyman_entitlement_facts;
      CREATE TRIGGER hm_bm_entitlement_coverage BEFORE INSERT ON handyman_entitlement_facts
        FOR EACH ROW WHEN (NEW.bm_beneficiary_kind IS NULL)
        EXECUTE FUNCTION hm_bm_entitlement_coverage_guard();
    `);
    await client.query(`
      CREATE FUNCTION hm_distinct_bm_entitlement_guard() RETURNS trigger AS $$
      DECLARE ledger_scope UUID; ledger_client UUID; posted TIMESTAMPTZ;
      BEGIN
        -- The same row lock is taken by settlement transitions. This also
        -- serializes direct SQL writers, not just the service commands.
        SELECT execution_scope_id, client_id, date_trunc('milliseconds', created_at)
          INTO ledger_scope, ledger_client, posted FROM handyman_customer_transactions
         WHERE id = NEW.transaction_id FOR UPDATE;
        IF ledger_scope IS DISTINCT FROM NEW.execution_scope_id
           OR ledger_client IS DISTINCT FROM NEW.client_id
           OR posted IS DISTINCT FROM NEW.ledger_posted_at THEN
          RAISE EXCEPTION 'Distinct BM entitlement ledger scope/posted instant mismatch.' USING ERRCODE = '23514';
        END IF;
        PERFORM hm_bm_transaction_claim(NEW.transaction_id, 'DISTINCT');
        PERFORM hm_bm_entitlement_claim(NEW.id, 'DISTINCT');
        IF EXISTS (SELECT 1 FROM handyman_settlement_units u
                   JOIN handyman_settlement_events e ON e.unit_id = u.id
                   WHERE u.transaction_id = NEW.transaction_id)
           OR EXISTS (SELECT 1 FROM handyman_settlement_units u
                      JOIN handyman_settlement_inclusions i ON i.unit_id = u.id
                      WHERE u.transaction_id = NEW.transaction_id) THEN
          RAISE EXCEPTION 'Distinct BM entitlement cannot replace existing settlement history.' USING ERRCODE = '23514';
        END IF;
        -- Existing fiscal profiles are agreement-version scoped, not bound
        -- to this legal identity. Do not apply them to the new variant.
        IF EXISTS (SELECT 1 FROM handyman_execution_scopes s
                   JOIN handyman_financial_tax_profiles tax
                     ON tax.quotation_version_id = s.approved_quotation_version_id
                   WHERE s.id = NEW.execution_scope_id) THEN
          RAISE EXCEPTION 'Distinct BM fiscal binding is not supported.' USING ERRCODE = '23514';
        END IF;
        PERFORM 1 FROM handyman_execution_scopes s
          JOIN buildings b ON b.id = s.building_id
          JOIN properties p ON p.id = b.property_id AND p.client_id = s.client_id
          JOIN handyman_bm_building_coverages c
            ON c.id = NEW.bm_coverage_id AND c.client_id = s.client_id AND c.building_id = s.building_id
          JOIN handyman_bm_legal_counterparties party
            ON party.id = c.counterparty_id AND party.client_id = c.client_id
          JOIN handyman_bm_counterparty_verifications x
            ON x.id = c.verification_id AND x.counterparty_id = party.id
          JOIN handyman_commercial_agreement_versions v ON v.id = c.agreement_version_id
          JOIN handyman_commercial_agreements a ON a.id = v.agreement_id AND a.client_id = s.client_id
          JOIN handyman_bm_fee_rule_definitions r ON r.id = NEW.bm_rule_id AND r.agreement_version_id = v.id
          JOIN handyman_bm_fee_term_definitions t ON t.id = NEW.bm_term_id AND t.agreement_version_id = v.id
         WHERE s.id = NEW.execution_scope_id AND s.client_id = NEW.client_id
           AND s.building_id = NEW.bm_building_id
           AND c.cancelled_at IS NULL AND c.beneficiary_kind = 'BM_LEGAL_COUNTERPARTY'
           AND c.beneficiary_definition_id IS NULL AND party.represented_client_id IS NULL
           AND c.counterparty_id = NEW.bm_counterparty_id AND c.verification_id = NEW.bm_verification_id
           AND c.agreement_version_id = NEW.agreement_version_id
           AND c.effective_from IS NOT DISTINCT FROM NEW.bm_coverage_effective_from
           AND c.effective_to IS NOT DISTINCT FROM NEW.bm_coverage_effective_to
           AND c.effective_from <= NEW.ledger_posted_at
           AND (c.effective_to IS NULL OR NEW.ledger_posted_at < c.effective_to)
           AND x.verified_at <= NEW.ledger_posted_at
           AND v.status IN ('ACTIVE', 'SUPERSEDED') AND v.agreement_id = NEW.agreement_id
           AND v.version_number = NEW.agreement_version_number
           AND v.effective_from IS NOT DISTINCT FROM NEW.agreement_effective_from
           AND v.effective_to IS NOT DISTINCT FROM NEW.agreement_effective_to
           AND v.effective_from <= NEW.ledger_posted_at
           AND (v.effective_to IS NULL OR NEW.ledger_posted_at < v.effective_to)
           AND r.mode = 'DEFAULT' AND r.basis = 'LABOR_ONLY'
           AND t.term_kind = 'PERCENTAGE_OF_BASIS' AND t.rate_percent = NEW.bm_term_rate_percent
         FOR SHARE OF c, v, b, p;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Exact verified distinct BM Client/Building/version coverage required for entitlement.' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_distinct_bm_entitlement BEFORE INSERT ON handyman_entitlement_facts
        FOR EACH ROW WHEN (NEW.bm_beneficiary_kind = 'BM_LEGAL_COUNTERPARTY')
        EXECUTE FUNCTION hm_distinct_bm_entitlement_guard();
    `);
    await client.query(`
      CREATE FUNCTION hm_distinct_bm_settlement_guard() RETURNS trigger AS $$
      DECLARE ledger_id UUID;
      BEGIN
        SELECT transaction_id INTO ledger_id FROM handyman_settlement_units WHERE id = NEW.unit_id;
        IF ledger_id IS NULL THEN RETURN NEW; END IF; -- the existing FK supplies the missing-unit error
        PERFORM 1 FROM handyman_customer_transactions WHERE id = ledger_id FOR UPDATE;
        PERFORM hm_bm_transaction_claim(ledger_id, 'SETTLEMENT');
        IF EXISTS (SELECT 1 FROM handyman_entitlement_facts f
                   WHERE f.transaction_id = ledger_id AND f.bm_beneficiary_kind = 'BM_LEGAL_COUNTERPARTY') THEN
          RAISE EXCEPTION 'Distinct BM settlement is not supported.' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER a_hm_distinct_bm_settlement_event BEFORE INSERT ON handyman_settlement_events
        FOR EACH ROW EXECUTE FUNCTION hm_distinct_bm_settlement_guard();
      CREATE TRIGGER a_hm_distinct_bm_settlement_inclusion BEFORE INSERT ON handyman_settlement_inclusions
        FOR EACH ROW EXECUTE FUNCTION hm_distinct_bm_settlement_guard();

      CREATE FUNCTION hm_distinct_bm_fiscal_guard() RETURNS trigger AS $$
      BEGIN
        IF NEW.entitlement_id IS NULL THEN RETURN NEW; END IF;
        PERFORM hm_bm_entitlement_claim(NEW.entitlement_id, 'FISCAL');
        IF EXISTS (SELECT 1 FROM handyman_entitlement_facts f
                   WHERE f.id = NEW.entitlement_id AND f.bm_beneficiary_kind = 'BM_LEGAL_COUNTERPARTY') THEN
          RAISE EXCEPTION 'Distinct BM fiscal binding is not supported.' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER a_hm_distinct_bm_fiscal_basis BEFORE INSERT ON handyman_bm_fee_fiscal_bases
        FOR EACH ROW EXECUTE FUNCTION hm_distinct_bm_fiscal_guard();
      CREATE TRIGGER a_hm_distinct_bm_fiscal_document BEFORE INSERT ON handyman_fiscal_documents
        FOR EACH ROW EXECUTE FUNCTION hm_distinct_bm_fiscal_guard();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    const result = await client.query(`SELECT EXISTS (SELECT 1 FROM handyman_entitlement_facts
      WHERE bm_beneficiary_kind = 'BM_LEGAL_COUNTERPARTY') AS populated`);
    if (result.rows[0].populated) {
      throw new Error('Refusing to remove populated distinct BM entitlement history.');
    }
    await client.query(`
      DROP TRIGGER a_hm_distinct_bm_fiscal_document ON handyman_fiscal_documents;
      DROP TRIGGER a_hm_distinct_bm_fiscal_basis ON handyman_bm_fee_fiscal_bases;
      DROP FUNCTION hm_distinct_bm_fiscal_guard();
      DROP TRIGGER a_hm_distinct_bm_settlement_inclusion ON handyman_settlement_inclusions;
      DROP TRIGGER a_hm_distinct_bm_settlement_event ON handyman_settlement_events;
      DROP FUNCTION hm_distinct_bm_settlement_guard();
      DROP TRIGGER hm_distinct_bm_entitlement ON handyman_entitlement_facts;
      DROP FUNCTION hm_distinct_bm_entitlement_guard();
      DROP FUNCTION hm_bm_transaction_claim(UUID, TEXT);
      DROP FUNCTION hm_bm_entitlement_claim(UUID, TEXT);
      DROP TABLE handyman_bm_entitlement_guards;
      DROP FUNCTION hm_bm_guard_no_mutation();
      DROP TRIGGER hm_entitlement_anchor_guard ON handyman_entitlement_facts;
      CREATE TRIGGER hm_entitlement_anchor_guard BEFORE INSERT ON handyman_entitlement_facts
        FOR EACH ROW EXECUTE FUNCTION handyman_entitlement_anchor_check();
      DROP TRIGGER hm_bm_entitlement_coverage ON handyman_entitlement_facts;
      CREATE TRIGGER hm_bm_entitlement_coverage BEFORE INSERT ON handyman_entitlement_facts
        FOR EACH ROW EXECUTE FUNCTION hm_bm_entitlement_coverage_guard();
      ALTER TABLE handyman_entitlement_facts
        DROP CONSTRAINT hm_entitlement_kind_anchors_check,
        DROP CONSTRAINT hm_entitlement_bm_verification_fk,
        DROP COLUMN bm_beneficiary_kind, DROP COLUMN bm_counterparty_id,
        DROP COLUMN bm_building_id, DROP COLUMN bm_coverage_id, DROP COLUMN bm_verification_id,
        DROP COLUMN bm_coverage_effective_from, DROP COLUMN bm_coverage_effective_to;
      ALTER TABLE handyman_entitlement_facts ADD CONSTRAINT hm_entitlement_kind_anchors_check CHECK (
        (entitlement_kind = 'PROVIDER'
         AND assignment_id IS NOT NULL AND provider_context_id IS NOT NULL
         AND crew_id IS NOT NULL AND lead_worker_id IS NOT NULL AND lead_user_id IS NOT NULL
         AND agreement_id IS NULL AND agreement_version_id IS NULL AND agreement_version_number IS NULL
         AND agreement_effective_from IS NULL AND agreement_effective_to IS NULL
         AND bm_rule_id IS NULL AND bm_term_id IS NULL AND bm_term_rate_percent IS NULL
         AND bm_beneficiary_id IS NULL AND bm_beneficiary_reference_id IS NULL)
        OR
        (entitlement_kind = 'BM_FEE'
         AND assignment_id IS NULL AND provider_context_id IS NULL AND crew_id IS NULL
         AND lead_worker_id IS NULL AND lead_user_id IS NULL
         AND agreement_id IS NOT NULL AND agreement_version_id IS NOT NULL
         AND agreement_version_number IS NOT NULL AND agreement_effective_from IS NOT NULL
         AND bm_rule_id IS NOT NULL AND bm_term_id IS NOT NULL AND bm_term_rate_percent IS NOT NULL
         AND bm_beneficiary_id IS NOT NULL AND bm_beneficiary_reference_id IS NOT NULL)
      );
    `);
  },
};
