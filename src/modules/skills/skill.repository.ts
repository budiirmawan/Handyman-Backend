import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewSkill,
  SkillCategory,
  SkillRecord,
  SkillStatus,
} from './skill.types';

type SkillRow = {
  id: string;
  client_id: string;
  code: string;
  name: string;
  description: string | null;
  category: SkillCategory;
  status: SkillStatus;
  created_at: Date;
  updated_at: Date;
};

const SKILL_SELECT = `
  id,
  client_id,
  code,
  name,
  description,
  category,
  status,
  created_at,
  updated_at
`;

function mapRow(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    code: row.code,
    name: row.name,
    description: row.description,
    category: row.category,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function create(input: NewSkill): Promise<SkillRecord> {
  const result = await getPool().query<SkillRow>(
    `INSERT INTO skills
       (id, client_id, code, name, description, category, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SKILL_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.code,
      input.name,
      input.description,
      input.category,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<SkillRecord | null> {
  const result = await getPool().query<SkillRow>(
    `SELECT ${SKILL_SELECT} FROM skills WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Client-scoped read. Every catalog listing goes through this method so a Skill
 * can never be returned outside the Client that owns it (BE-02 isolation).
 */
async function listByClient(clientId: string): Promise<SkillRecord[]> {
  const result = await getPool().query<SkillRow>(
    `SELECT ${SKILL_SELECT} FROM skills
     WHERE client_id = $1
     ORDER BY code ASC`,
    [clientId],
  );

  return result.rows.map(mapRow);
}

/** Duplicate pre-check for `client_id + code`. */
async function findByCodeForClient(
  clientId: string,
  code: string,
): Promise<SkillRecord | null> {
  const result = await getPool().query<SkillRow>(
    `SELECT ${SKILL_SELECT} FROM skills
     WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const skillRepository = {
  create,
  findByCodeForClient,
  findById,
  listByClient,
};
