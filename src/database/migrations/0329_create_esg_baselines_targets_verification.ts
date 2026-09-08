import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** CR-BE-ESG-01 PART 04 — governed baselines, targets and human verification. */
export const migration0329CreateEsgBaselinesTargetsVerification: Migration = {
  id: '0329_create_esg_baselines_targets_verification',
  async up(client: PoolClient): Promise<void> {
    await client.query(`CREATE TABLE esg_baselines (
      id UUID PRIMARY KEY, client_id UUID NOT NULL REFERENCES clients(id), building_id UUID,
      metric_definition_id UUID NOT NULL, period_start TIMESTAMPTZ NOT NULL, period_end TIMESTAMPTZ NOT NULL,
      value NUMERIC NOT NULL, uom_id UUID NOT NULL REFERENCES units_of_measure(id),
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
      created_by_user_id UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (metric_definition_id, client_id) REFERENCES esg_metric_definitions(id, client_id),
      FOREIGN KEY (building_id) REFERENCES buildings(id),
      FOREIGN KEY (uom_id, client_id) REFERENCES units_of_measure(id, client_id),
      CHECK (period_start < period_end)
    )`);
    await client.query(`CREATE INDEX esg_baselines_scope_idx ON esg_baselines(client_id, building_id, metric_definition_id, period_start)`);
    await client.query(`CREATE TABLE esg_targets (
      id UUID PRIMARY KEY, client_id UUID NOT NULL REFERENCES clients(id), building_id UUID,
      metric_definition_id UUID NOT NULL, period_start TIMESTAMPTZ NOT NULL, period_end TIMESTAMPTZ NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('ABSOLUTE','REDUCTION_PERCENT')), value NUMERIC NOT NULL,
      uom_id UUID NOT NULL REFERENCES units_of_measure(id), status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
      created_by_user_id UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (metric_definition_id, client_id) REFERENCES esg_metric_definitions(id, client_id),
      FOREIGN KEY (building_id) REFERENCES buildings(id),
      FOREIGN KEY (uom_id, client_id) REFERENCES units_of_measure(id, client_id), CHECK (period_start < period_end),
      CHECK ((target_type = 'REDUCTION_PERCENT' AND value >= 0 AND value <= 100) OR target_type = 'ABSOLUTE')
    )`);
    await client.query(`CREATE INDEX esg_targets_scope_idx ON esg_targets(client_id, building_id, metric_definition_id, period_start)`);
    await client.query(`ALTER TABLE esg_metric_values ADD COLUMN verified_by_user_id UUID REFERENCES users(id), ADD COLUMN verified_at TIMESTAMPTZ, ADD COLUMN verification_note TEXT`);
    await client.query(`ALTER TABLE esg_metric_values ADD CONSTRAINT esg_metric_values_verification_shape CHECK ((verification_status = 'PENDING' AND verified_by_user_id IS NULL AND verified_at IS NULL) OR (verification_status IN ('VERIFIED','REJECTED') AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL AND verification_note IS NOT NULL AND length(btrim(verification_note)) > 0) OR verification_status = 'NOT_REQUIRED')`);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`ALTER TABLE esg_metric_values DROP CONSTRAINT IF EXISTS esg_metric_values_verification_shape, DROP COLUMN IF EXISTS verification_note, DROP COLUMN IF EXISTS verified_at, DROP COLUMN IF EXISTS verified_by_user_id`);
    await client.query('DROP TABLE IF EXISTS esg_targets'); await client.query('DROP TABLE IF EXISTS esg_baselines');
  },
};
