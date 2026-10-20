import type { PoolClient } from 'pg';
import { tenantVerificationRequiredError } from '../tenant-companies/tenant-company.errors';
import { handymanRequestPartyRepository } from './handyman-request-party.repository';
import type {
  HandymanRequestPartyRecord,
  NewHandymanRequestParty,
  PublicHandymanRequestParty,
} from './handyman-request-party.types';

function toPublic(record: HandymanRequestPartyRecord): PublicHandymanRequestParty {
  return { ...record, createdAt: record.createdAt.toISOString() };
}

/**
 * CR-HM-MASTER-TENANT-BATCH-01 — authority guard for the two commercial
 * designations. Approval authority and billing (cost-responsibility) authority
 * are only ever granted to a VERIFIED party: unverified temporary
 * registrations must never receive either. Checked inside the caller's
 * transaction so a failed designation aborts the whole creation.
 */
async function assertPartiesVerified(
  tenantCompanyIds: readonly string[],
  client: PoolClient,
): Promise<void> {
  const unique = [...new Set(tenantCompanyIds)];
  const result = await client.query<{ verificationStatus: string }>(
    `SELECT verification_status AS "verificationStatus"
       FROM tenant_companies WHERE id = ANY($1::uuid[])`,
    [unique],
  );
  if (
    result.rows.length !== unique.length ||
    result.rows.some((row) => row.verificationStatus !== 'VERIFIED')
  ) {
    throw tenantVerificationRequiredError();
  }
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
  await assertPartiesVerified(
    [input.approvalTenantCompanyId, input.costResponsibleTenantCompanyId],
    client,
  );
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
