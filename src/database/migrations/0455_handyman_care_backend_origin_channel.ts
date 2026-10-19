import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-CC-TENANT-REQUEST-GATEWAY-01 — admit the Backend Customer Care
 * staff-assisted intake origin channel.
 *
 * The staff gateway (`POST /api/v1/handyman/care/buildings/{buildingId}/requests`)
 * creates the canonical Handyman Request from an authenticated Backend
 * Customer Care Bearer session — NOT from the BM Super App exchange seam.
 * The frozen origin-channel maps on both authoritative tables currently allow
 * only 'BM_SUPER_APP', so recording the true Backend Care source is a proven
 * schema change (frozen-map NEW channel semantics; the CR-HM-01 governance
 * adds a channel, it never repurposes an existing one).
 *
 * Additive and backward compatible:
 *   - existing BM handoff rows keep 'BM_SUPER_APP' untouched;
 *   - the append-only attribution contract is untouched (no UPDATE/DELETE
 *     path is added for existing rows);
 *   - the two CHECK constraints are widened with the single new literal
 *     'CUSTOMER_CARE_BACKEND' — nothing else changes on either table.
 */
export const migration0455HandymanCareBackendOriginChannel: Migration = {
  id: '0455_handyman_care_backend_origin_channel',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_channel_attributions
        DROP CONSTRAINT handyman_channel_attributions_origin_channel_check,
        ADD CONSTRAINT handyman_channel_attributions_origin_channel_check
          CHECK (origin_channel IN ('BM_SUPER_APP', 'CUSTOMER_CARE_BACKEND'))
    `);
    await client.query(`
      ALTER TABLE handyman_service_requests
        DROP CONSTRAINT handyman_service_requests_origin_channel_check,
        ADD CONSTRAINT handyman_service_requests_origin_channel_check
          CHECK (origin_channel IN ('BM_SUPER_APP', 'CUSTOMER_CARE_BACKEND'))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // Restores the BM-only vocabulary. Fails while any
    // 'CUSTOMER_CARE_BACKEND' row still exists — rollback of the widened
    // vocabulary must never silently destroy persisted Care intake rows.
    await client.query(`
      ALTER TABLE handyman_channel_attributions
        DROP CONSTRAINT handyman_channel_attributions_origin_channel_check,
        ADD CONSTRAINT handyman_channel_attributions_origin_channel_check
          CHECK (origin_channel IN ('BM_SUPER_APP'))
    `);
    await client.query(`
      ALTER TABLE handyman_service_requests
        DROP CONSTRAINT handyman_service_requests_origin_channel_check,
        ADD CONSTRAINT handyman_service_requests_origin_channel_check
          CHECK (origin_channel IN ('BM_SUPER_APP'))
    `);
  },
};
