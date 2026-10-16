import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertHandymanTenantDecisionActor } from '../src/modules/handyman-tenant-decision-authority/handyman-tenant-decision-authority';

const IDs = {
  actor: '11111111-1111-4111-8111-111111111111',
  request: '22222222-2222-4222-8222-222222222222',
  client: '33333333-3333-4333-8333-333333333333',
  company: '44444444-4444-4444-8444-444444444444',
  building: '55555555-5555-4555-8555-555555555555',
  pic: '66666666-6666-4666-8666-666666666666',
};

function executor(rows: Array<{ tenant_pic_id: string }>) {
  return {
    query: async (text: string, values?: unknown[]) => {
      assert.match(text, /tp\.user_id = \$1/);
      assert.match(text, /r\.id = \$2/);
      assert.match(text, /tc\.client_id = r\.client_id/);
      assert.match(text, /r\.tenant_company_id = \$4/);
      assert.match(text, /r\.building_id = \$5/);
      assert.match(text, /tsr\.space_id = r\.space_id/);
      assert.match(text, /tsr\.effective_until IS NULL OR tsr\.effective_until > NOW\(\)/);
      assert.deepEqual(values, [
        IDs.actor, IDs.request, IDs.client, IDs.company, IDs.building,
      ]);
      return { rows };
    },
  };
}

async function authorize(rows: Array<{ tenant_pic_id: string }>) {
  return assertHandymanTenantDecisionActor(executor(rows) as never, {
    actorUserId: IDs.actor,
    handymanRequestId: IDs.request,
    clientId: IDs.client,
    tenantCompanyId: IDs.company,
    buildingId: IDs.building,
  });
}

function code(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

describe('CR-HM-TENANT-ACTOR-01 authority contract', () => {
  it('accepts only the exact active request PIC resolved by authoritative joins', async () => {
    assert.deepEqual(await authorize([{ tenant_pic_id: IDs.pic }]), {
      tenantPicId: IDs.pic,
    });
  });

  for (const scenario of [
    'wrong Tenant Company',
    'wrong Building',
    'same Building but unrelated Unit/Request',
    'revoked or expired authorization',
    'Customer Care without exact-request authority',
  ]) {
    it(`fails closed for ${scenario}`, async () => {
      await assert.rejects(
        authorize([]),
        (error: unknown) =>
          code(error) === 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN',
      );
    });
  }
});
