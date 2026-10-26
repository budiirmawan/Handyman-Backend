import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-MANUAL-QUOTATION-01 — PART 02: convert ONE triaged Unlisted Intake
 * case into ONE formal Handyman Service Request (manual origin), with no
 * fabricated Service Catalog entry and no fabricated channel attribution.
 *
 * Product law implemented here (frozen):
 *  - `service_catalog_id` becomes nullable ONLY for
 *    `intake_source = 'UNLISTED_TRIAGE'`; every catalog request keeps the exact
 *    0378/0477 rules (NOT NULL + the composite scope FK to `service_catalog`).
 *  - `channel_attribution_id` becomes nullable ONLY for that same verified
 *    manual-origin lane; a catalog request must still carry its real
 *    attribution, and when the intake case HAS a verified attribution the
 *    conversion must preserve it (the 0378 UNIQUE per-attribution rule then
 *    keeps one request per attribution).
 *  - Intake provenance is unique in both directions:
 *    `handyman_service_requests.unlisted_intake_case_id` is UNIQUE (one request
 *    per case) and `handyman_unlisted_intake_triage_state.converted_request_id`
 *    is UNIQUE (one case per request), so a case can never be converted twice
 *    and a request can never claim two cases.
 *
 * Deliberately NOT done: no FK is declared onto
 * `handyman_unlisted_service_intake_cases` — that table is dropped and
 * recreated by 0486's own reversible `down()`/`up()` (exercised by the existing
 * PART 01 suite), so an incoming key would make 0486 un-rollbackable. Case
 * scope is therefore re-proved by the state-row guard (0487 precedent), and no
 * column is added to the 0486 table either: the conversion binding lives on the
 * 0487 state row.
 */
