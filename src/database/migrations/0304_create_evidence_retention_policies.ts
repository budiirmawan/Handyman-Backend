import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-DOC-CONTROL-01 PART 03 — Retention policy authority + immutable
 * retention snapshot (START GOVERNANCE §5, §6).
 *
 * 1. `evidence_retention_policies` — Client-owned, optionally Building-scoped
 *    configuration authority modeled on the proven `sla_definitions` pattern
 *    (0291): code/name identity, applicability over the EXISTING evidence
 *    vocabularies only (no new taxonomy), per-policy `retention_days` (no
 *    global hard-coded period), effective window, ACTIVE/INACTIVE.
 *    The execution-type CHECK mirrors the authoritative 0281 execution union
 *    of `evidence_submissions` — it must be widened in lockstep if that
 *    union ever grows.
 *
 * 2. Additive snapshot columns on `evidence_submissions` — the applicable
 *    rule is frozen onto the evidence row when governance attaches, so later
 *    policy edits NEVER rewrite already-governed history (`applied_slas`
 *    precedent). Ungoverned rows keep every snapshot column NULL and
 *    `retention_state = 'ACTIVE'`; they are never purged.
 *
 *    Minimal legal/operational hold (§6): a row-level audited flag, not a
 *    case-management engine. A held row is never purged (PART 04).
 *
 * NO backfill: existing evidence remains ungoverned. Purge execution and
 * scheduler wiring are PART 04. The 0281/0303 constraints are untouched.
 */
export const migration0304CreateEvidenceRetentionPolicies: Migration = {
  id: '0304_create_evidence_retention_policies',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE evidence_retention_policies (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id),
        building_id UUID REFERENCES buildings (id),
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        evidence_type TEXT,
        execution_type TEXT,
        retention_days INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        effective_from TIMESTAMPTZ NOT NULL,
        effective_to TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT evidence_retention_policy_client_code_unique UNIQUE (client_id, code),
        CONSTRAINT evidence_retention_policy_code_check CHECK (code ~ '^[A-Z][A-Z0-9_.-]*$'),
        CONSTRAINT evidence_retention_policy_evidence_type_check CHECK (
          evidence_type IS NULL OR evidence_type IN ('PHOTO', 'DOCUMENT', 'SIGNATURE')
        ),
        CONSTRAINT evidence_retention_policy_execution_type_check CHECK (
          execution_type IS NULL OR execution_type IN (
            'FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER', 'VENDOR_WORK',
            'UTILITY_METER_READING', 'PERMIT', 'FINDING', 'FINDING_REWORK',
            'FINDING_VERIFICATION'
          )
        ),
        CONSTRAINT evidence_retention_policy_days_check CHECK (retention_days > 0),
        CONSTRAINT evidence_retention_policy_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT evidence_retention_policy_effective_range_check CHECK (
          effective_to IS NULL OR effective_to > effective_from
        )
      );
      CREATE INDEX evidence_retention_policies_client_idx
        ON evidence_retention_policies (client_id, status, effective_from);
      CREATE INDEX evidence_retention_policies_building_idx
        ON evidence_retention_policies (building_id, status, effective_from)
        WHERE building_id IS NOT NULL;
    `);

    await client.query(`
      ALTER TABLE evidence_submissions
        ADD COLUMN retention_policy_id UUID REFERENCES evidence_retention_policies (id),
        ADD COLUMN retention_policy_code TEXT,
        ADD COLUMN retention_days_snapshot INTEGER,
        ADD COLUMN retention_applied_at TIMESTAMPTZ,
        ADD COLUMN retained_until TIMESTAMPTZ,
        ADD COLUMN retention_state TEXT NOT NULL DEFAULT 'ACTIVE',
        ADD COLUMN retention_hold BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN retention_hold_reason TEXT,
        ADD COLUMN retention_hold_set_by_user_id UUID REFERENCES users (id),
        ADD COLUMN retention_hold_set_at TIMESTAMPTZ,
        ADD CONSTRAINT evidence_retention_snapshot_consistency CHECK (
          (retention_policy_id IS NULL AND retention_policy_code IS NULL
            AND retention_days_snapshot IS NULL AND retention_applied_at IS NULL
            AND retained_until IS NULL)
          OR
          (retention_policy_id IS NOT NULL AND retention_policy_code IS NOT NULL
            AND retention_days_snapshot IS NOT NULL AND retention_applied_at IS NOT NULL
            AND retained_until IS NOT NULL)
        ),
        ADD CONSTRAINT evidence_retention_state_check CHECK (
          retention_state IN ('ACTIVE', 'RETENTION_DUE', 'PURGED')
        ),
        ADD CONSTRAINT evidence_retention_state_governed_check CHECK (
          retention_state = 'ACTIVE' OR retained_until IS NOT NULL
        ),
        ADD CONSTRAINT evidence_retention_hold_consistency CHECK (
          (retention_hold = false AND retention_hold_reason IS NULL
            AND retention_hold_set_by_user_id IS NULL AND retention_hold_set_at IS NULL)
          OR
          (retention_hold = true AND retention_hold_reason IS NOT NULL
            AND retention_hold_set_at IS NOT NULL)
        )
    `);

    // PART 04 due-scan seam: governed, not-yet-purged evidence by due time.
    await client.query(`
      CREATE INDEX evidence_submissions_retention_due_idx
        ON evidence_submissions (retention_state, retained_until)
        WHERE retained_until IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS evidence_submissions_retention_due_idx;
      ALTER TABLE evidence_submissions
        DROP CONSTRAINT IF EXISTS evidence_retention_hold_consistency,
        DROP CONSTRAINT IF EXISTS evidence_retention_state_governed_check,
        DROP CONSTRAINT IF EXISTS evidence_retention_state_check,
        DROP CONSTRAINT IF EXISTS evidence_retention_snapshot_consistency,
        DROP COLUMN IF EXISTS retention_hold_set_at,
        DROP COLUMN IF EXISTS retention_hold_set_by_user_id,
        DROP COLUMN IF EXISTS retention_hold_reason,
        DROP COLUMN IF EXISTS retention_hold,
        DROP COLUMN IF EXISTS retention_state,
        DROP COLUMN IF EXISTS retained_until,
        DROP COLUMN IF EXISTS retention_applied_at,
        DROP COLUMN IF EXISTS retention_days_snapshot,
        DROP COLUMN IF EXISTS retention_policy_code,
        DROP COLUMN IF EXISTS retention_policy_id;
      DROP TABLE IF EXISTS evidence_retention_policies;
    `);
  },
};
