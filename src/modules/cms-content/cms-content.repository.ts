import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CmsContentFilters,
  CmsContentRecord,
  CmsContentScope,
  CmsContentStatus,
  NewCmsContent,
} from './cms-content.types';

const SELECT = `
  cc.id,
  COALESCE(cc.client_id,p.client_id) AS "clientId",
  cc.building_id AS "buildingId",
  cc.scope_type AS "scopeType",
  cc.content_type AS "contentType",
  cc.slug,
  cc.title,
  cc.body,
  cc.status,
  cc.created_by_user_id AS "createdByUserId",
  cc.published_at AS "publishedAt",
  cc.published_by_user_id AS "publishedByUserId",
  cc.created_at AS "createdAt",
  cc.updated_at AS "updatedAt"
`;
const FROM = `
  FROM cms_content cc
  LEFT JOIN buildings b ON b.id=cc.building_id
  LEFT JOIN properties p ON p.id=b.property_id
`;

async function create(input: NewCmsContent): Promise<CmsContentRecord> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO cms_content(
       id,scope_type,client_id,building_id,content_type,slug,title,body,status,
       created_by_user_id,published_at,published_by_user_id
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      randomUUID(),
      input.scopeType,
      input.clientId,
      input.buildingId,
      input.contentType,
      input.slug,
      input.title,
      input.body,
      input.status,
      input.createdByUserId,
      input.publishedAt,
      input.publishedByUserId,
    ],
  );
  return (await findById(result.rows[0].id)) as CmsContentRecord;
}

async function findById(id: string): Promise<CmsContentRecord | null> {
  const result = await getPool().query<CmsContentRecord>(
    `SELECT ${SELECT} ${FROM} WHERE cc.id=$1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function listByScope(
  scope: CmsContentScope,
  scopeId: string,
  filters: CmsContentFilters = {},
): Promise<CmsContentRecord[]> {
  const column = scope === 'CLIENT' ? 'cc.client_id' : 'cc.building_id';
  const values: unknown[] = [scope, scopeId];
  const where = ['cc.scope_type=$1', `${column}=$2`];
  if (filters.contentType) {
    values.push(filters.contentType);
    where.push(`cc.content_type=$${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    where.push(`cc.status=$${values.length}`);
  }
  const result = await getPool().query<CmsContentRecord>(
    `SELECT ${SELECT} ${FROM}
      WHERE ${where.join(' AND ')}
      ORDER BY cc.content_type,cc.slug`,
    values,
  );
  return result.rows;
}

async function listPublishedByScope(
  scope: CmsContentScope,
  scopeId: string,
  contentType?: CmsContentFilters['contentType'],
): Promise<CmsContentRecord[]> {
  return listByScope(scope, scopeId, {
    status: 'PUBLISHED',
    ...(contentType ? { contentType } : {}),
  });
}

type UpdateFields = {
  title?: string;
  body?: string;
  status?: CmsContentStatus;
  publishedAt?: Date | null;
  publishedByUserId?: string | null;
};

async function update(
  id: string,
  input: UpdateFields,
): Promise<CmsContentRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];
  for (const [key, column] of [
    ['title', 'title'],
    ['body', 'body'],
    ['status', 'status'],
    ['publishedAt', 'published_at'],
    ['publishedByUserId', 'published_by_user_id'],
  ] as const) {
    if (input[key] !== undefined) {
      values.push(input[key]);
      sets.push(`${column}=$${values.length}`);
    }
  }
  if (sets.length === 0) return findById(id);
  values.push(id);
  const result = await getPool().query<{ id: string }>(
    `UPDATE cms_content SET ${sets.join(',')},updated_at=NOW()
      WHERE id=$${values.length} RETURNING id`,
    values,
  );
  return result.rows[0] ? findById(result.rows[0].id) : null;
}

export const cmsContentRepository = {
  create,
  findById,
  listByScope,
  listPublishedByScope,
  update,
};
