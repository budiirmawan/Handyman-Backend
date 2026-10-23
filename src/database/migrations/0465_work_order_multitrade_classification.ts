import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2A — Multi-trade Work Order
 * classification + competency requirements.
 *
 * THE BUSINESS CORRECTION THIS MIGRATION ENCODES
 *
 * Handyman is a multi-trade light-repair and property-maintenance platform
 * (AC, plumbing, minor electrical, sanitary, door/lock, furniture, painting,
 * ceiling, tiling, installation, generic minor repair) — not an AC-only
 * service. Until now a Work Order carried exactly one free-text `work_type`
 * code and the competency gate of PART 03A was reachable only through the
 * Handyman Execution Scope (i.e. only when the request had gone through a
 * Service Catalog entry). A Work Order created from a Customer Care request
 * (`tenant_service_requests` → `work_orders`) had no classification authority
 * and therefore no competency enforcement at all.
 *
 * 1. `work_order_trade_categories` — the CONFIGURABLE multi-trade registry.
 *
 *    Codes are data, not enum values in the application: a Client/Operations
 *    can add a trade (`ELEVATOR_MINOR`, `POOL_EQUIPMENT`, …) without a code
 *    change, which is exactly the constraint that ruled out hardcoding AC.
 *    Each category optionally points at the existing FROZEN F9
 *    `handyman_disciplines` registry — the platform's existing machine-readable
 *    scope authority — so the two classifications can never drift apart
 *    without an explicit link. Rows are deactivated, never deleted, so a
 *    historical Work Order keeps a resolvable classification.
 *
 *    Seeded with the multi-trade baseline the CR names. Seeding is NOT an
 *    enforcement decision: a seeded category carries no requirement, so the
 *    pre-PART-03B2A behaviour is preserved for every existing Work Order.
 *
 * 2. `work_orders` classification columns.
 *
 *    `trade_category_id` (FK) + `trade_category_code` (immutable snapshot),
 *    `risk_level`, `classified_at`, `classified_by_user_id`. The snapshot is
 *    what the assignment decision ledger quotes, so renaming a category later
 *    can never rewrite history. Classification is OPTIONAL: an unclassified
 *    Work Order is unrestricted (requirement 8 of the CR).
 *
 * 3. Competency requirements keyed by TRADE CATEGORY.
 *
 *    PART 03A's `service_catalog_competency_requirements` is GENERALISED
 *    rather than duplicated: `service_catalog_id` becomes nullable, one new
 *    `trade_category_id` is added, and a CHECK enforces exactly one target.
 *    That keeps ONE requirement model, ONE configuration service and ONE
 *    evaluator — the CR explicitly forbids a parallel authority. The existing
 *    scope-guard trigger is replaced so it validates whichever target is set.
 *
 * 4. `work_order_assignment_competency_decisions` — the append-only decision
 *    ledger (0464 precedent) for Work Order assign/reassign, so a Work Order
 *    decision that used to leave only a summary event now carries the same
 *    "who was evaluated, against which requirement, on what evidence" detail
 *    the Handyman flow already has.
 *
 *    Privacy boundary is identical to 0464: NO certificate number, NO document
 *    id, NO storage key, NO document bytes, NO tokens. Only the opaque
 *    certificate id, verification status, expiry date and proficiency level.
 */
