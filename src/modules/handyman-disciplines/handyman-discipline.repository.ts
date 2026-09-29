import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanDisciplineRecord,
  HandymanDisciplineServiceAssociationRecord,
  NewHandymanDisciplineServiceAssociationRecord,
} from './handyman-discipline.types';

/**
 * CR-HM-03 PART 03 — Handyman discipline repository (FROZEN F9 authority,
 * executor-first convention: shared pool by default; transaction executor
 * as the FIRST argument).
 */

type DisciplineRow = {
  id: string;
  code: string;
  name: string;
  scope_class: HandymanDisciplineRecord['scopeClass'];
  status: HandymanDisciplineRecord['status'];
};

type AssociationRow = {
  id: string;
  client_id: string;
  handyman_discipline_id: string;
  service_catalog_id: string;
  created_by_user_id: string;
  created_at: Date;
};

function mapDiscipline(row: DisciplineRow): HandymanDisciplineRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    scopeClass: row.scope_class,
    status: row.status,
  };
}

function mapAssociation(
  row: AssociationRow,
): HandymanDisciplineServiceAssociationRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    handymanDisciplineId: row.handyman_discipline_id,
    serviceCatalogId: row.service_catalog_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

async function findDisciplineById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<HandymanDisciplineRecord | null> {
  const result = await executor.query<DisciplineRow>(
    'SELECT id, code, name, scope_class, status FROM handyman_disciplines WHERE id = $1',
    [id],
  );
  return result.rows[0] ? mapDiscipline(result.rows[0]) : null;
}

async function findDisciplineByCode(
  executor: Pick<PoolClient, 'query'> = getPool(),
  code: string,
): Promise<HandymanDisciplineRecord | null> {
  const result = await executor.query<DisciplineRow>(
    'SELECT id, code, name, scope_class, status FROM handyman_disciplines WHERE code = $1',
    [code],
  );
  return result.rows[0] ? mapDiscipline(result.rows[0]) : null;
}

async function listDisciplines(
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanDisciplineRecord[]> {
  const result = await executor.query<DisciplineRow>(
    'SELECT id, code, name, scope_class, status FROM handyman_disciplines ORDER BY code',
  );
  return result.rows.map(mapDiscipline);
}

async function insertAssociation(
  executor: Pick<PoolClient, 'query'> = getPool(),
  record: NewHandymanDisciplineServiceAssociationRecord,
): Promise<HandymanDisciplineServiceAssociationRecord> {
  const result = await executor.query<AssociationRow>(
    `INSERT INTO handyman_discipline_service_associations (
       id, client_id, handyman_discipline_id, service_catalog_id,
       created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, client_id, handyman_discipline_id, service_catalog_id,
               created_by_user_id, created_at`,
    [
      randomUUID(),
      record.clientId,
      record.handymanDisciplineId,
      record.serviceCatalogId,
      record.createdByUserId,
    ],
  );
  return mapAssociation(result.rows[0]);
}

async function findAssociationByCatalog(
  executor: Pick<PoolClient, 'query'> = getPool(),
  serviceCatalogId: string,
): Promise<HandymanDisciplineServiceAssociationRecord | null> {
  const result = await executor.query<AssociationRow>(
    `SELECT id, client_id, handyman_discipline_id, service_catalog_id,
            created_by_user_id, created_at
       FROM handyman_discipline_service_associations
      WHERE service_catalog_id = $1`,
    [serviceCatalogId],
  );
  return result.rows[0] ? mapAssociation(result.rows[0]) : null;
}

export const handymanDisciplineRepository = {
  findDisciplineById,
  findDisciplineByCode,
  listDisciplines,
  insertAssociation,
  findAssociationByCatalog,
};
