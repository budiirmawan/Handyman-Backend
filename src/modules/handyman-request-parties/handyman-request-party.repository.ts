import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanRequestPartyRecord,
  NewHandymanRequestParty,
} from './handyman-request-party.types';

const SELECT = `
  SELECT pr.id,
         pr.client_id AS "clientId",
         pr.request_id AS "requestId",
         pr.party_role AS "partyRole",
         pr.tenant_company_id AS "tenantCompanyId",
         tc.tenant_code AS "tenantCode",
         tc.tenant_name AS "tenantName",
         tc.party_kind AS "partyKind",
         pr.tenant_pic_id AS "tenantPicId",
         tp.pic_name AS "tenantPicName",
         pr.created_by_user_id AS "createdByUserId",
         pr.created_at AS "createdAt"
    FROM handyman_request_parties pr
    JOIN tenant_companies tc
      ON tc.id = pr.tenant_company_id AND tc.client_id = pr.client_id
    LEFT JOIN tenant_pics tp ON tp.id = pr.tenant_pic_id
`;

async function insert(
  party: NewHandymanRequestParty,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanRequestPartyRecord> {
  const id = randomUUID();
  await executor.query(
    `INSERT INTO handyman_request_parties
       (id, client_id, request_id, party_role, tenant_company_id,
        tenant_pic_id, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      party.clientId,
      party.requestId,
      party.partyRole,
      party.tenantCompanyId,
      party.tenantPicId,
      party.createdByUserId,
    ],
  );
  const result = await executor.query<HandymanRequestPartyRecord>(
    `${SELECT} WHERE pr.id = $1`,
    [id],
  );
  return result.rows[0];
}

async function listByRequest(
  requestId: string,
  clientId: string,
): Promise<HandymanRequestPartyRecord[]> {
  const result = await getPool().query<HandymanRequestPartyRecord>(
    `${SELECT} WHERE pr.request_id = $1 AND pr.client_id = $2
      ORDER BY pr.party_role ASC, pr.id ASC`,
    [requestId, clientId],
  );
  return result.rows;
}

export const handymanRequestPartyRepository = { insert, listByRequest };