export const migration0465WorkOrderMultiTradeClassification: Migration = {
  id: '0465_work_order_multitrade_classification',
  async up(client: PoolClient): Promise<void> {
    // ------------------------------------------------------------- 1. registry
    await client.query(`
      CREATE TABLE work_order_trade_categories (
        id                     UUID PRIMARY KEY,
        code                   TEXT NOT NULL,
        name                   TEXT NOT NULL,
        description            TEXT,
        risk_level             TEXT NOT NULL DEFAULT 'LOW',
        handyman_discipline_id UUID REFERENCES handyman_disciplines (id),
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id     UUID REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT work_order_trade_categories_code_unique UNIQUE (code),
        CONSTRAINT work_order_trade_categories_code_format_check
          CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
        CONSTRAINT work_order_trade_categories_name_check
          CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
        CONSTRAINT work_order_trade_categories_risk_check
          CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
        CONSTRAINT work_order_trade_categories_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT work_order_trade_categories_description_check
          CHECK (description IS NULL OR char_length(btrim(description)) BETWEEN 1 AND 500)
      )
    `);
    await client.query(`
      CREATE INDEX work_order_trade_categories_status_idx
        ON work_order_trade_categories (status, code)
    `);

    // The multi-trade baseline. `handyman_discipline_id` is resolved by code so
    // the seed stays correct wherever F9 placed the row (0382 seeds them).
    const seeds: Array<[string, string, string, string | null]> = [
      ['AIR_CONDITIONING', 'Air Conditioning', 'MEDIUM', 'AC'],
      ['PLUMBING', 'Plumbing', 'MEDIUM', 'SIMPLE_PLUMBING'],
      ['ELECTRICAL_MINOR', 'Electrical (Minor)', 'HIGH', 'ELECTRICAL'],
      ['SANITARY', 'Sanitary & Bathroom Fittings', 'MEDIUM', 'SIMPLE_PLUMBING'],
      ['DOOR_LOCK', 'Door, Lock & Hardware', 'LOW', 'GENERAL_HANDYMAN'],
      ['FURNITURE', 'Furniture & Fixtures', 'LOW', 'FURNITURE'],
      ['PAINTING', 'Painting & Finishing', 'LOW', 'GENERAL_HANDYMAN'],
      ['CEILING', 'Ceiling & Partition', 'MEDIUM', 'MINOR_CIVIL'],
      ['TILING', 'Tiling & Flooring', 'MEDIUM', 'MINOR_CIVIL'],
      ['INSTALLATION', 'Installation & Mounting', 'LOW', 'GENERAL_HANDYMAN'],
      ['GENERAL_REPAIR', 'Generic Minor Repair', 'LOW', 'GENERAL_HANDYMAN'],
    ];
    for (const [code, name, riskLevel, disciplineCode] of seeds) {
      await client.query(
        `INSERT INTO work_order_trade_categories
           (id, code, name, risk_level, handyman_discipline_id)
         VALUES ($1, $2, $3, $4,
           (SELECT id FROM handyman_disciplines WHERE code = $5))`,
        [randomUUID(), code, name, riskLevel, disciplineCode],
      );
    }

    // -------------------------------------------------- 2. Work Order columns
    await client.query(`
      ALTER TABLE work_orders
        ADD COLUMN trade_category_id     UUID
          REFERENCES work_order_trade_categories (id),
        ADD COLUMN trade_category_code   TEXT,
        ADD COLUMN risk_level            TEXT,
        ADD COLUMN classified_at         TIMESTAMPTZ,
        ADD COLUMN classified_by_user_id UUID REFERENCES users (id)
    `);
    await client.query(`
      ALTER TABLE work_orders
        ADD CONSTRAINT work_orders_trade_classification_pair_check
          CHECK (
            (trade_category_id IS NULL AND trade_category_code IS NULL)
            OR (trade_category_id IS NOT NULL AND trade_category_code IS NOT NULL)
          ),
        ADD CONSTRAINT work_orders_risk_level_check
          CHECK (risk_level IS NULL OR risk_level IN ('LOW', 'MEDIUM', 'HIGH'))
    `);
    await client.query(`
      CREATE INDEX work_orders_trade_category_idx
        ON work_orders (trade_category_id, status, created_at)
    `);

    // ------------------------------- 3. generalise the requirement table
    await client.query(`
      ALTER TABLE service_catalog_competency_requirements
        ALTER COLUMN service_catalog_id DROP NOT NULL,
        ADD COLUMN trade_category_id UUID
          REFERENCES work_order_trade_categories (id)
    `);
    await client.query(`
      ALTER TABLE service_catalog_competency_requirements
        ADD CONSTRAINT service_catalog_competency_requirements_target_check
          CHECK (
            (service_catalog_id IS NOT NULL) <> (trade_category_id IS NOT NULL)
          )
    `);
    await client.query(`
      CREATE UNIQUE INDEX service_catalog_competency_requirements_trade_skill_unique
        ON service_catalog_competency_requirements (
          client_id,
          trade_category_id,
          skill_id
        )
        WHERE requirement_type = 'SKILL'
          AND status = 'ACTIVE'
          AND trade_category_id IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX service_catalog_competency_requirements_trade_cert_unique
        ON service_catalog_competency_requirements (
          client_id,
          trade_category_id,
          lower(btrim(certificate_name))
        )
        WHERE requirement_type = 'CERTIFICATION'
          AND status = 'ACTIVE'
          AND trade_category_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX service_catalog_competency_requirements_trade_idx
        ON service_catalog_competency_requirements (
          trade_category_id,
          status,
          enforcement_level
        )
    `);

    // The 0463 scope guard assumed a service catalogue target. It is replaced
    // (not duplicated) so exactly one guard validates whichever target is set.
    await client.query(`
      CREATE OR REPLACE FUNCTION service_catalog_competency_requirements_scope_guard()
      RETURNS TRIGGER AS $$
      DECLARE
        v_catalog_client_id UUID;
        v_skill_client_id UUID;
        v_trade_exists BOOLEAN;
      BEGIN
        IF NEW.service_catalog_id IS NOT NULL THEN
          SELECT sc.client_id
            INTO v_catalog_client_id
            FROM service_catalog sc
           WHERE sc.id = NEW.service_catalog_id;

          IF v_catalog_client_id IS NULL THEN
            RAISE EXCEPTION 'service_catalog_id % does not exist',
              NEW.service_catalog_id
              USING ERRCODE = '23503';
          END IF;

          IF v_catalog_client_id <> NEW.client_id THEN
            RAISE EXCEPTION
              'service_catalog_competency_requirements client_id % does not match catalog client %',
              NEW.client_id, v_catalog_client_id
              USING ERRCODE = '23514';
          END IF;
        ELSE
          SELECT TRUE INTO v_trade_exists
            FROM work_order_trade_categories
           WHERE id = NEW.trade_category_id;

          IF v_trade_exists IS NOT TRUE THEN
            RAISE EXCEPTION 'trade_category_id % does not exist',
              NEW.trade_category_id
              USING ERRCODE = '23503';
          END IF;
        END IF;

        IF NEW.skill_id IS NOT NULL THEN
          SELECT s.client_id INTO v_skill_client_id FROM skills s
           WHERE s.id = NEW.skill_id;

          IF v_skill_client_id IS NULL OR v_skill_client_id <> NEW.client_id THEN
            RAISE EXCEPTION
              'service_catalog_competency_requirements skill_id % does not belong to client_id %',
              NEW.skill_id, NEW.client_id
              USING ERRCODE = '23514';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    // -------------------------------------- 4. Work Order decision ledger
    await client.query(`
      CREATE TABLE work_order_assignment_competency_decisions (
        id                          UUID PRIMARY KEY,
        decision_group_id           UUID NOT NULL,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        work_order_id               UUID NOT NULL REFERENCES work_orders (id),
        assignment_id               UUID NOT NULL
          REFERENCES work_order_assignments (id),
        action                      TEXT NOT NULL,
        assignee_type               TEXT NOT NULL,
        trade_category_id           UUID
          REFERENCES work_order_trade_categories (id),
        trade_category_code         TEXT,
        risk_level                  TEXT,
        workforce_profile_id        UUID NOT NULL REFERENCES workforce_profiles (id),
        requirement_id              UUID NOT NULL
          REFERENCES service_catalog_competency_requirements (id),
        requirement_type            TEXT NOT NULL,
        enforcement_level           TEXT NOT NULL,
        skill_id                    UUID,
        skill_code                  TEXT,
        minimum_proficiency_level   TEXT,
        certificate_name            TEXT,
        satisfied                   BOOLEAN NOT NULL,
        reason                      TEXT,
        evidence_proficiency_level  TEXT,
        evidence_certification_id   UUID,
        evidence_verification_status TEXT,
        evidence_expiry_date        TIMESTAMPTZ,
        evaluated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT work_order_assignment_competency_decisions_action_check
          CHECK (action IN ('ASSIGNED', 'REASSIGNED')),
        CONSTRAINT work_order_assignment_competency_decisions_assignee_check
          CHECK (assignee_type IN
            ('WORKFORCE', 'TEAM', 'VENDOR', 'VENDOR_WORKFORCE')),
        CONSTRAINT work_order_assignment_competency_decisions_type_check
          CHECK (requirement_type IN ('SKILL', 'CERTIFICATION')),
        CONSTRAINT work_order_assignment_competency_decisions_enforcement_check
          CHECK (enforcement_level IN ('MANDATORY', 'RECOMMENDED')),
        CONSTRAINT work_order_assignment_competency_decisions_proficiency_check
          CHECK (
            minimum_proficiency_level IS NULL
            OR minimum_proficiency_level
               IN ('BASIC', 'INTERMEDIATE', 'ADVANCED', 'EXPERT')
          ),
        CONSTRAINT work_order_assignment_competency_decisions_reason_check
          CHECK (
            reason IS NULL
            OR reason IN (
              'SKILL_MISSING',
              'PROFICIENCY_INSUFFICIENT',
              'CERTIFICATION_MISSING',
              'CERTIFICATION_UNVERIFIED',
              'CERTIFICATION_EXPIRED',
              'CERTIFICATION_INACTIVE'
            )
          ),
        CONSTRAINT work_order_assignment_competency_decisions_outcome_check
          CHECK (
            (satisfied AND reason IS NULL)
            OR (NOT satisfied AND reason IS NOT NULL)
          ),
        CONSTRAINT work_order_assignment_competency_decisions_risk_check
          CHECK (risk_level IS NULL OR risk_level IN ('LOW', 'MEDIUM', 'HIGH'))
      )
    `);
    await client.query(`
      CREATE INDEX work_order_assignment_competency_decisions_work_order_idx
        ON work_order_assignment_competency_decisions (
          client_id,
          work_order_id,
          evaluated_at DESC,
          id DESC
        )
    `);
    await client.query(`
      CREATE INDEX work_order_assignment_competency_decisions_assignment_idx
        ON work_order_assignment_competency_decisions (assignment_id)
    `);
    await client.query(`
      CREATE INDEX work_order_assignment_competency_decisions_group_idx
        ON work_order_assignment_competency_decisions (decision_group_id)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION work_order_competency_history_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          '% is an append-only decision ledger: % is forbidden.',
          TG_TABLE_NAME, TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER work_order_assignment_competency_decisions_no_write
        BEFORE UPDATE OR DELETE ON work_order_assignment_competency_decisions
        FOR EACH ROW
        EXECUTE FUNCTION work_order_competency_history_block_mutation()
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS work_order_assignment_competency_decisions_no_write
        ON work_order_assignment_competency_decisions
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS work_order_competency_history_block_mutation()
    `);
    await client.query(`
      DROP TABLE IF EXISTS work_order_assignment_competency_decisions
    `);

    // Restore the 0463 shape: trade-category requirements cannot survive a
    // column that no longer exists, so they are removed first (the catalogue
    // requirements are untouched).
    await client.query(`
      DELETE FROM service_catalog_competency_requirements
        WHERE trade_category_id IS NOT NULL
    `);
    await client.query(`
      DROP INDEX IF EXISTS service_catalog_competency_requirements_trade_idx
    `);
    await client.query(`
      DROP INDEX IF EXISTS service_catalog_competency_requirements_trade_cert_unique
    `);
    await client.query(`
      DROP INDEX IF EXISTS service_catalog_competency_requirements_trade_skill_unique
    `);
    await client.query(`
      ALTER TABLE service_catalog_competency_requirements
        DROP CONSTRAINT IF EXISTS service_catalog_competency_requirements_target_check,
        DROP COLUMN IF EXISTS trade_category_id,
        ALTER COLUMN service_catalog_id SET NOT NULL
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION service_catalog_competency_requirements_scope_guard()
      RETURNS TRIGGER AS $$
      DECLARE
        v_catalog_client_id UUID;
        v_skill_client_id UUID;
      BEGIN
        SELECT sc.client_id
          INTO v_catalog_client_id
          FROM service_catalog sc
         WHERE sc.id = NEW.service_catalog_id;

        IF v_catalog_client_id IS NULL THEN
          RAISE EXCEPTION 'service_catalog_id % does not exist',
            NEW.service_catalog_id
            USING ERRCODE = '23503';
        END IF;

        IF v_catalog_client_id <> NEW.client_id THEN
          RAISE EXCEPTION
            'service_catalog_competency_requirements client_id % does not match catalog client %',
            NEW.client_id, v_catalog_client_id
            USING ERRCODE = '23514';
        END IF;

        IF NEW.skill_id IS NOT NULL THEN
          SELECT s.client_id INTO v_skill_client_id FROM skills s
           WHERE s.id = NEW.skill_id;

          IF v_skill_client_id IS NULL OR v_skill_client_id <> NEW.client_id THEN
            RAISE EXCEPTION
              'service_catalog_competency_requirements skill_id % does not belong to client_id %',
              NEW.skill_id, NEW.client_id
              USING ERRCODE = '23514';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      DROP INDEX IF EXISTS work_orders_trade_category_idx
    `);
    await client.query(`
      ALTER TABLE work_orders
        DROP CONSTRAINT IF EXISTS work_orders_risk_level_check,
        DROP CONSTRAINT IF EXISTS work_orders_trade_classification_pair_check,
        DROP COLUMN IF EXISTS classified_by_user_id,
        DROP COLUMN IF EXISTS classified_at,
        DROP COLUMN IF EXISTS risk_level,
        DROP COLUMN IF EXISTS trade_category_code,
        DROP COLUMN IF EXISTS trade_category_id
    `);
    await client.query(`
      DROP TABLE IF EXISTS work_order_trade_categories
    `);
  },
};
