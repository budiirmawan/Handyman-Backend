import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-INV-CONTROL-01 PART 02 — reservation consumption state.
 *
 * PART 01 reservations represented only an untouched ACTIVE allocation. PART 02
 * adds the minimum state needed to consume that allocation deterministically:
 * `consumed_quantity` is progress against the original reservation amount and
 * `remaining_quantity` is database-generated. A fully consumed reservation is
 * terminal `CONSUMED`; partial consumption remains ACTIVE so release/cancel
 * can return only its remaining allocation.
 *
 * Existing ACTIVE/RELEASED/CANCELLED rows are preserved with consumed=0.
 */
export const migration0289AddMaterialReservationConsumption: Migration = {
  id: '0289_add_material_reservation_consumption',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE inventory_material_reservations
        ADD COLUMN consumed_quantity NUMERIC NOT NULL DEFAULT 0,
        ADD COLUMN remaining_quantity NUMERIC GENERATED ALWAYS AS
          (reserved_quantity - consumed_quantity) STORED,
        ADD COLUMN consumed_at TIMESTAMPTZ,
        ADD COLUMN consumed_by_user_id UUID REFERENCES users (id)
    `);

    await client.query(`
      ALTER TABLE inventory_material_reservations
        DROP CONSTRAINT inventory_material_reservation_status_check,
        DROP CONSTRAINT inventory_material_reservation_lifecycle_check,
        ADD CONSTRAINT inventory_material_reservation_consumed_non_negative
          CHECK (consumed_quantity >= 0),
        ADD CONSTRAINT inventory_material_reservation_consumed_le_reserved
          CHECK (consumed_quantity <= reserved_quantity),
        ADD CONSTRAINT inventory_material_reservation_lifecycle_check
          CHECK (
            (
              status = 'ACTIVE'
              AND remaining_quantity > 0
              AND released_at IS NULL
              AND released_by_user_id IS NULL
              AND cancelled_at IS NULL
              AND cancelled_by_user_id IS NULL
              AND consumed_at IS NULL
              AND consumed_by_user_id IS NULL
            )
            OR (
              status = 'RELEASED'
              AND remaining_quantity > 0
              AND released_at IS NOT NULL
              AND released_by_user_id IS NOT NULL
              AND cancelled_at IS NULL
              AND cancelled_by_user_id IS NULL
              AND consumed_at IS NULL
              AND consumed_by_user_id IS NULL
            )
            OR (
              status = 'CANCELLED'
              AND remaining_quantity > 0
              AND cancelled_at IS NOT NULL
              AND cancelled_by_user_id IS NOT NULL
              AND released_at IS NULL
              AND released_by_user_id IS NULL
              AND consumed_at IS NULL
              AND consumed_by_user_id IS NULL
            )
            OR (
              status = 'CONSUMED'
              AND remaining_quantity = 0
              AND consumed_at IS NOT NULL
              AND consumed_by_user_id IS NOT NULL
              AND released_at IS NULL
              AND released_by_user_id IS NULL
              AND cancelled_at IS NULL
              AND cancelled_by_user_id IS NULL
            )
          ),
        ADD CONSTRAINT inventory_material_reservation_status_check
          CHECK (status IN ('ACTIVE', 'RELEASED', 'CANCELLED', 'CONSUMED'))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE inventory_material_reservations
        DROP CONSTRAINT IF EXISTS inventory_material_reservation_status_check,
        DROP CONSTRAINT IF EXISTS inventory_material_reservation_lifecycle_check,
        DROP CONSTRAINT IF EXISTS inventory_material_reservation_consumed_le_reserved,
        DROP CONSTRAINT IF EXISTS inventory_material_reservation_consumed_non_negative,
        DROP COLUMN IF EXISTS consumed_by_user_id,
        DROP COLUMN IF EXISTS consumed_at,
        DROP COLUMN IF EXISTS remaining_quantity,
        DROP COLUMN IF EXISTS consumed_quantity
    `);
    await client.query(`
      ALTER TABLE inventory_material_reservations
        ADD CONSTRAINT inventory_material_reservation_status_check
          CHECK (status IN ('ACTIVE', 'RELEASED', 'CANCELLED')),
        ADD CONSTRAINT inventory_material_reservation_lifecycle_check
          CHECK (
            (
              status = 'ACTIVE'
              AND released_at IS NULL
              AND released_by_user_id IS NULL
              AND cancelled_at IS NULL
              AND cancelled_by_user_id IS NULL
            )
            OR (
              status = 'RELEASED'
              AND released_at IS NOT NULL
              AND released_by_user_id IS NOT NULL
              AND cancelled_at IS NULL
              AND cancelled_by_user_id IS NULL
            )
            OR (
              status = 'CANCELLED'
              AND cancelled_at IS NOT NULL
              AND cancelled_by_user_id IS NOT NULL
              AND released_at IS NULL
              AND released_by_user_id IS NULL
            )
          )
    `);
  },
};
