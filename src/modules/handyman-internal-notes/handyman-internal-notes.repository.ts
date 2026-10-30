import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanInternalNoteAuthorRole,
  HandymanInternalNoteRecord,
  HandymanInternalNoteSubjectType,
} from './handyman-internal-notes.types';

const INTERNAL_NOTE_SELECT = `
  SELECT
    n.id,
    n.client_id AS "clientId",
    n.tenant_company_id AS "tenantCompanyId",
    n.building_id AS "buildingId",
    n.space_id AS "spaceId",
    n.subject_type AS "subjectType",
    n.handyman_request_id AS "handymanRequestId",
    n.unlisted_intake_case_id AS "unlistedIntakeCaseId",
    n.visibility_classification AS "visibilityClassification",
    n.author_role AS "authorRole",
    n.created_by_user_id AS "createdByUserId",
    n.created_by_care_actor_id AS "createdByCareActorId",
    COALESCE(u.display_name, ca.display_name, 'Internal Staff') AS "authorDisplayName",
    n.content,
    n.idempotency_key AS "idempotencyKey",
    n.payload_hash AS "payloadHash",
    n.created_at AS "createdAt"
  FROM handyman_internal_notes n
  LEFT JOIN users u ON u.id = n.created_by_user_id
  LEFT JOIN handyman_handoff_care_actors ca ON ca.id = n.created_by_care_actor_id
`;

export type NewHandymanInternalNoteInput = {
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string | null;
  subjectType?: HandymanInternalNoteSubjectType;
  handymanRequestId: string | null;
  unlistedIntakeCaseId?: string | null;
  authorRole: HandymanInternalNoteAuthorRole;
  createdByUserId: string | null;
  createdByCareActorId: string | null;
  content: string;
  idempotencyKey: string;
  payloadHash: string;
};

async function findById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<HandymanInternalNoteRecord | null> {
  const result = await executor.query<HandymanInternalNoteRecord>(
    `${INTERNAL_NOTE_SELECT}
      WHERE n.id = $1
      LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByActorAndIdempotencyKey(
  executor: Pick<PoolClient, 'query'> = getPool(),
  actor: { userId?: string; careActorId?: string },
  idempotencyKey: string,
): Promise<HandymanInternalNoteRecord | null> {
  if (actor.userId) {
    const result = await executor.query<HandymanInternalNoteRecord>(
      `${INTERNAL_NOTE_SELECT}
        WHERE n.created_by_user_id = $1
          AND n.idempotency_key = $2
        LIMIT 1`,
      [actor.userId, idempotencyKey],
    );
    return result.rows[0] ?? null;
  }
  if (actor.careActorId) {
    const result = await executor.query<HandymanInternalNoteRecord>(
      `${INTERNAL_NOTE_SELECT}
        WHERE n.created_by_care_actor_id = $1
          AND n.idempotency_key = $2
        LIMIT 1`,
      [actor.careActorId, idempotencyKey],
    );
    return result.rows[0] ?? null;
  }
  return null;
}

async function insertInternalNote(
  executor: Pick<PoolClient, 'query'>,
  input: NewHandymanInternalNoteInput,
): Promise<HandymanInternalNoteRecord> {
  const id = randomUUID();
  await executor.query(
    `INSERT INTO handyman_internal_notes (
       id,
       client_id,
       tenant_company_id,
       building_id,
       space_id,
       subject_type,
       handyman_request_id,
       unlisted_intake_case_id,
       visibility_classification,
       author_role,
       created_by_user_id,
       created_by_care_actor_id,
       content,
       idempotency_key,
       payload_hash
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'INTERNAL_ONLY', $9, $10, $11, $12, $13, $14)`,
    [
      id,
      input.clientId,
      input.tenantCompanyId,
      input.buildingId,
      input.spaceId,
      input.subjectType ?? 'SERVICE_REQUEST',
      input.handymanRequestId,
      input.unlistedIntakeCaseId ?? null,
      input.authorRole,
      input.createdByUserId,
      input.createdByCareActorId,
      input.content,
      input.idempotencyKey,
      input.payloadHash,
    ],
  );
  const created = await findById(executor, id);
  if (!created) {
    throw new Error('Failed to load newly inserted internal note.');
  }
  return created;
}

async function listByServiceRequestScoped(
  executor: Pick<PoolClient, 'query'> = getPool(),
  scope: {
    clientId: string;
    buildingId: string;
    handymanRequestId: string;
  },
): Promise<HandymanInternalNoteRecord[]> {
  const result = await executor.query<HandymanInternalNoteRecord>(
    `${INTERNAL_NOTE_SELECT}
      WHERE n.handyman_request_id = $1
        AND n.client_id = $2
        AND n.building_id = $3
        AND n.visibility_classification = 'INTERNAL_ONLY'
      ORDER BY n.created_at ASC, n.id ASC`,
    [scope.handymanRequestId, scope.clientId, scope.buildingId],
  );
  return result.rows;
}

export type UnlistedIntakeCaseScopeRow = {
  id: string;
  clientId: string;
  tenantCompanyId: string;
  tenantPicId: string | null;
  buildingId: string;
  spaceId: string | null;
};

async function findUnlistedIntakeCaseScopeById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  intakeCaseId: string,
): Promise<UnlistedIntakeCaseScopeRow | null> {
  const result = await executor.query<UnlistedIntakeCaseScopeRow>(
    `SELECT id,
            client_id AS "clientId",
            tenant_company_id AS "tenantCompanyId",
            tenant_pic_id AS "tenantPicId",
            building_id AS "buildingId",
            space_id AS "spaceId"
       FROM handyman_unlisted_service_intake_cases
      WHERE id = $1
      LIMIT 1`,
    [intakeCaseId],
  );
  return result.rows[0] ?? null;
}

async function listByUnlistedIntakeCaseScoped(
  executor: Pick<PoolClient, 'query'> = getPool(),
  scope: {
    clientId: string;
    buildingId: string;
    unlistedIntakeCaseId: string;
  },
): Promise<HandymanInternalNoteRecord[]> {
  const result = await executor.query<HandymanInternalNoteRecord>(
    `${INTERNAL_NOTE_SELECT}
      WHERE n.unlisted_intake_case_id = $1
        AND n.client_id = $2
        AND n.building_id = $3
        AND n.subject_type = 'UNLISTED_SERVICE_INTAKE_CASE'
        AND n.visibility_classification = 'INTERNAL_ONLY'
      ORDER BY n.created_at ASC, n.id ASC`,
    [scope.unlistedIntakeCaseId, scope.clientId, scope.buildingId],
  );
  return result.rows;
}

async function isCustomerFacingTenantPicUser(
  executor: Pick<PoolClient, 'query'> = getPool(),
  userId: string,
): Promise<boolean> {
  const result = await executor.query<{ isPic: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM tenant_pics tp
        WHERE tp.user_id = $1
     ) AS "isPic"`,
    [userId],
  );
  return Boolean(result.rows[0]?.isPic);
}

export const handymanInternalNotesRepository = {
  findById,
  findByActorAndIdempotencyKey,
  insertInternalNote,
  listByServiceRequestScoped,
  findUnlistedIntakeCaseScopeById,
  listByUnlistedIntakeCaseScoped,
  isCustomerFacingTenantPicUser,
};
