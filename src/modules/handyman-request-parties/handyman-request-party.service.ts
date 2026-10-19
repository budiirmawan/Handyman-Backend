import type { PoolClient } from 'pg';
import { handymanRequestPartyRepository } from './handyman-request-party.repository';
import type {
  HandymanRequestPartyRecord,
  NewHandymanRequestParty,
  PublicHandymanRequestParty,
} from './handyman-request-party.types';

function toPublic(record: HandymanRequestPartyRecord): PublicHandymanRequestParty {
  return { ...record, createdAt: record.createdAt.toISOString() };
}

/** Appends the two designations inside the caller's creation transaction. */
async function recordRequestParties(
  input: {
    clientId: string;
    requestId: string;
    actorUserId: string;
    approvalTenantCompanyId: string;
    costResponsibleTenantCompanyId: string;
  },
  client: PoolClient,
): Promise<PublicHandymanRequestParty[]> {
  const rows: NewHandymanRequestParty[] = [
    {
      clientId: input.clientId,
      requestId: input.requestId,
      partyRole: 'APPROVAL',
      tenantCompanyId: input.approvalTenantCompanyId,
      tenantPicId: null,
      createdByUserId: input.actorUserId,
    },
    {
      clientId: input.clientId,
      requestId: input.requestId,
      partyRole: 'COST_RESPONSIBILITY',
      tenantCompanyId: input.costResponsibleTenantCompanyId,
      tenantPicId: null,
      createdByUserId: input.actorUserId,
    },
  ];
  const created: PublicHandymanRequestParty[] = [];
  for (const row of rows) {
    created.push(toPublic(await handymanRequestPartyRepository.insert(row, client)));
  }
  return created;
}

async function listRequestParties(
  requestId: string,
  clientId: string,
): Promise<PublicHandymanRequestParty[]> {
  return (
    await handymanRequestPartyRepository.listByRequest(requestId, clientId)
  ).map(toPublic);
}

export const handymanRequestPartyService = {
  listRequestParties,
  recordRequestParties,
};
