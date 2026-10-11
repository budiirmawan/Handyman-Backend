import { describe, it } from 'node:test';

const G9_BLOCKER =
  'G9 BLOCKER: no authorized TENANT_PIC integration/capability provisioning path is established. ' +
  'The available setIntegrationActorCapability service has no acting-user parameter or HTTP route, ' +
  'and there is no seed. Do not provision it by direct repository/service calls.';

describe('W03 PART 03H-05 — integrated Customer Care to Tenant PIC approval journey', () => {
  // Fail closed until Operations/Security establish an attributable provisioning
  // contract. A test-only direct call to the repository or capability service is
  // not evidence of authorized integration provisioning.
  it('Customer Care intake → Operations triage → quotation → PIC APPROVE → Execution Scope', {
    skip: G9_BLOCKER,
  }, () => {});
});
