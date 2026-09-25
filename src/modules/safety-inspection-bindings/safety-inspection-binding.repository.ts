import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  SafetyInspectionBindingRecord,
  SafetyInspectionBindingStatus,
} from './safety-inspection-binding.types';

type SafetyInspectionBindingRow = {
  id: string;
  client_id: string;
  building_id: string;
  schedule_definition_id: string;
  status: SafetyInspectionBindingStatus;
  created_at: Date;
  updated_at: Date;
};

const COLUMNS = `
  id, client_id, building_id, schedule_definition_id, status,
  created_at, updated_at
`;

function mapRow(row: SafetyInspectionBindingRow): SafetyInspectionBindingRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    scheduleDefinitionId: row.schedule_definition_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const safetyInspectionBindingRepository = {
  async create(input: {
    clientId: string;
    buildingId: string;
    scheduleDefinitionId: string;
    status: SafetyInspectionBindingStatus;
  }): Promise<SafetyInspectionBindingRecord> {
    const result = await getPool().query<SafetyInspectionBindingRow>(
      `INSERT INTO safety_inspection_bindings
         (id, client_id, building_id, schedule_definition_id, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.clientId,
        input.buildingId,
        input.scheduleDefinitionId,
        input.status,
      ],
    );
    return mapRow(result.rows.at(0)!);
  },

  async findById(id: string): Promise<SafetyInspectionBindingRecord | null> {
    const result = await getPool().query<SafetyInspectionBindingRow>(
      `SELECT ${COLUMNS}
         FROM safety_inspection_bindings
        WHERE id = $1`,
      [id],
    );
    const row = result.rows.at(0);
    return row ? mapRow(row) : null;
  },

  /**
   * Return every ACTIVE row. Callers must inspect cardinality before using an
   * id; this intentionally has no LIMIT, ordering, or arbitrary winner.
   */
  async listActiveBySchedule(
    scheduleDefinitionId: string,
  ): Promise<SafetyInspectionBindingRecord[]> {
    const result = await getPool().query<SafetyInspectionBindingRow>(
      `SELECT ${COLUMNS}
         FROM safety_inspection_bindings
        WHERE schedule_definition_id = $1
          AND status = 'ACTIVE'`,
      [scheduleDefinitionId],
    );
    return result.rows.map(mapRow);
  },

  async updateStatus(
    id: string,
    status: SafetyInspectionBindingStatus,
  ): Promise<SafetyInspectionBindingRecord | null> {
    const result = await getPool().query<SafetyInspectionBindingRow>(
      `UPDATE safety_inspection_bindings
          SET status = $2, updated_at = NOW()
        WHERE id = $1
       RETURNING ${COLUMNS}`,
      [id, status],
    );
    const row = result.rows.at(0);
    return row ? mapRow(row) : null;
  },
};
