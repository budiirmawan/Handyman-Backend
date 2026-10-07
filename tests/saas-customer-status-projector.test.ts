import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectCustomerStatusFromStatuses } from '../src/modules/platform-subscriptions/saas-customer-status.projector';

/**
 * CR-BE-SAAS-01 PART 03 — canonical customer-status projector
 * (frozen §7.2 / §11.2 rule 4).
 *
 * This is the SINGLE SOURCE OF TRUTH for the healthy-wins rule.
 * PART 03 lifecycle and PART 10 (tenant-health + commercial-summary)
 * must reuse this projector without reimplementing it.
 *
 * Mandatory multi-subscription proof (frozen §11.2 rule 4):
 *   ACTIVE + SUSPENDED  → ACTIVE
 *   GRACE   + SUSPENDED  → GRACE
 *   SUSPENDED only      → SUSPENDED
 *   TRIAL  only         → TRIAL
 *   DRAFT only          → PROSPECT
 *   no subscriptions    → PROSPECT
 *   otherwise           → TERMINATED
 */
describe('CR-BE-SAAS-01 PART 03 — canonical customer-status projector (frozen §7.2)', () => {
  it('ACTIVE + SUSPENDED → ACTIVE (healthy wins)', () => {
    assert.equal(
      projectCustomerStatusFromStatuses(['SUSPENDED', 'ACTIVE']),
      'ACTIVE',
    );
    assert.equal(
      projectCustomerStatusFromStatuses(['ACTIVE', 'GRACE']),
      'ACTIVE',
    );
  });

  it('GRACE + SUSPENDED → GRACE (healthy wins after ACTIVE/TRIAL)', () => {
    assert.equal(
      projectCustomerStatusFromStatuses(['SUSPENDED', 'GRACE']),
      'GRACE',
    );
    assert.equal(
      projectCustomerStatusFromStatuses(['PAST_DUE', 'SUSPENDED']),
      'GRACE',
    );
  });

  it('SUSPENDED only → SUSPENDED', () => {
    assert.equal(
      projectCustomerStatusFromStatuses(['SUSPENDED']),
      'SUSPENDED',
    );
  });

  it('TRIAL only → TRIAL', () => {
    assert.equal(
      projectCustomerStatusFromStatuses(['TRIAL']),
      'TRIAL',
    );
  });

  it('DRAFT only → PROSPECT (in-progress only)', () => {
    assert.equal(
      projectCustomerStatusFromStatuses(['DRAFT']),
      'PROSPECT',
    );
    assert.equal(
      projectCustomerStatusFromStatuses(['PENDING']),
      'PROSPECT',
    );
  });

  it('no subscriptions → PROSPECT', () => {
    assert.equal(
      projectCustomerStatusFromStatuses([]),
      'PROSPECT',
    );
  });

  it('otherwise → TERMINATED', () => {
    assert.equal(
      projectCustomerStatusFromStatuses(['CANCELLED']),
      'TERMINATED',
    );
    assert.equal(
      projectCustomerStatusFromStatuses(['EXPIRED']),
      'TERMINATED',
    );
  });
});
