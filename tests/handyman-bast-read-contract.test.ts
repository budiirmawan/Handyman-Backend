import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HANDYMAN_NOT_BAST_ACCEPTANCE,
  isHandymanCustomerBastAccepted,
  isHandymanWarrantyStartEligible,
  isNotBastAcceptanceAlias,
  toHandymanBastAcceptanceReadContract,
} from '../src/modules/handyman-bast/handyman-bast.read-contract';
import type { HandymanBastRecord }
  from '../src/modules/handyman-bast/handyman-bast.types';
import { nextHandymanBastStatus }
  from '../src/modules/handyman-bast/handyman-bast.lifecycle';

/**
 * CR-HM-11 PART 03 — published BAST/acceptance read contract ONLY.
 * No HTTP, no warranty engine, no ledger, no new lifecycle writes.
 */

function bast(partial: Partial<HandymanBastRecord>): HandymanBastRecord {
  const now = new Date('2026-09-29T00:00:00.000Z');
  return {
    id: '11111111-1111-1111-1111-111111111111',
    clientId: '22222222-2222-2222-2222-222222222222',
    executionScopeId: '33333333-3333-3333-3333-333333333333',
    status: 'DRAFT',
    issuedAt: null,
    acceptedAt: null,
    rejectedAt: null,
    voidedAt: null,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

describe('CR-HM-11 PART 03 BAST acceptance read contract', () => {
  it('publishes COMPLETE/approval/QC/FM aliases as NOT acceptance', () => {
    assert.deepEqual([...HANDYMAN_NOT_BAST_ACCEPTANCE], [
      'SESSION_COMPLETE',
      'CHECK_OUT',
      'QUOTATION_APPROVAL',
      'QC_PASS',
      'FM_BAST_STATUS',
    ]);
    for (const alias of HANDYMAN_NOT_BAST_ACCEPTANCE) {
      assert.equal(isNotBastAcceptanceAlias(alias), true);
      assert.equal(isHandymanCustomerBastAccepted('ACCEPTED'), true);
      assert.notEqual(alias, 'ACCEPTED');
    }
  });

  it('only ACCEPTED is customerAccepted and warrantyStartEligible', () => {
    assert.equal(isHandymanCustomerBastAccepted('ACCEPTED'), true);
    assert.equal(isHandymanWarrantyStartEligible('ACCEPTED'), true);
    for (const status of ['DRAFT', 'ISSUED', 'REJECTED', 'VOID'] as const) {
      assert.equal(isHandymanCustomerBastAccepted(status), false);
      assert.equal(isHandymanWarrantyStartEligible(status), false);
    }
  });

  it('projects PART 01–02 status without inventing ACCEPTED', () => {
    const issued = toHandymanBastAcceptanceReadContract(bast({
      status: 'ISSUED',
      issuedAt: new Date('2026-09-29T01:00:00.000Z'),
    }));
    assert.equal(issued.status, 'ISSUED');
    assert.equal(issued.customerAccepted, false);
    assert.equal(issued.warrantyStartEligible, false);
    assert.equal(issued.acceptedAt, null);

    const accepted = toHandymanBastAcceptanceReadContract(bast({
      status: 'ACCEPTED',
      issuedAt: new Date('2026-09-29T01:00:00.000Z'),
      acceptedAt: new Date('2026-09-29T02:00:00.000Z'),
    }));
    assert.equal(accepted.customerAccepted, true);
    assert.equal(accepted.warrantyStartEligible, true);
    assert.ok(accepted.acceptedAt);

    const rejected = toHandymanBastAcceptanceReadContract(bast({
      status: 'REJECTED',
      rejectedAt: new Date('2026-09-29T03:00:00.000Z'),
      acceptedAt: new Date('2026-09-29T02:00:00.000Z'),
    }));
    assert.equal(rejected.customerAccepted, false);
    assert.equal(rejected.acceptedAt, null);
    assert.ok(rejected.rejectedAt);
  });

  it('COMPLETE and quotation approval never equal ACCEPT on the machine', () => {
    assert.equal(nextHandymanBastStatus('ISSUED', 'ACCEPT'), 'ACCEPTED');
    assert.throws(() => nextHandymanBastStatus('ISSUED', 'COMPLETE'));
    assert.throws(() => nextHandymanBastStatus('ISSUED', 'QUOTATION_APPROVAL'));
    assert.throws(() => nextHandymanBastStatus('ISSUED', 'SESSION_COMPLETE'));
    assert.throws(() => nextHandymanBastStatus('ISSUED', 'QC_PASS'));
  });
});