export const migration0488HandymanUnlistedIntakeFormalRequestConversion: Migration = {
  id: '0488_handyman_unlisted_intake_formal_request_conversion',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      -- 1. Lane discriminator + intake provenance on the formal request.
      ALTER TABLE handyman_service_requests
        ADD COLUMN intake_source TEXT NOT NULL DEFAULT 'CATALOG',
        ADD COLUMN unlisted_intake_case_id UUID NULL;

      CREATE INDEX handyman_service_requests_intake_source_idx
        ON handyman_service_requests (client_id, intake_source, status);

      CREATE UNIQUE INDEX handyman_service_requests_unlisted_case_unique
        ON handyman_service_requests (unlisted_intake_case_id)
        WHERE unlisted_intake_case_id IS NOT NULL;

      ALTER TABLE handyman_service_requests
        DROP CONSTRAINT IF EXISTS handyman_service_requests_intake_source_check,
        ADD CONSTRAINT handyman_service_requests_intake_source_check
        CHECK (intake_source IN ('CATALOG', 'UNLISTED_TRIAGE'));

      -- 2. Conditional nullability: no fake catalog, no sentinel attribution,
      --    and a manual-origin row can never carry a variant either.
      ALTER TABLE handyman_service_requests
        ALTER COLUMN service_catalog_id DROP NOT NULL,
        ALTER COLUMN channel_attribution_id DROP NOT NULL;

      ALTER TABLE handyman_service_requests
        DROP CONSTRAINT IF EXISTS handyman_service_requests_manual_source_check,
        ADD CONSTRAINT handyman_service_requests_manual_source_check
        CHECK (
          (
            intake_source = 'CATALOG'
            AND service_catalog_id IS NOT NULL
            AND channel_attribution_id IS NOT NULL
            AND unlisted_intake_case_id IS NULL
          )
          OR
          (
            intake_source = 'UNLISTED_TRIAGE'
            AND service_catalog_id IS NULL
            AND service_variant_id IS NULL
            AND unlisted_intake_case_id IS NOT NULL
          )
        );

      -- 3. The 0378 complaint length rule is untouched for catalog requests;
      --    the unlisted lane carries the 0486 complaint (up to 2000 chars)
      --    verbatim instead of truncating a customer statement.
      ALTER TABLE handyman_service_requests
        DROP CONSTRAINT IF EXISTS handyman_service_requests_description_check,
        ADD CONSTRAINT handyman_service_requests_description_check
        CHECK (
          description IS NULL
          OR (intake_source = 'CATALOG'
                AND length(btrim(description)) BETWEEN 1 AND 1000)
          OR (intake_source = 'UNLISTED_TRIAGE'
                AND length(btrim(description)) BETWEEN 1 AND 2000)
        );

      -- 4. Manual-origin provenance is immutable: only the status machine and
      --    updated_at may move (catalog requests are not touched by this law,
      --    so every existing operational lane behaves exactly as before).
      CREATE OR REPLACE FUNCTION handyman_service_requests_guard_manual_origin()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF OLD.intake_source <> 'UNLISTED_TRIAGE' THEN
          RETURN NEW;
        END IF;

        IF NEW.intake_source <> 'UNLISTED_TRIAGE' THEN
          RAISE EXCEPTION
            'A verified unlisted-intake service request can never be relabelled as a catalog request'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.unlisted_intake_case_id IS DISTINCT FROM OLD.unlisted_intake_case_id
           OR NEW.service_catalog_id IS DISTINCT FROM OLD.service_catalog_id
           OR NEW.service_variant_id IS DISTINCT FROM OLD.service_variant_id
           OR NEW.channel_attribution_id IS DISTINCT FROM OLD.channel_attribution_id
           OR NEW.tenant_company_id IS DISTINCT FROM OLD.tenant_company_id
           OR NEW.building_id IS DISTINCT FROM OLD.building_id
           OR NEW.client_id IS DISTINCT FROM OLD.client_id THEN
          RAISE EXCEPTION
            'handyman_service_requests manual-origin scope and intake provenance are immutable'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_handyman_service_requests_guard_manual_origin
      BEFORE UPDATE ON handyman_service_requests
      FOR EACH ROW
      EXECUTE FUNCTION handyman_service_requests_guard_manual_origin();

      -- 5. Exactly-once conversion binding, carried by the 0487 state anchor.
      ALTER TABLE handyman_unlisted_intake_triage_state
        ADD COLUMN converted_request_id UUID
          REFERENCES handyman_service_requests (id) ON DELETE RESTRICT,
        ADD COLUMN converted_at TIMESTAMPTZ NULL,
        ADD COLUMN conversion_idempotency_key TEXT NULL,
        ADD COLUMN conversion_payload_hash TEXT NULL;

      CREATE UNIQUE INDEX handyman_unlisted_intake_state_converted_request_idx
        ON handyman_unlisted_intake_triage_state (converted_request_id)
        WHERE converted_request_id IS NOT NULL;

      ALTER TABLE handyman_unlisted_intake_triage_state
        DROP CONSTRAINT IF EXISTS handyman_unlisted_intake_triage_state_conversion_shape_check,
        ADD CONSTRAINT handyman_unlisted_intake_triage_state_conversion_shape_check
        CHECK (
          (
            converted_request_id IS NULL
            AND converted_at IS NULL
            AND conversion_idempotency_key IS NULL
            AND conversion_payload_hash IS NULL
          )
          OR (
            converted_request_id IS NOT NULL
            AND converted_at IS NOT NULL
            AND conversion_idempotency_key IS NOT NULL
            AND conversion_payload_hash ~ '^[0-9a-f]{64}$'
          )
        );

      -- The conversion may only point at a manual-origin request that names
      -- THIS case, in THIS Client/Building, and the binding is write-once.
      CREATE OR REPLACE FUNCTION handyman_unlisted_intake_guard_triage_state()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_case_client_id UUID;
        v_case_building_id UUID;
        v_decision_case_id UUID;
        v_decision_client_id UUID;
        v_decision_building_id UUID;
        v_decision_effective BOOLEAN;
        v_request_case_id UUID;
        v_request_client_id UUID;
        v_request_building_id UUID;
        v_request_source TEXT;
      BEGIN
        -- The anchor itself is immutable; only the conversion binding moves.
        IF TG_OP = 'UPDATE'
           AND (
             NEW.intake_case_id <> OLD.intake_case_id
             OR NEW.triage_decision_id <> OLD.triage_decision_id
             OR NEW.triaged_at <> OLD.triaged_at
             OR NEW.created_at <> OLD.created_at
             OR (
               OLD.converted_request_id IS NOT NULL
               AND (
                 NEW.converted_request_id IS DISTINCT FROM OLD.converted_request_id
                 OR NEW.converted_at IS DISTINCT FROM OLD.converted_at
                 OR NEW.conversion_idempotency_key IS DISTINCT
                     FROM OLD.conversion_idempotency_key
                 OR NEW.conversion_payload_hash IS DISTINCT
                     FROM OLD.conversion_payload_hash
               )
             )
           ) THEN
          RAISE EXCEPTION
            'handyman_unlisted_intake_triage_state is an immutable projection anchor'
            USING ERRCODE = '23514';
        END IF;

        SELECT c.client_id, c.building_id
          INTO v_case_client_id, v_case_building_id
          FROM handyman_unlisted_service_intake_cases c
         WHERE c.id = NEW.intake_case_id;

        IF v_case_client_id IS NULL THEN
          RAISE EXCEPTION
            'handyman_unlisted_intake_triage_state must anchor the effective Operations triage decision of this case'
            USING ERRCODE = '23503';
        END IF;

        SELECT d.intake_case_id, d.client_id, d.building_id,
               (d.decision <> 'REQUEST_MORE_INFORMATION_OR_INSPECTION')
          INTO v_decision_case_id, v_decision_client_id, v_decision_building_id,
               v_decision_effective
          FROM handyman_unlisted_intake_triage_decisions d
         WHERE d.id = NEW.triage_decision_id;

        IF v_decision_case_id IS NULL OR NOT v_decision_effective
           OR v_decision_case_id <> NEW.intake_case_id
           OR v_decision_client_id <> v_case_client_id
           OR v_decision_building_id <> v_case_building_id THEN
          RAISE EXCEPTION
            'handyman_unlisted_intake_triage_state must anchor the effective Operations triage decision of this case'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.converted_request_id IS NOT NULL THEN
          SELECT r.unlisted_intake_case_id, r.client_id, r.building_id,
                 r.intake_source
            INTO v_request_case_id, v_request_client_id, v_request_building_id,
                 v_request_source
            FROM handyman_service_requests r
           WHERE r.id = NEW.converted_request_id;

          IF v_request_source IS NULL
             OR v_request_source <> 'UNLISTED_TRIAGE'
             OR v_request_case_id IS DISTINCT FROM NEW.intake_case_id
             OR v_request_client_id IS DISTINCT FROM v_case_client_id
             OR v_request_building_id IS DISTINCT FROM v_case_building_id THEN
            RAISE EXCEPTION
              'handyman_unlisted_intake_triage_state.converted_request_id must reference the manual-origin service request created from this exact case'
              USING ERRCODE = '23514';
          END IF;

          IF NOT EXISTS (
            SELECT 1
              FROM handyman_unlisted_intake_triage_decisions d2
             WHERE d2.id = NEW.triage_decision_id
               AND d2.decision = 'ONE_TIME_MANUAL_QUOTATION_REQUIRED'
          ) THEN
            RAISE EXCEPTION
              'Only a one-time manual quotation triage decision may authorize a formal service request conversion'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$;
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM handyman_service_requests
           WHERE intake_source <> 'CATALOG' OR unlisted_intake_case_id IS NOT NULL
        ) OR EXISTS (
          SELECT 1 FROM handyman_unlisted_intake_triage_state
           WHERE converted_request_id IS NOT NULL
        ) THEN
          RAISE EXCEPTION
            'handyman_service_requests already carries unlisted-intake conversion facts; 0488 cannot be reverted'
            USING ERRCODE = '23514';
        END IF;
      END $$;

      ALTER TABLE handyman_unlisted_intake_triage_state
        DROP COLUMN IF EXISTS converted_request_id,
        DROP COLUMN IF EXISTS converted_at,
        DROP COLUMN IF EXISTS conversion_idempotency_key,
        DROP COLUMN IF EXISTS conversion_payload_hash;

      DROP INDEX IF EXISTS handyman_unlisted_intake_state_converted_request_idx;

      ALTER TABLE handyman_unlisted_intake_triage_state
        DROP CONSTRAINT IF EXISTS
        handyman_unlisted_intake_triage_state_conversion_shape_check;

      DROP TRIGGER IF EXISTS trg_handyman_service_requests_guard_manual_origin
        ON handyman_service_requests;
      DROP FUNCTION IF EXISTS handyman_service_requests_guard_manual_origin();

      ALTER TABLE handyman_service_requests
        DROP CONSTRAINT IF EXISTS handyman_service_requests_manual_source_check,
        DROP CONSTRAINT IF EXISTS handyman_service_requests_intake_source_check,
        ALTER COLUMN service_catalog_id SET NOT NULL,
        ALTER COLUMN channel_attribution_id SET NOT NULL,
        DROP COLUMN IF EXISTS unlisted_intake_case_id,
        DROP COLUMN IF EXISTS intake_source;

      ALTER TABLE handyman_service_requests
        DROP CONSTRAINT IF EXISTS handyman_service_requests_description_check,
        ADD CONSTRAINT handyman_service_requests_description_check
        CHECK (description IS NULL
          OR length(btrim(description)) BETWEEN 1 AND 1000);

      DROP INDEX IF EXISTS handyman_service_requests_unlisted_case_unique;
      DROP INDEX IF EXISTS handyman_service_requests_intake_source_idx;
    `);

    // Restore the 0487 state guard exactly as 0487 authored it.
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_unlisted_intake_guard_triage_state()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_case_client_id UUID;
        v_case_building_id UUID;
        v_decision_case_id UUID;
        v_decision_client_id UUID;
        v_decision_building_id UUID;
        v_decision_effective BOOLEAN;
      BEGIN
        IF TG_OP = 'UPDATE'
           AND (
             NEW.intake_case_id <> OLD.intake_case_id
             OR NEW.triage_decision_id <> OLD.triage_decision_id
             OR NEW.triaged_at <> OLD.triaged_at
             OR NEW.created_at <> OLD.created_at
           ) THEN
          RAISE EXCEPTION
            'handyman_unlisted_intake_triage_state is an immutable projection anchor'
            USING ERRCODE = '23514';
        END IF;

        SELECT c.client_id, c.building_id
          INTO v_case_client_id, v_case_building_id
          FROM handyman_unlisted_service_intake_cases c
         WHERE c.id = NEW.intake_case_id;

        IF v_case_client_id IS NULL THEN
          RAISE EXCEPTION
            'handyman_unlisted_intake_triage_state must anchor the effective Operations triage decision of this case'
            USING ERRCODE = '23503';
        END IF;

        SELECT d.intake_case_id, d.client_id, d.building_id,
               (d.decision <> 'REQUEST_MORE_INFORMATION_OR_INSPECTION')
          INTO v_decision_case_id, v_decision_client_id, v_decision_building_id,
               v_decision_effective
          FROM handyman_unlisted_intake_triage_decisions d
         WHERE d.id = NEW.triage_decision_id;

        IF v_decision_case_id IS NULL OR NOT v_decision_effective
           OR v_decision_case_id <> NEW.intake_case_id
           OR v_decision_client_id <> v_case_client_id
           OR v_decision_building_id <> v_case_building_id THEN
          RAISE EXCEPTION
            'handyman_unlisted_intake_triage_state must anchor the effective Operations triage decision of this case'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$;
    `);
  },
};
