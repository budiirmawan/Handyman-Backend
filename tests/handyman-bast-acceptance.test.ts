import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, ERROR_CODES } from '../src/shared/errors';
import {
  HANDYMAN_BAST_PART02_EVENT_TYPES,
} from '../src/modules/handyman-bast/handyman-bast.types';
import {
  assertHandymanBastSignature,
  nextHandymanBastStatus,
} from '../src/modules/handyman-bast/handyman-bast.lifecycle';

/**
 * CR-HM-11 PART 02 — state-gated ACCEPT/REJECT + signature ONLY.
 * No HTTP, no warranty, no ledger. COMPLETE != ACCEPT.
 */

describe('CR-HM-11 PART 02 customer BAST acceptance', () => {
  it('freezes PART 02 event vocabulary', () => {
    assert.deepEqual([...HANDYMAN_BAST_PART02_EVENT_TYPES], [
      'ACCEPT', 'REJECT',
    ]);
  });

  it('ACCEPT/REJECT are legal only from ISSUED', () => {
    assert.equal(nextHandymanBastStatus('ISSUED', 'ACCEPT'), 'ACCEPTED');
    assert.equal(nextHandymanBastStatus('ISSUED', 'REJECT'), 'REJECTED');
    for (const from of ['DRAFT', 'ACCEPTED', 'REJECTED', 'VOID'] as const) {
      assert.throws(
        () => nextHandymanBastStatus(from, 'ACCEPT'),
        (err: unknown) =>
          err instanceof AppError
          && err.code === ERROR_CODES.HANDYMAN_BAST_ILLEGAL_TRANSITION,
      );
      assert.throws(
        () => nextHandymanBastStatus(from, 'REJECT'),
        (err: unknown) =>
          err instanceof AppError
          && err.code === ERROR_CODES.HANDYMAN_BAST_ILLEGAL_TRANSITION,
      );
    }
  });

  it('ACCEPT requires a signature digest; REJECT may omit', () => {
    assert.equal(
      assertHandymanBastSignature('ACCEPT', '  sha256:abc  '),
      'sha256:abc',
    );
    assert.equal(assertHandymanBastSignature('REJECT', ''), '');
    assert.throws(
      () => assertHandymanBastSignature('ACCEPT', '   '),
      (err: unknown) =>
        err instanceof AppError
        && err.code === ERROR_CODES.HANDYMAN_BAST_SIGNATURE_REQUIRED,
    );
    assert.throws(
      () => assertHandymanBastSignature('ACCEPT', undefined),
      (err: unknown) =>
        err instanceof AppError
        && err.code === ERROR_CODES.HANDYMAN_BAST_SIGNATURE_REQUIRED,
    );
  });

  it('COMPLETE / quotation approval / QC PASS never become ACCEPTED', () => {
    assert.throws(
      () => nextHandymanBastStatus('ISSUED', 'COMPLETE'),
      (err: unknown) =>
        err instanceof AppError
        && err.code === ERROR_CODES.HANDYMAN_BAST_ILLEGAL_TRANSITION,
    );
    assert.throws(
      () => nextHandymanBastStatus('ISSUED', 'QUOTATION_APPROVAL'),
      (err: unknown) =>
        err instanceof AppError
        && err.code === ERROR_CODES.HANDYMAN_BAST_ILLEGAL_TRANSITION,
    );
    assert.throws(
      () => nextHandymanBastStatus('ISSUED', 'QC_PASS'),
      (err: unknown) =>
        err instanceof AppError
        && err.code === ERROR_CODES.HANDYMAN_BAST_ILLEGAL_TRANSITION,
    );
    assert.notEqual(
      nextHandymanBastStatus('ISSUED', 'ACCEPT'),
      'ISSUED',
    );
  });
});
