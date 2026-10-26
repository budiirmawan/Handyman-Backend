import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-MANUAL-QUOTATION-01 — PART 03A: quotation-line origin provenance.
 *
 * A formal `UNLISTED_TRIAGE` service request (0488) has no Service Catalog
 * anchor at all, yet it must still be quotable through the EXISTING quotation
 * version/line engine (0391/0392/0393/0394): LABOR vs MATERIAL, server-derived
 * `line_total`, one currency per version, DRAFT-only edits, immutable issued
 * lines, issue/expire/supersede and the customer decision.
 *
 * This migration adds ONLY the provenance that lane needs:
 *
 *   handyman_quotation_lines.origin_kind
 *     'CATALOG' (default, and the value every pre-existing row gets) or
 *     'MANUAL_ONE_TIME' (an operator-authored one-time line, never a governed
 *     catalog price resolution).
 *
 * Two laws are enforced in the database, not merely by the service:
 *   1. a line on a manual-origin request's version MUST be MANUAL_ONE_TIME —
 *      claiming CATALOG there would assert a catalog anchor that cannot exist;
 *   2. a MANUAL_ONE_TIME claim on a catalog-lane request is only lawful when
 *      the governed pricing authority already recorded a MANUAL_REVIEW
 *      resolution for that request (0477 `handyman_service_quote_resolutions`,
 *      which by CHECK never carries an amount). A manual line can therefore
 *      never be used to dodge a price rule, and no resolution is invented here.
 *
 * Reversible: `down()` refuses while any MANUAL_ONE_TIME line exists (that
 * provenance is an audited commercial fact) and otherwise removes only what
 * 0489 added. No FK is declared onto the intake tables and no column is added
 * to any table another migration recreates, so 0392's own `down()` and the
 * 0486/0488 lanes stay intact.
 */
export const migration0489HandymanQuotationLineManualOrigin: Migration = {
  id: '0489_handyman_quotation_line_manual_origin',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_quotation_lines
        ADD COLUMN IF NOT EXISTS origin_kind TEXT NOT NULL DEFAULT 'CATALOG';

      ALTER TABLE handyman_quotation_lines
        DROP CONSTRAINT IF EXISTS handyman_quotation_lines_origin_kind_check,
        ADD CONSTRAINT handyman_quotation_lines_origin_kind_check
        CHECK (origin_kind IN ('CATALOG', 'MANUAL_ONE_TIME'));

      CREATE OR REPLACE FUNCTION handyman_quotation_line_guard_origin()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_request_id UUID;
        v_client_id UUID;
        v_intake_source TEXT;
        v_manual_review BOOLEAN;
      BEGIN
        SELECT q.handyman_request_id, q.client_id, r.intake_source
          INTO v_request_id, v_client_id, v_intake_source
          FROM handyman_quotation_versions v
          JOIN handyman_quotations q ON q.id = v.quotation_id
          JOIN handyman_service_requests r ON r.id = q.handyman_request_id
         WHERE v.id = NEW.quotation_version_id;

        IF v_request_id IS NULL THEN
          RAISE EXCEPTION
            'A quotation line must belong to a version of an existing service request'
            USING ERRCODE = '23514';
        END IF;

        IF v_intake_source = 'UNLISTED_TRIAGE' THEN
          IF NEW.origin_kind <> 'MANUAL_ONE_TIME' THEN
            RAISE EXCEPTION
              'A manual-origin (unlisted-intake) service request has no Service Catalog anchor, so its quotation lines can never be recorded as CATALOG origin'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;

        IF NEW.origin_kind = 'MANUAL_ONE_TIME' THEN
          SELECT EXISTS (
            SELECT 1
              FROM handyman_service_quote_resolutions res
             WHERE res.handyman_request_id = v_request_id
               AND res.client_id = v_client_id
               AND res.outcome = 'MANUAL_REVIEW'
          ) INTO v_manual_review;

          IF NOT v_manual_review THEN
            RAISE EXCEPTION
              'A MANUAL_ONE_TIME line on a catalog-lane request requires an existing governed MANUAL_REVIEW quote resolution for that request'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_handyman_quotation_line_guard_origin
      BEFORE INSERT ON handyman_quotation_lines
      FOR EACH ROW
      EXECUTE FUNCTION handyman_quotation_line_guard_origin();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM handyman_quotation_lines WHERE origin_kind <> 'CATALOG'
        ) THEN
          RAISE EXCEPTION
            'handyman_quotation_lines carries MANUAL_ONE_TIME origin provenance; 0489 cannot be reverted'
            USING ERRCODE = '23514';
        END IF;
      END $$;

      DROP TRIGGER IF EXISTS trg_handyman_quotation_line_guard_origin
        ON handyman_quotation_lines;
      DROP FUNCTION IF EXISTS handyman_quotation_line_guard_origin();
      ALTER TABLE handyman_quotation_lines
        DROP CONSTRAINT IF EXISTS handyman_quotation_lines_origin_kind_check;
      ALTER TABLE handyman_quotation_lines
        DROP COLUMN IF EXISTS origin_kind;
    `);
  },
};
