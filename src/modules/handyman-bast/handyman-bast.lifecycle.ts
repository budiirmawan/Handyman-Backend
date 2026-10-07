/**
 * CR-HM-11 PART 01+02 — BAST status guards.
 * ISSUE: DRAFT → ISSUED. VOID: DRAFT|ISSUED → VOID.
 * ACCEPT/REJECT: ISSUED → ACCEPTED|REJECTED (PART 02).
 * Sign-off never writes status by itself; nextHandymanBastStatus is
 * the only status authority. Session COMPLETE / quotation approval /
 * QC PASS never produce ACCEPTED.
 */

import {
  handymanBastIllegalTransitionError,
  handymanBastSignatureRequiredError,
} from './handyman-bast.errors';
import type {
  HandymanBastPart01EventType,
  HandymanBastStatus,
} from './handyman-bast.types';

const ISSUE_FROM: readonly HandymanBastStatus[] = ['DRAFT'];
const VOID_FROM: readonly HandymanBastStatus[] = ['DRAFT', 'ISSUED'];
const SIGN_OFF_FROM: readonly HandymanBastStatus[] = ['ISSUED'];

export function nextHandymanBastStatus(
  from: HandymanBastStatus,
  action: string,
): HandymanBastStatus {
  if (action === 'ISSUE') {
    if (!ISSUE_FROM.includes(from)) {
      throw handymanBastIllegalTransitionError(from, action);
    }
    return 'ISSUED';
  }
  if (action === 'VOID') {
    if (!VOID_FROM.includes(from)) {
      throw handymanBastIllegalTransitionError(from, action);
    }
    return 'VOID';
  }
  if (action === 'ACCEPT') {
    if (!SIGN_OFF_FROM.includes(from)) {
      throw handymanBastIllegalTransitionError(from, action);
    }
    return 'ACCEPTED';
  }
  if (action === 'REJECT') {
    if (!SIGN_OFF_FROM.includes(from)) {
      throw handymanBastIllegalTransitionError(from, action);
    }
    return 'REJECTED';
  }
  throw handymanBastIllegalTransitionError(from, action);
}

/** ACCEPT requires a non-empty signature digest. REJECT may omit. */
export function assertHandymanBastSignature(
  action: 'ACCEPT' | 'REJECT',
  signatureDigest: string | undefined | null,
): string {
  const raw = typeof signatureDigest === 'string'
    ? signatureDigest.trim()
    : '';
  if (action === 'ACCEPT' && raw.length === 0) {
    throw handymanBastSignatureRequiredError();
  }
  if (raw.length > 512) {
    throw handymanBastSignatureRequiredError();
  }
  return raw;
}

export function isPart01BastAction(
  action: string,
): action is HandymanBastPart01EventType {
  return action === 'ISSUE' || action === 'VOID' || action === 'PREPARE';
}
