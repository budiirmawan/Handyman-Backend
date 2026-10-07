import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  DeliveryCourierListFilters,
  DeliveryCourierRecord,
  DeliveryCourierStatus,
  DeliveryCourierType,
} from './delivery-courier.types';

type DeliveryCourierRow = {
  id: string;
  client_id: string;
  building_id: string;
  visitor_id: string | null;
  expected_visitor_id: string | null;
  walk_in_visit_id: string | null;
  delivery_type: DeliveryCourierType;
  courier_company: string | null;
  courier_name: string | null;
  recipient_user_id: string | null;
  recipient_workforce_id: string | null;
  recipient_name: string | null;
  arrived_at: Date;
  reference_number: string | null;
  notes: string | null;
  status: DeliveryCourierStatus;
  status_updated_at: Date | null;
  status_updated_by_user_id: string | null;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const DELIVERY_COURIER_COLUMNS = `
  id, client_id, building_id, visitor_id,
  expected_visitor_id, walk_in_visit_id,
  delivery_type, courier_company, courier_name,
  recipient_user_id, recipient_workforce_id, recipient_name,
  arrived_at, reference_number, notes, status,
  status_updated_at, status_updated_by_user_id,
  created_by_user_id, created_at, updated_at
`;

function mapRow(row: DeliveryCourierRow): DeliveryCourierRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    visitorId: row.visitor_id,
    expectedVisitorId: row.expected_visitor_id,
    walkInVisitId: row.walk_in_visit_id,
    deliveryType: row.delivery_type,
    courierCompany: row.courier_company,
    courierName: row.courier_name,
    recipientUserId: row.recipient_user_id,
    recipientWorkforceId: row.recipient_workforce_id,
    recipientName: row.recipient_name,
    arrivedAt: row.arrived_at,
    referenceNumber: row.reference_number,
    notes: row.notes,
    status: row.status,
    statusUpdatedAt: row.status_updated_at,
    statusUpdatedByUserId: row.status_updated_by_user_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(input: {
  clientId: string;
  buildingId: string;
  visitorId: string | null;
  expectedVisitorId: string | null;
  walkInVisitId: string | null;
  deliveryType: DeliveryCourierType;
  courierCompany: string | null;
  courierName: string | null;
  recipientUserId: string | null;
  recipientWorkforceId: string | null;
  recipientName: string | null;
  arrivedAt: string | null;
  referenceNumber: string | null;
  notes: string | null;
  createdByUserId: string;
}): Promise<DeliveryCourierRecord> {
  const result = await getPool().query<DeliveryCourierRow>(
    `INSERT INTO delivery_couriers
       (id, client_id, building_id, visitor_id,
        expected_visitor_id, walk_in_visit_id,
        delivery_type, courier_company, courier_name,
        recipient_user_id, recipient_workforce_id, recipient_name,
        arrived_at, reference_number, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             COALESCE($13, NOW()), $14, $15, $16)
     RETURNING ${DELIVERY_COURIER_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.visitorId,
      input.expectedVisitorId,
      input.walkInVisitId,
      input.deliveryType,
      input.courierCompany,
      input.courierName,
      input.recipientUserId,
      input.recipientWorkforceId,
      input.recipientName,
      input.arrivedAt,
      input.referenceNumber,
      input.notes,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<DeliveryCourierRecord | null> {
  const result = await getPool().query<DeliveryCourierRow>(
    `SELECT ${DELIVERY_COURIER_COLUMNS}
     FROM delivery_couriers WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findByExpectedVisitor(
  expectedVisitorId: string,
): Promise<DeliveryCourierRecord | null> {
  const result = await getPool().query<DeliveryCourierRow>(
    `SELECT ${DELIVERY_COURIER_COLUMNS}
     FROM delivery_couriers WHERE expected_visitor_id = $1`,
    [expectedVisitorId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findByWalkInVisit(
  walkInVisitId: string,
): Promise<DeliveryCourierRecord | null> {
  const result = await getPool().query<DeliveryCourierRow>(
    `SELECT ${DELIVERY_COURIER_COLUMNS}
     FROM delivery_couriers WHERE walk_in_visit_id = $1`,
    [walkInVisitId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByBuildingIds(
  buildingIds: string[],
  filters: DeliveryCourierListFilters = {},
): Promise<DeliveryCourierRecord[]> {
  if (buildingIds.length === 0) return [];

  const conditions = ['building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];
  const add = (condition: string, value: unknown): void => {
    values.push(value);
    conditions.push(condition.replace('?', `$${values.length}`));
  };

  if (filters.visitorId) add('visitor_id = ?', filters.visitorId);
  if (filters.expectedVisitorId) {
    add('expected_visitor_id = ?', filters.expectedVisitorId);
  }
  if (filters.walkInVisitId) {
    add('walk_in_visit_id = ?', filters.walkInVisitId);
  }
  if (filters.deliveryType) add('delivery_type = ?', filters.deliveryType);
  if (filters.status) add('status = ?', filters.status);
  if (filters.search) {
    values.push(`%${filters.search}%`);
    const index = values.length;
    conditions.push(`(
      courier_company ILIKE $${index}
      OR courier_name ILIKE $${index}
      OR recipient_name ILIKE $${index}
      OR reference_number ILIKE $${index}
      OR notes ILIKE $${index}
    )`);
  }

  const result = await getPool().query<DeliveryCourierRow>(
    `SELECT ${DELIVERY_COURIER_COLUMNS}
     FROM delivery_couriers
     WHERE ${conditions.join(' AND ')}
     ORDER BY arrived_at DESC, created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function updateStatus(
  id: string,
  input: {
    status: Exclude<DeliveryCourierStatus, 'ARRIVED'>;
    statusUpdatedByUserId: string;
    referenceNumber?: string | null;
    notes?: string | null;
  },
): Promise<DeliveryCourierRecord | null> {
  const sets = [
    'status = $2',
    'status_updated_at = NOW()',
    'status_updated_by_user_id = $3',
    'updated_at = NOW()',
  ];
  const values: unknown[] = [id, input.status, input.statusUpdatedByUserId];

  if (input.referenceNumber !== undefined) {
    values.push(input.referenceNumber);
    sets.push(`reference_number = $${values.length}`);
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }

  const result = await getPool().query<DeliveryCourierRow>(
    `UPDATE delivery_couriers
     SET ${sets.join(', ')}
     WHERE id = $1 AND status = 'ARRIVED'
     RETURNING ${DELIVERY_COURIER_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const deliveryCourierRepository = {
  create,
  findByExpectedVisitor,
  findById,
  findByWalkInVisit,
  listByBuildingIds,
  updateStatus,
};
