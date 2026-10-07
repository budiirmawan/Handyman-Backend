/**
 * CR-HM-17 P1 FIX02 — focused contract/runtime tests for
 * availableActions on B5, B6, and B7 Customer Care reads.
 *
 * Verifies:
 * - B5 BAST: ACCEPT/REJECT only when ISSUED
 * - B6 Payment: CONFIRM/REJECT only when PENDING
 * - B7 Claim: APPROVE/REJECT/WITHDRAW rules per claim status
 * - B7 Rework: AUTHORIZE only when REWORK_DRAFT
 * - B7 Chargeable: ACCEPT/REJECT only when CHARGEABLE_PROPOSED
 * - No lifecycle authority weakening
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeBastAvailableActions } from '../src/modules/handyman-bast/handyman-bast.available-actions';
import { computePaymentAvailableActions } from '../src/modules/handyman-customer-payments/handyman-customer-payment.available-actions';
import {
  computeChargeableWorkAvailableActions,
  computeClaimAvailableActions,
  computeReworkAvailableActions,
} from '../src/modules/handyman-service-warranties/handyman-service-warranty.available-actions';
import type { HandymanBastStatus } from '../src/modules/handyman-bast';
import type { HandymanCustomerPaymentStatus } from '../src/modules/handyman-customer-payments';
import type { HandymanServiceWarrantyClaimStatus } from '../src/modules/handyman-service-warranty-claims';
import type { HandymanServiceWarrantyReworkStatus } from '../src/modules/handyman-service-warranty-reworks';
import type { HandymanChargeableAdditionalWorkStatus } from '../src/modules/handyman-chargeable-additional-works';

describe('CR-HM-17 P1 FIX02 — B5 BAST availableActions', () => {
  const allStatuses: HandymanBastStatus[] = [
    'DRAFT', 'ISSUED', 'ACCEPTED', 'REJECTED', 'VOID',
  ];

  it('ISSUED → ACCEPT and REJECT', () => {
    const actions = computeBastAvailableActions('ISSUED');
    assert.deepEqual([...actions], ['ACCEPT', 'REJECT']);
  });

  it('DRAFT → no actions', () => {
    const actions = computeBastAvailableActions('DRAFT');
    assert.deepEqual([...actions], []);
  });

  it('ACCEPTED → no actions (terminal)', () => {
    const actions = computeBastAvailableActions('ACCEPTED');
    assert.deepEqual([...actions], []);
  });

  it('REJECTED → no actions (terminal)', () => {
    const actions = computeBastAvailableActions('REJECTED');
    assert.deepEqual([...actions], []);
  });

  it('VOID → no actions (terminal)', () => {
    const actions = computeBastAvailableActions('VOID');
    assert.deepEqual([...actions], []);
  });

  it('only ISSUED status has non-empty actions', () => {
    for (const status of allStatuses) {
      const actions = computeBastAvailableActions(status);
      if (status === 'ISSUED') {
        assert.ok(actions.length > 0, `ISSUED should have actions`);
      } else {
        assert.equal(actions.length, 0, `${status} should have no actions`);
      }
    }
  });
});

describe('CR-HM-17 P1 FIX02 — B6 payment availableActions', () => {
  const allStatuses: HandymanCustomerPaymentStatus[] = [
    'PENDING', 'CONFIRMED', 'REJECTED',
  ];

  it('PENDING → CONFIRM and REJECT', () => {
    const actions = computePaymentAvailableActions('PENDING');
    assert.deepEqual([...actions], ['CONFIRM', 'REJECT']);
  });

  it('CONFIRMED → no actions (terminal)', () => {
    const actions = computePaymentAvailableActions('CONFIRMED');
    assert.deepEqual([...actions], []);
  });

  it('REJECTED → no actions (terminal)', () => {
    const actions = computePaymentAvailableActions('REJECTED');
    assert.deepEqual([...actions], []);
  });

  it('only PENDING status has non-empty actions', () => {
    for (const status of allStatuses) {
      const actions = computePaymentAvailableActions(status);
      if (status === 'PENDING') {
        assert.ok(actions.length > 0, `PENDING should have actions`);
      } else {
        assert.equal(actions.length, 0, `${status} should have no actions`);
      }
    }
  });
});

describe('CR-HM-17 P1 FIX02 — B7 claim availableActions', () => {
  const allStatuses: HandymanServiceWarrantyClaimStatus[] = [
    'CLAIM_DRAFT', 'CLAIM_SUBMITTED', 'CLAIM_APPROVED',
    'CLAIM_REJECTED', 'CLAIM_WITHDRAWN',
  ];

  it('CLAIM_DRAFT → WITHDRAW', () => {
    const actions = computeClaimAvailableActions('CLAIM_DRAFT');
    assert.deepEqual([...actions], ['WITHDRAW']);
  });

  it('CLAIM_SUBMITTED → APPROVE, REJECT, WITHDRAW', () => {
    const actions = computeClaimAvailableActions('CLAIM_SUBMITTED');
    assert.deepEqual([...actions], ['APPROVE', 'REJECT', 'WITHDRAW']);
  });

  it('CLAIM_APPROVED → no actions (terminal)', () => {
    const actions = computeClaimAvailableActions('CLAIM_APPROVED');
    assert.deepEqual([...actions], []);
  });

  it('CLAIM_REJECTED → no actions (terminal)', () => {
    const actions = computeClaimAvailableActions('CLAIM_REJECTED');
    assert.deepEqual([...actions], []);
  });

  it('CLAIM_WITHDRAWN → no actions (terminal)', () => {
    const actions = computeClaimAvailableActions('CLAIM_WITHDRAWN');
    assert.deepEqual([...actions], []);
  });

  it('terminal statuses never have actions', () => {
    const terminals: HandymanServiceWarrantyClaimStatus[] = [
      'CLAIM_APPROVED', 'CLAIM_REJECTED', 'CLAIM_WITHDRAWN',
    ];
    for (const status of terminals) {
      const actions = computeClaimAvailableActions(status);
      assert.equal(actions.length, 0, `${status} should have no actions`);
    }
  });
});

describe('CR-HM-17 P1 FIX02 — B7 rework availableActions', () => {
  const allStatuses: HandymanServiceWarrantyReworkStatus[] = [
    'REWORK_DRAFT', 'REWORK_AUTHORIZED', 'REWORK_IN_PROGRESS',
    'REWORK_COMPLETE', 'REWORK_VERIFIED',
  ];

  it('REWORK_DRAFT → AUTHORIZE', () => {
    const actions = computeReworkAvailableActions('REWORK_DRAFT');
    assert.deepEqual([...actions], ['AUTHORIZE']);
  });

  it('REWORK_AUTHORIZED → no BM actions (provider starts)', () => {
    const actions = computeReworkAvailableActions('REWORK_AUTHORIZED');
    assert.deepEqual([...actions], []);
  });

  it('REWORK_IN_PROGRESS → no BM actions (provider completes)', () => {
    const actions = computeReworkAvailableActions('REWORK_IN_PROGRESS');
    assert.deepEqual([...actions], []);
  });

  it('REWORK_COMPLETE → no BM actions (lead verifies)', () => {
    const actions = computeReworkAvailableActions('REWORK_COMPLETE');
    assert.deepEqual([...actions], []);
  });

  it('REWORK_VERIFIED → no actions (terminal)', () => {
    const actions = computeReworkAvailableActions('REWORK_VERIFIED');
    assert.deepEqual([...actions], []);
  });

  it('only REWORK_DRAFT has BM actions', () => {
    for (const status of allStatuses) {
      const actions = computeReworkAvailableActions(status);
      if (status === 'REWORK_DRAFT') {
        assert.ok(actions.length > 0, `REWORK_DRAFT should have actions`);
      } else {
        assert.equal(actions.length, 0, `${status} should have no BM actions`);
      }
    }
  });
});

describe('CR-HM-17 P1 FIX02 — B7 chargeable work availableActions', () => {
  const allStatuses: HandymanChargeableAdditionalWorkStatus[] = [
    'CHARGEABLE_PROPOSED', 'CHARGEABLE_AUTHORIZED', 'CHARGEABLE_REJECTED',
  ];

  it('CHARGEABLE_PROPOSED → ACCEPT and REJECT', () => {
    const actions = computeChargeableWorkAvailableActions('CHARGEABLE_PROPOSED');
    assert.deepEqual([...actions], ['ACCEPT', 'REJECT']);
  });

  it('CHARGEABLE_AUTHORIZED → no actions (terminal)', () => {
    const actions = computeChargeableWorkAvailableActions('CHARGEABLE_AUTHORIZED');
    assert.deepEqual([...actions], []);
  });

  it('CHARGEABLE_REJECTED → no actions (terminal)', () => {
    const actions = computeChargeableWorkAvailableActions('CHARGEABLE_REJECTED');
    assert.deepEqual([...actions], []);
  });

  it('only CHARGEABLE_PROPOSED has actions', () => {
    for (const status of allStatuses) {
      const actions = computeChargeableWorkAvailableActions(status);
      if (status === 'CHARGEABLE_PROPOSED') {
        assert.ok(actions.length > 0, `CHARGEABLE_PROPOSED should have actions`);
      } else {
        assert.equal(actions.length, 0, `${status} should have no actions`);
      }
    }
  });
});

describe('CR-HM-17 P1 FIX02 — authority preservation', () => {
  it('B5: no new lifecycle rules (only status-derived)', () => {
    // ISSUED is the only status where Customer Care can act
    // This matches CR-HM-11 PART 02 sign-off authority
    const actions = computeBastAvailableActions('ISSUED');
    assert.ok(actions.includes('ACCEPT'));
    assert.ok(actions.includes('REJECT'));
    assert.equal(actions.length, 2);
  });

  it('B6: no new lifecycle rules (only status-derived)', () => {
    // PENDING is the only status where Customer Care can decide
    // This matches CR-HM-13 PART 03 payment decision authority
    const actions = computePaymentAvailableActions('PENDING');
    assert.ok(actions.includes('CONFIRM'));
    assert.ok(actions.includes('REJECT'));
    assert.equal(actions.length, 2);
  });

  it('B7 claim: no new lifecycle rules (only status-derived)', () => {
    // CLAIM_SUBMITTED allows BM to APPROVE or REJECT
    // This matches CR-HM-15 PART 02 claim decision authority
    const actions = computeClaimAvailableActions('CLAIM_SUBMITTED');
    assert.ok(actions.includes('APPROVE'));
    assert.ok(actions.includes('REJECT'));
  });

  it('B7 rework: no new lifecycle rules (only status-derived)', () => {
    // REWORK_DRAFT allows BM to AUTHORIZE
    // This matches CR-HM-15 PART 03 rework authorization authority
    const actions = computeReworkAvailableActions('REWORK_DRAFT');
    assert.ok(actions.includes('AUTHORIZE'));
    assert.equal(actions.length, 1);
  });

  it('B7 chargeable: PROPOSED allows ACCEPT/REJECT (terminal statuses empty)', () => {
    // CHARGEABLE_PROPOSED allows Customer Care to ACCEPT or REJECT
    // This matches CR-HM-15 PART 04 chargeable work decision authority
    const proposedActions = computeChargeableWorkAvailableActions('CHARGEABLE_PROPOSED');
    assert.ok(proposedActions.includes('ACCEPT'));
    assert.ok(proposedActions.includes('REJECT'));
    assert.equal(proposedActions.length, 2);
    // Terminal statuses have no actions
    const authorizedActions = computeChargeableWorkAvailableActions('CHARGEABLE_AUTHORIZED');
    assert.equal(authorizedActions.length, 0);
    const rejectedActions = computeChargeableWorkAvailableActions('CHARGEABLE_REJECTED');
    assert.equal(rejectedActions.length, 0);
  });
});
