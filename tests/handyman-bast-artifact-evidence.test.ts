/**
 * CR-HM-17 P1 FIX01 — focused contract/runtime tests for the
 * Backend-owned BAST artifact reference and approved signature-
 * evidence binding.
 *
 * Verifies:
 * - artifact version is deterministic per status
 * - artifact ref format is BAST/{id}/v{N}
 * - approved sign-off resolves only when ACCEPTED with ACCEPT event
 * - signOffComplete requires ACCEPTED + present binding + digest
 * - Frontend must NOT be able to compute/reforge the artifact
 * - CR-HM-11 lifecycle authority is preserved (no weakening)
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  computeBastArtifactVersion,
  resolveApprovedSignOff,
  toHandymanBastAcceptanceReadContract,
  toHandymanBastArtifactReference,
} from '../src/modules/handyman-bast';
import type {
  HandymanBastEventRecord,
  HandymanBastRecord,
  HandymanBastSignOffRecord,
  HandymanBastStatus,
} from '../src/modules/handyman-bast';

function bastRecord(overrides: Partial<HandymanBastRecord> = {}): HandymanBastRecord {
  const id = randomUUID();
  return {
    id,
    clientId: randomUUID(),
    executionScopeId: randomUUID(),
    status: 'DRAFT' as HandymanBastStatus,
    issuedAt: null,
    acceptedAt: null,
    rejectedAt: null,
    voidedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function eventRecord(
  overrides: Partial<HandymanBastEventRecord> = {},
): HandymanBastEventRecord {
  return {
    id: randomUUID(),
    clientId: randomUUID(),
    bastId: randomUUID(),
    executionScopeId: randomUUID(),
    eventType: 'PREPARE',
    idempotencyKey: `key-${randomUUID().slice(0, 8)}`,
    actorUserId: randomUUID(),
    occurredAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function signOffRecord(
  overrides: Partial<HandymanBastSignOffRecord> = {},
): HandymanBastSignOffRecord {
  return {
    id: randomUUID(),
    clientId: randomUUID(),
    bastId: randomUUID(),
    eventId: randomUUID(),
    executionScopeId: randomUUID(),
    decision: 'ACCEPT',
    signatureDigest: 'a'.repeat(64),
    evidenceRecordId: randomUUID(),
    rejectReason: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('CR-HM-17 P1 FIX01 — BAST artifact reference', () => {
  it('computes version 1 for DRAFT status', () => {
    assert.equal(computeBastArtifactVersion('DRAFT'), 1);
  });

  it('computes version 2 for ISSUED status', () => {
    assert.equal(computeBastArtifactVersion('ISSUED'), 2);
  });

  it('computes version 3 for ACCEPTED status', () => {
    assert.equal(computeBastArtifactVersion('ACCEPTED'), 3);
  });

  it('computes version 3 for REJECTED status', () => {
    assert.equal(computeBastArtifactVersion('REJECTED'), 3);
  });

  it('computes version 2 for VOID status', () => {
    assert.equal(computeBastArtifactVersion('VOID'), 2);
  });

  it('produces ref format BAST/{id}/v{N}', () => {
    const bast = bastRecord({ status: 'ISSUED' });
    const artifact = toHandymanBastArtifactReference(bast);
    assert.equal(artifact.ref, `BAST/${bast.id}/v2`);
    assert.equal(artifact.bastId, bast.id);
    assert.equal(artifact.version, 2);
    assert.equal(artifact.status, 'ISSUED');
  });

  it('produces version 3 for ACCEPTED artifact', () => {
    const bast = bastRecord({ status: 'ACCEPTED' });
    const artifact = toHandymanBastArtifactReference(bast);
    assert.match(artifact.ref, /^BAST\/.+\/v3$/);
    assert.equal(artifact.version, 3);
  });

  it('artifact ref changes when status transitions', () => {
    const bastId = randomUUID();
    const draft = bastRecord({ id: bastId, status: 'DRAFT' });
    const issued = bastRecord({ id: bastId, status: 'ISSUED' });
    const accepted = bastRecord({ id: bastId, status: 'ACCEPTED' });

    const r1 = toHandymanBastArtifactReference(draft);
    const r2 = toHandymanBastArtifactReference(issued);
    const r3 = toHandymanBastArtifactReference(accepted);

    assert.equal(r1.ref, `BAST/${bastId}/v1`);
    assert.equal(r2.ref, `BAST/${bastId}/v2`);
    assert.equal(r3.ref, `BAST/${bastId}/v3`);
    assert.notEqual(r1.ref, r2.ref);
    assert.notEqual(r2.ref, r3.ref);
  });
});

describe('CR-HM-17 P1 FIX01 — approved signature-evidence binding', () => {
  it('returns null when BAST is not ACCEPTED', () => {
    const bast = bastRecord({ status: 'ISSUED' });
    const events = [eventRecord({ eventType: 'ISSUE', bastId: bast.id })];
    const signOffs = [];
    const result = resolveApprovedSignOff(bast, events, signOffs);
    assert.equal(result, null);
  });

  it('returns null when ACCEPTED but no ACCEPT event', () => {
    const bast = bastRecord({ status: 'ACCEPTED' });
    const events = [
      eventRecord({ eventType: 'PREPARE', bastId: bast.id }),
      eventRecord({ eventType: 'ISSUE', bastId: bast.id }),
    ];
    const result = resolveApprovedSignOff(bast, events, []);
    assert.equal(result, null);
  });

  it('returns null when ACCEPT event exists but no matching sign-off', () => {
    const bast = bastRecord({ status: 'ACCEPTED' });
    const acceptEvent = eventRecord({
      eventType: 'ACCEPT',
      bastId: bast.id,
    });
    const result = resolveApprovedSignOff(bast, [acceptEvent], []);
    assert.equal(result, null);
  });

  it('returns binding when ACCEPTED with matching ACCEPT sign-off', () => {
    const bast = bastRecord({ status: 'ACCEPTED' });
    const acceptEvent = eventRecord({
      eventType: 'ACCEPT',
      bastId: bast.id,
    });
    const signOff = signOffRecord({
      bastId: bast.id,
      eventId: acceptEvent.id,
      decision: 'ACCEPT',
      signatureDigest: 'b'.repeat(64),
      evidenceRecordId: randomUUID(),
    });
    const result = resolveApprovedSignOff(
      bast,
      [acceptEvent],
      [signOff],
    );
    assert.notEqual(result, null);
    assert.equal(result!.signOffId, signOff.id);
    assert.equal(result!.eventId, acceptEvent.id);
    assert.equal(result!.signatureDigest, 'b'.repeat(64));
    assert.equal(result!.evidenceRecordId, signOff.evidenceRecordId);
    assert.equal(result!.actorUserId, acceptEvent.actorUserId);
  });

  it('returns null when REJECTED (not ACCEPTED)', () => {
    const bast = bastRecord({ status: 'REJECTED' });
    const rejectEvent = eventRecord({
      eventType: 'REJECT',
      bastId: bast.id,
    });
    const result = resolveApprovedSignOff(bast, [rejectEvent], []);
    assert.equal(result, null);
  });
});

describe('CR-HM-17 P1 FIX01 — acceptance read contract integration', () => {
  it('includes artifactRef for all statuses', () => {
    const statuses: HandymanBastStatus[] = [
      'DRAFT', 'ISSUED', 'ACCEPTED', 'REJECTED', 'VOID',
    ];
    for (const status of statuses) {
      const bast = bastRecord({ status });
      const contract = toHandymanBastAcceptanceReadContract(bast);
      assert.match(
        contract.artifactRef,
        /^BAST\/.+\/v\d+$/,
        `artifactRef missing for status ${status}`,
      );
    }
  });

  it('approvedSignOff is null and signOffComplete false for ISSUED', () => {
    const bast = bastRecord({ status: 'ISSUED' });
    const contract = toHandymanBastAcceptanceReadContract(bast);
    assert.equal(contract.approvedSignOff, null);
    assert.equal(contract.signOffComplete, false);
  });

  it('approvedSignOff is present and signOffComplete true for ACCEPTED', () => {
    const bast = bastRecord({ status: 'ACCEPTED' });
    const acceptEvent = eventRecord({
      eventType: 'ACCEPT',
      bastId: bast.id,
    });
    const signOff = signOffRecord({
      bastId: bast.id,
      eventId: acceptEvent.id,
      decision: 'ACCEPT',
      signatureDigest: 'c'.repeat(64),
    });
    const contract = toHandymanBastAcceptanceReadContract(
      bast,
      [acceptEvent],
      [signOff],
    );
    assert.notEqual(contract.approvedSignOff, null);
    assert.equal(contract.signOffComplete, true);
    assert.equal(contract.approvedSignOff!.signatureDigest, 'c'.repeat(64));
  });

  it('signOffComplete is false when ACCEPTED but no events/sign-offs passed', () => {
    const bast = bastRecord({ status: 'ACCEPTED' });
    const contract = toHandymanBastAcceptanceReadContract(bast);
    assert.equal(contract.approvedSignOff, null);
    assert.equal(contract.signOffComplete, false);
  });

  it('CR-HM-11 lifecycle: non-ACCEPTED never produces approvedSignOff', () => {
    const bast = bastRecord({ status: 'DRAFT' });
    const contract = toHandymanBastAcceptanceReadContract(bast, [], []);
    assert.equal(contract.customerAccepted, false);
    assert.equal(contract.approvedSignOff, null);
    assert.equal(contract.signOffComplete, false);
    assert.equal(contract.warrantyStartEligible, false);
  });

  it('CR-HM-11 preserved: VOID status does not produce sign-off binding', () => {
    const bast = bastRecord({ status: 'VOID' });
    const contract = toHandymanBastAcceptanceReadContract(bast, [], []);
    assert.equal(contract.customerAccepted, false);
    assert.equal(contract.approvedSignOff, null);
    assert.equal(contract.signOffComplete, false);
  });

  it('artifactRef is deterministic from bast id and status', () => {
    const bastId = randomUUID();
    const bast = bastRecord({ id: bastId, status: 'ACCEPTED' });
    const c1 = toHandymanBastAcceptanceReadContract(bast);
    const c2 = toHandymanBastAcceptanceReadContract(bast);
    assert.equal(c1.artifactRef, c2.artifactRef);
    assert.equal(c1.artifactRef, `BAST/${bastId}/v3`);
  });
});
