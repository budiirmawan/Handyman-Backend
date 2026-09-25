/**
 * Test helpers for seeding active SaaS subscription + matching subscription
 * data needed by PART 07 domain tests.
 */
import { randomUUID } from 'node:crypto';
import { currencyRepository } from '../../src/modules/currencies';
import { userService } from '../../src/modules/users';
import { createSaasProduct } from '../../src/modules/platform-products';
import { createSaasPackage } from '../../src/modules/platform-products';
import { createSaasPricebook } from '../../src/modules/platform-pricebooks';
import { createSaasPricebookVersion } from '../../src/modules/platform-pricebooks';
import { publishSaasPricebookVersion } from '../../src/modules/platform-pricebooks';
import { createSaasSubscription } from '../../src/modules/platform-subscriptions';
import { activateSaasSubscription } from '../../src/modules/platform-subscriptions';

export async function seedActiveSubscriptionForCore(
  actorId: string,
  authoritySubscription: string,
  params: {
    clientId: string;
    packageAmount: string;
    currencyCode: string;
  },
): Promise<{ id: string }> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const currency = await currencyRepository.find(params.currencyCode);
  if (!currency) {
    throw new Error(`currency ${params.currencyCode} must exist (seed first)`);
  }
  const product = await createSaasProduct(actorId, 'platform.product.manage', {
    code: `P07${suffix}`,
    name: 'PART 07 product',
  });
  const pkg = await createSaasPackage(actorId, 'platform.product.manage', {
    productId: product.id,
    code: `PKG07${suffix}`,
    name: 'PART 07 package',
  });
  const book = await createSaasPricebook(actorId, 'platform.pricebook.manage', {
    code: `BK07${suffix}`,
    name: 'PART 07 pricebook',
    currencyCode: params.currencyCode,
  });
  const version = await createSaasPricebookVersion(
    actorId,
    'platform.pricebook.manage',
    book.id,
    {
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      items: [
        {
          productId: product.id,
          packageId: pkg.id,
          billingCycle: 'MONTHLY',
          basePrice: Number(params.packageAmount),
          includedBuildingCount: 1,
          additionalBuildingPrice: 0,
        },
      ],
    },
  );
  await publishSaasPricebookVersion(
    actorId,
    'platform.pricebook.manage',
    version.id,
    `pb-${suffix}`,
  );
  const draft = (
    await createSaasSubscription(actorId, authoritySubscription, {
      clientId: params.clientId,
      productId: product.id,
      packageId: pkg.id,
      pricebookVersionId: version.id,
      billingCycle: 'MONTHLY',
      currencyCode: params.currencyCode,
    }, `sub-${suffix}`)
  ).data;
  await activateSaasSubscription(actorId, authoritySubscription, draft.id, {
    mode: 'ACTIVE',
  }, `act-${suffix}`);
  return { id: draft.id };
}
