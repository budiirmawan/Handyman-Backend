import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-18L — Tenant Approval Binding for utility context.
 *
 * Reuses the BE-14H approval primitive (`tenant_approval_bindings`) instead of
 * creating a second approval engine. This migration only widens that table to
 * admit one more Tenant request target:
 *
 *   - a new nullable `utility_calculation_id` reference, and
 *   - 'UTILITY_CALCULATION' added to the request-type CHECK.
 *
 * Everything a utility approval needs already exists on the binding:
 * `tenant_company_id`, `building_id`, `client_id`, `approval_type`,
 * `approver_user_id`, `status` (PENDING / APPROVED / REJECTED), `decided_at`
 * and `decision_notes`. The Meter and utility context are resolved through
 * the calculation reference (BE-18I → BE-18G → BE-18A) rather than copied, so
 * the binding can never disagree with the records it approves.
 *
 * The existing exactly-one-reference and type-matches-reference CHECKs are
 * re-stated to cover the fourth target, keeping it impossible for a row to
 * point at two requests at once or to claim a type it does not reference.
 *
 * A partial UNIQUE index keeps at most one PENDING binding per
 * (calculation, approval type, approver), matching the three indexes BE-14H
 * already defines for its own targets.
 *
 * Out of scope, deliberately: Utility Aggregation (BE-18M).
 */
export const migration0194AddUtilityTenantApprovalBinding: Migration = {
  id: '0194_add_utility_tenant_approval_binding',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE tenant_approval_bindings
        ADD COLUMN utility_calculation_id UUID
          REFERENCES utility_calculations (id)
    `);

    await client.query(`
      ALTER TABLE tenant_approval_bindings
        DROP CONSTRAINT tenant_approval_request_type_check,
        DROP CONSTRAINT tenant_approval_request_reference_check,
        DROP CONSTRAINT tenant_approval_request_type_reference_check
    `);

    await client.query(`
      ALTER TABLE tenant_approval_bindings
        ADD CONSTRAINT tenant_approval_request_type_check
          CHECK (request_type IN
            ('SERVICE_REQUEST', 'COMPLAINT', 'UTILITY_REQUEST',
             'UTILITY_CALCULATION')),
        ADD CONSTRAINT tenant_approval_request_reference_check
          CHECK (
            (service_request_id IS NOT NULL)::int
            + (complaint_id IS NOT NULL)::int
            + (utility_request_id IS NOT NULL)::int
            + (utility_calculation_id IS NOT NULL)::int = 1
          ),
        ADD CONSTRAINT tenant_approval_request_type_reference_check
          CHECK (
            (request_type = 'SERVICE_REQUEST' AND service_request_id IS NOT NULL)
            OR (request_type = 'COMPLAINT' AND complaint_id IS NOT NULL)
            OR (request_type = 'UTILITY_REQUEST' AND utility_request_id IS NOT NULL)
            OR (request_type = 'UTILITY_CALCULATION'
                AND utility_calculation_id IS NOT NULL)
          )
    `);

    await client.query(`
      CREATE UNIQUE INDEX tenant_approval_utility_calculation_pending_unique
        ON tenant_approval_bindings
          (utility_calculation_id, approval_type, approver_user_id)
        WHERE status = 'PENDING' AND utility_calculation_id IS NOT NULL;
      CREATE INDEX tenant_approval_utility_calculation_idx
        ON tenant_approval_bindings (utility_calculation_id, status, created_at);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP INDEX IF EXISTS tenant_approval_utility_calculation_pending_unique',
    );
    await client.query(
      'DROP INDEX IF EXISTS tenant_approval_utility_calculation_idx',
    );
    await client.query(
      `DELETE FROM tenant_approval_bindings
       WHERE request_type = 'UTILITY_CALCULATION'`,
    );

    await client.query(`
      ALTER TABLE tenant_approval_bindings
        DROP CONSTRAINT tenant_approval_request_type_check,
        DROP CONSTRAINT tenant_approval_request_reference_check,
        DROP CONSTRAINT tenant_approval_request_type_reference_check
    `);
    await client.query(`
      ALTER TABLE tenant_approval_bindings
        ADD CONSTRAINT tenant_approval_request_type_check
          CHECK (request_type IN
            ('SERVICE_REQUEST', 'COMPLAINT', 'UTILITY_REQUEST')),
        ADD CONSTRAINT tenant_approval_request_reference_check
          CHECK (
            (service_request_id IS NOT NULL)::int
            + (complaint_id IS NOT NULL)::int
            + (utility_request_id IS NOT NULL)::int = 1
          ),
        ADD CONSTRAINT tenant_approval_request_type_reference_check
          CHECK (
            (request_type = 'SERVICE_REQUEST' AND service_request_id IS NOT NULL)
            OR (request_type = 'COMPLAINT' AND complaint_id IS NOT NULL)
            OR (request_type = 'UTILITY_REQUEST' AND utility_request_id IS NOT NULL)
          )
    `);

    await client.query(`
      ALTER TABLE tenant_approval_bindings
        DROP COLUMN utility_calculation_id
    `);
  },
};
