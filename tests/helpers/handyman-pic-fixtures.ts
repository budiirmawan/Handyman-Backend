import { randomBytes, randomUUID } from 'node:crypto';
import {
  handoffIntegrationSecretEnvName,
  handoffRuntimeRepository,
} from '../../src/modules/handyman-handoff';
import { handymanCareActorService } from '../../src/modules/handyman-care-actors';
import {
  PIC_WORKSPACE_PURPOSE,
  admitPicWorkspace,
  signPicWorkspaceAssertion,
  type PicWorkspaceAssertion,
} from '../../src/modules/handyman-pic-session';
import {
  bindHandymanQuotationApprovalBinding,
} from '../../src/modules/handyman-quotation-approval-bindings';
import { submitPicQuotationDecision } from '../../src/modules/handyman-pic-portal';
import {
  getHandymanExecutionScopeByQuotationVersion,
  getHandymanQuotationDecision,
  type DecideHandymanQuotationInput,
} from '../../src/modules/handyman-quotations';

/**
 * 03F consumer fixtures must obtain real PIC approval, never restore the closed
 * staff decision path or plant a scope. Explicit staff binding + signed PIC
 * admission use the production services and every live DB guard. This helper
 * grants no permission/role and does not activate B12 or provision a shadow user.
 */
export async function admitFixturePic(context: {
  tenantCompanyId: string;
  tenantPicId: string;
  buildingId: string;
  spaceId: string | null;
}) {
  const code = `TEST_PIC_${randomUUID().slice(0, 8)}`;
  const integration = await handoffRuntimeRepository.createIntegration({
    integrationCode: code,
    displayName: 'Isolated PIC fixture attester',
  });
  await handymanCareActorService.setIntegrationActorCapability({
    integrationId: integration.id,
    capability: 'TENANT_PIC',
  });
  const secret = randomBytes(32).toString('hex');
  const key = handoffIntegrationSecretEnvName(code);
  process.env[key] = secret;
  try {
    const now = Date.now();
    const assertion: PicWorkspaceAssertion = {
      purpose: PIC_WORKSPACE_PURPOSE,
      integrationCode: code,
      assertionId: randomUUID(),
      issuedAt: new Date(now - 2_000).toISOString(),
      expiresAt: new Date(now + 120_000).toISOString(),
      representation: {
        tenantCompanyId: context.tenantCompanyId,
        tenantPicId: context.tenantPicId,
        buildingId: context.buildingId,
        ...(context.spaceId ? { spaceId: context.spaceId } : {}),
      },
    };
    return await admitPicWorkspace(assertion, signPicWorkspaceAssertion(assertion, secret));
  } finally {
    delete process.env[key];
  }
}

export async function bindAndAdmitFixturePic(context: {
  quotationId: string;
  tenantCompanyId: string;
  tenantPicId: string;
  buildingId: string;
  spaceId: string | null;
  granterUserId: string;
}) {
  const bound = await bindHandymanQuotationApprovalBinding({
    quotationId: context.quotationId,
    tenantPicId: context.tenantPicId,
    idempotencyKey: `fixture-bind-${randomUUID()}`,
  }, context.granterUserId);
  const session = await admitFixturePic({
    tenantCompanyId: context.tenantCompanyId,
    tenantPicId: context.tenantPicId,
    buildingId: context.buildingId,
    spaceId: context.spaceId,
  });
  return { ...session, binding: bound.data.binding };
}

/** Return the existing staff READ shape after an authenticated PIC write. */
export async function decideFixturePic(
  token: string,
  versionId: string,
  input: DecideHandymanQuotationInput,
  readerUserId: string,
) {
  const result = await submitPicQuotationDecision(
    token, versionId, { decision: input.decision }, input.idempotencyKey,
  );
  const decision = await getHandymanQuotationDecision(versionId, readerUserId);
  const scope = result.executionScope
    ? await getHandymanExecutionScopeByQuotationVersion(versionId, readerUserId)
    : null;
  return { ...decision, executionScope: scope };
}
