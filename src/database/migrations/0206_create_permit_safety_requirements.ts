import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-20E — Permit Safety Requirement prerequisites/controls only.
 *
 * Requirements bind to one BE-20C Application and preserve the BE-20D Work
 * Type they control. Permit, Client, Building, Contractor, and location remain
 * derived through the Application/Permit/Work Context. Optional references
 * reuse BE-07 checklist/evidence records; no parallel HSE, checklist, or
 * evidence engine is introduced.
 */
export const migration0206CreatePermitSafetyRequirements: Migration = {
  id: '0206_create_permit_safety_requirements',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE permit_safety_requirements (
        id                      UUID PRIMARY KEY,
        permit_application_id   UUID NOT NULL REFERENCES permit_applications (id),
        work_type               TEXT NOT NULL,
        requirement_type        TEXT NOT NULL,
        requirement_description TEXT NOT NULL,
        required                BOOLEAN NOT NULL DEFAULT TRUE,
        readiness_status        TEXT NOT NULL DEFAULT 'PENDING',
        notes                   TEXT,
        reference               TEXT,
        checklist_template_id   UUID REFERENCES checklist_templates (id),
        checklist_execution_id  UUID REFERENCES checklist_executions (id),
        evidence_requirement_id UUID REFERENCES evidence_requirements (id),
        created_by_user_id      UUID NOT NULL REFERENCES users (id),
        updated_by_user_id      UUID NOT NULL REFERENCES users (id),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT permit_safety_requirements_unique
          UNIQUE (permit_application_id, requirement_type),
        CONSTRAINT permit_safety_readiness_status_check
          CHECK (readiness_status IN
            ('PENDING', 'READY', 'NOT_READY', 'NOT_REQUIRED')),
        CONSTRAINT permit_safety_required_status_check
          CHECK (
            (required = FALSE AND readiness_status = 'NOT_REQUIRED')
            OR
            (required = TRUE AND readiness_status IN
              ('PENDING', 'READY', 'NOT_READY'))
          )
      )
    `);

    await client.query(`
      CREATE INDEX permit_safety_requirements_work_type_idx
        ON permit_safety_requirements (work_type, readiness_status);
      CREATE INDEX permit_safety_requirements_application_idx
        ON permit_safety_requirements
          (permit_application_id, readiness_status);
      CREATE INDEX permit_safety_requirements_checklist_idx
        ON permit_safety_requirements (checklist_execution_id);
      CREATE INDEX permit_safety_requirements_evidence_idx
        ON permit_safety_requirements (evidence_requirement_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS permit_safety_requirements');
  },
};
