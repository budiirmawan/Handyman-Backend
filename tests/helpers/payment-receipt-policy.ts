import assert from 'node:assert/strict';
import { api } from './http';

/** Test-only: configure and explicitly approve the same policy as a manager. */
export async function approveTestPaymentReceiptPolicy(clientId: string, token: string) {
  const path = `/api/v1/handyman/clients/${clientId}/document-settings/PAYMENT_RECEIPT/id`;
  const auth = { Authorization: `Bearer ${token}` };
  const configured = await api().put(path).set(auth).send({ expectedVersion: null, documentPrefix: 'HM-PR',
    termsLines: ['Verified incoming payment'], signatoryName: 'Finance Manager', signatoryTitle: 'Finance' });
  assert.equal(configured.status, 201, JSON.stringify(configured.body));
  const settings = configured.body.data;
  const activated = await api().post(`${path}/numbering/activate`).set(auth).send({ settingsId: settings.id,
    settingsVersion: settings.version, policyCode: 'HM_PR_ISSUER_YEAR_V1', approve: true });
  assert.equal(activated.status, 201, JSON.stringify(activated.body));
  return { settings, approval: activated.body.data };
}
