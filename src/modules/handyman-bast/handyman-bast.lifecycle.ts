/**
 * CR-HM-11 PART 01 — BAST status guards ONLY.
 * ISSUE: DRAFT → ISSUED. VOID: DRAFT|ISSUED → VOID.
 * ACCEPT/REJECT are never applied here (PART 02).
 * Session COMPLETE / quotation approval / QC PASS never produce
 * ACCEPTED.
 */

import {
  handymanBastIllegalTransitionError,
  handymanBastSignOffReservedError,
} from './handyman-bast.errors';
import type {
  HandymanBastPart01EventType,
  HandymanBastStatus,
} from './handyman-bast.types';

const ISSUE_FROM: readonly HandymanBastStatus[] = ['DRAFT'];
const VOID_FROM: readonly HandymanBastStatus[] = ['DRAFT', 'ISSUED'];

export function nextHandymanBastStatus(
  from: HandymanBastStatus,
  action: string,
): HandymanBastStatus {
  if (action === 'ACCEPT' || action === 'REJECT') {
    throw handymanBastSignOffReservedError(action);
  }
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
  if (action === 'PREPARE') {
    throw handymanBastIllegalTransitionError(from, action);
  }
  throw handymanBastIllegalTransitionError(from, action);
}

export function isPart01BastAction(
  action: string,
): action is HandymanBastPart01EventType {
  return action === 'ISSUE' || action === 'VOID' || action === 'PREPARE';
}
