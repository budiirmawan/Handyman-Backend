import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-13K — Delivery / Courier.
 *
 * A Building-scoped delivery context may reuse a BE-13 Visitor identity
 * and Expected Visitor / Walk-In visit when the courier is handled as a
 * visitor. Those references remain optional because unattended package
 * receipt does not always create a visitor visit. When a visit is linked,
 * the existing Check-In / Check-Out lifecycle remains authoritative.
 *
 * This table only holds delivery-specific metadata and a small receipt
 * status transition; it is not a separate courier-management engine and
 * does not introduce Front Desk Log behavior.
 */
export const migration0143CreateDeliveryCouriers: Migration = {
  id: '0143_create_delivery_couriers',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE delivery_couriers (
        id                              UUID PRIMARY KEY,
        client_id                       UUID NOT NULL REFERENCES clients (id),
        building_id                     UUID NOT NULL REFERENCES buildings (id),
        visitor_id                      UUID REFERENCES visitors (id),
        expected_visitor_id             UUID REFERENCES expected_visitors (id),
        walk_in_visit_id                UUID REFERENCES walk_in_visits (id),
        delivery_type                   TEXT NOT NULL,
        courier_company                 TEXT,
        courier_name                    TEXT,
        recipient_user_id               UUID REFERENCES users (id),
        recipient_workforce_id          UUID REFERENCES workforce_profiles (id),
        recipient_name                  TEXT,
        arrived_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reference_number                TEXT,
        notes                           TEXT,
        status                          TEXT NOT NULL DEFAULT 'ARRIVED',
        status_updated_at               TIMESTAMPTZ,
        status_updated_by_user_id       UUID REFERENCES users (id),
        created_by_user_id              UUID NOT NULL REFERENCES users (id),
        created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT delivery_couriers_type_check
          CHECK (delivery_type IN ('DELIVERY', 'COURIER')),
        CONSTRAINT delivery_couriers_status_check
          CHECK (status IN ('ARRIVED', 'RECEIVED', 'REJECTED', 'CANCELLED')),
        CONSTRAINT delivery_couriers_visit_reference_check
          CHECK (
            (expected_visitor_id IS NOT NULL)::int
            + (walk_in_visit_id IS NOT NULL)::int <= 1
          ),
        CONSTRAINT delivery_couriers_visit_visitor_check
          CHECK (
            (expected_visitor_id IS NULL AND walk_in_visit_id IS NULL)
            OR visitor_id IS NOT NULL
          ),
        CONSTRAINT delivery_couriers_courier_required
          CHECK (courier_company IS NOT NULL OR courier_name IS NOT NULL),
        CONSTRAINT delivery_couriers_recipient_required
          CHECK (
            recipient_user_id IS NOT NULL
            OR recipient_workforce_id IS NOT NULL
            OR recipient_name IS NOT NULL
          ),
        CONSTRAINT delivery_couriers_status_update_consistency
          CHECK (
            (status = 'ARRIVED'
              AND status_updated_at IS NULL
              AND status_updated_by_user_id IS NULL)
            OR (status <> 'ARRIVED'
              AND status_updated_at IS NOT NULL
              AND status_updated_by_user_id IS NOT NULL)
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX delivery_couriers_expected_visit_unique
        ON delivery_couriers (expected_visitor_id)
        WHERE expected_visitor_id IS NOT NULL;
      CREATE UNIQUE INDEX delivery_couriers_walk_in_visit_unique
        ON delivery_couriers (walk_in_visit_id)
        WHERE walk_in_visit_id IS NOT NULL;
      CREATE INDEX delivery_couriers_building_idx
        ON delivery_couriers (building_id, status, arrived_at);
      CREATE INDEX delivery_couriers_client_idx
        ON delivery_couriers (client_id, status);
      CREATE INDEX delivery_couriers_visitor_idx
        ON delivery_couriers (visitor_id, status);
      CREATE INDEX delivery_couriers_recipient_user_idx
        ON delivery_couriers (recipient_user_id);
      CREATE INDEX delivery_couriers_recipient_workforce_idx
        ON delivery_couriers (recipient_workforce_id);
      CREATE INDEX delivery_couriers_reference_idx
        ON delivery_couriers (reference_number);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS delivery_couriers');
  },
};
