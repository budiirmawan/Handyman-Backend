import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, ERROR_CODES } from '../src/shared/errors';
import {
  HANDYMAN_BAST_PART01_EVENT_TYPES,
  HANDYMAN_BAST_STATUSES,
} from '../src/modules/handyman-bast/handyman-bast.types';
import { nextHandymanBastStatus }
  from '../src/modules/handyman-bast/handyman-bast.lifecycle';

/**
 * CR-HM-11 PART 01 — BAST aggregate transition guards ONLY.
 * No HTTP, no ACCEPT/REJECT application, no session COMPLETE mapping.
 */

describe('CR-HM-11 PART 01 BAST lifecycle', () => {
  it('freezes status and PART 01 event vocabularies', () => {
    assert.deepEqual([...HANDYMAN_BAST_STATUSES], [
      'DRAFT', 'ISSUED', 'ACCEPTED', 'REJECTED', 'VOID',
    ]);
    assert.deepEqual([...HANDYMAN_BAST_PART01_EVENT_TYPES], [
      'PREPARE', 'ISSUE', 'VOID',
    ]);
  });

  it('ISSUE is legal only from DRAFT', () => {
    assert.equal(nextHandymanBastStatus('DRAFT', 'ISSUE'), 'ISSUED');
    assert.throws(
      () => nextHandymanBastStatus('ISSUED', 'ISSUE'),
      (err: unknown) =>
        err instanceof AppError
        && err.code === ERROR_CODES.HANDYMAN_BAST_ILLEGAL_TRANSITION,
    );
    assert.throws(
      () => nextHandymanBastStatus('VOID', 'ISSUE'),
      (err: unknown) =>
        err instanceof AppError
        && err.code === ERROR_CODES.HANDYMAN_BAST_ILLEGAL_TRANSITION,
    );
  });

  it('VOID is legal from DRAFT or ISSUED, never ACCEPTED', () => {
    assert.equal(nextHandymanBastStatus('DRAFT', 'VOID'), 'VOID');
    assert.equal(nextHandymanBastStatus('ISSUED', 'VOID'), 'VOID');
    assert.throws(
      () => nextHandymanBastStatus('ACCEPTED', 'VOID'),
      (err: unknown) =>
        err instanceof AppError
        && err.code === ERROR_CODES.HANDYMAN_BAST_ILLEGAL_TRANSITION,
    );
    assert.throws(
      () => nextHandymanBastStatus('VOID', 'VOID'),
      (err: unknown) =>
        err instanceof AppError
        && err.code === ERROR_CODES.HANDYMAN_BAST_ILLEGAL_TRANSITION,
    );
  });

  it('ACCEPT/REJECT are reserved (PART 02); COMPLETE is not acceptance', () => {
    assert.throws(
      () => nextHandymanBastStatus('ISSUED', 'ACCEPT'),
      (err: unknown) =>
        err instanceof AppError
        && err.code === ERROR_CODES.HANDYMAN_BAST_SIGN_OFF_RESERVED,
    );
    assert.throws(
      () => nextHandymanBastStatus('ISSUED', 'REJECT'),
      (err: unknown) =>
        err instanceof AppError
        && err.code === ERROR_CODES.HANDYMAN_BAST_SIGN_OFF_RESERVED,
    );
    assert.throws(
      () => nextHandymanBastStatus('DRAFT', 'COMPLETE'),
      (err: unknown) =>
        err instanceof AppError
        && err.code === ERROR_CODES.HANDYMAN_BAST_ILLEGAL_TRANSITION,
    );
    assert.throws(
      () => nextHandymanBastStatus('DRAFT', 'QUOTATION_APPROVAL'),
      (err: unknown) =>
        err instanceof AppError
        && err.code === ERROR_CODES.HANDYMAN_BAST_ILLEGAL_TRANSITION,
    );
  });
});
