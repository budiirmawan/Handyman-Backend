import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  bindHandymanBmBuildingCoverage, registerHandymanBmLegalCounterparty,
  verifyHandymanBmLegalCounterparty,
} from '../../src/modules/handyman-bm-binding';

/** Explicit test authority: verification must precede the transaction posting. */
export async function prepareVerifiedTestBm(actor: string, clientId: string, distinct = false) {
  const registered = await registerHandymanBmLegalCounterparty(actor, {
    clientId, legalName: distinct ? 'Verified external BM' : 'Verified Client organization',
    registrationNumber: randomUUID(), representsClientOrganization: !distinct, idempotencyKey: randomUUID(),
  });
  const proof = await verifyHandymanBmLegalCounterparty(actor, {
    clientId, counterpartyId: registered.counterparty.id, evidenceReference: `test-evidence/${randomUUID()}`,
  });
  return { counterparty: registered.counterparty, verification: proof.verification };
}
export async function bindVerifiedTestBm(input: {
  actor: string; clientId: string; buildingId: string; versionId: string;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  distinct?: boolean; prepared?: Awaited<ReturnType<typeof prepareVerifiedTestBm>>;
}) {
  const { actor, clientId, buildingId, versionId, query, distinct = false } = input;
  const prepared = input.prepared ?? await prepareVerifiedTestBm(actor, clientId, distinct);
  const existing = await query('SELECT id FROM handyman_bm_fee_beneficiary_definitions WHERE agreement_version_id=$1', [versionId]);
  assert.ok(existing.rows[0]);
  const bound = await bindHandymanBmBuildingCoverage(actor, {
    clientId, buildingId, agreementVersionId: versionId, counterpartyId: prepared.counterparty.id,
    beneficiaryKind: distinct ? 'BM_LEGAL_COUNTERPARTY' : 'CLIENT_ORGANIZATION',
    beneficiaryDefinitionId: distinct ? null : existing.rows[0].id,
    effectiveFrom: prepared.verification.verifiedAt.toISOString(), idempotencyKey: randomUUID(),
  });
  return { ...bound, ...prepared };
}
