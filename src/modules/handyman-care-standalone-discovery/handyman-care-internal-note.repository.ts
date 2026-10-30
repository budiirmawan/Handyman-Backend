import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';

export type HandymanCareInternalNoteRecord = {
  id: string;
  handymanRequestId: string;
  note: string;
  visibility: 'INTERNAL';
  createdByUserId: string;
  createdAt: Date;
};

type Executor = Pick<PoolClient, 'query'>;

const SELECT = `
  id,
  handyman_request_id AS "handymanRequestId",
  note,
  visibility,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt"
`;

/** Insert the one optional intake note on the SAME transaction as the
 * canonical request. No tenant/communication/complaint repository is used. */
async function insertForIntake(
  executor: PoolClient,
  input: {
    clientId: string;
    buildingId: string;
    handymanRequestId: string;
    note: string;
    createdByUserId: string;
  },
): Promise<HandymanCareInternalNoteRecord> {
  const result = await executor.query<HandymanCareInternalNoteRecord>(
    `INSERT INTO handyman_care_internal_notes (
       id, client_id, building_id, handyman_request_id,
       note, visibility, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, 'INTERNAL', $6)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.handymanRequestId,
      input.note,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

/** Care-only composition helper. The caller must already have proved the
 * exact Client + Building request scope; all three keys are matched again. */
async function findForRequest(
  executor: Executor = getPool(),
  input: { clientId: string; buildingId: string; handymanRequestId: string },
): Promise<HandymanCareInternalNoteRecord | null> {
  const result = await executor.query<HandymanCareInternalNoteRecord>(
    `SELECT ${SELECT}
       FROM handyman_care_internal_notes
      WHERE handyman_request_id = $1
        AND client_id = $2
        AND building_id = $3
      LIMIT 1`,
    [input.handymanRequestId, input.clientId, input.buildingId],
  );
  return result.rows[0] ?? null;
}

export const handymanCareInternalNoteRepository = {
  insertForIntake,
  findForRequest,
};
