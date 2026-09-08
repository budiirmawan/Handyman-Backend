import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DELIVERY_PROVIDER_OUTCOMES,
  classifyProviderResult,
  isDeliveryProviderOutcome,
  isRetryableProviderOutcome,
  type DeliveryProviderOutcome,
} from '../src/shared/provider-result';

/**
 * CR-BE-NOTIFY-PROV-01 PART 01 — provider result taxonomy (focused tests).
 *
 * Pure unit tests of the shared classification that normalizes channel
 * adapter results (EmailSendResult / WhatsAppSendResult) into delivery
 * lifecycle outcomes. No database, no adapter contact, no credentials.
 */

describe('CR-BE-NOTIFY-PROV-01 PART 01 — provider result taxonomy', () => {
  it('defines exactly the governance §3.3 outcome vocabulary', () => {
    assert.deepEqual(DELIVERY_PROVIDER_OUTCOMES, [
      'ACCEPTED',
      'REJECTED_RETRYABLE',
      'REJECTED_PERMANENT',
      'ERROR_UNKNOWN',
    ]);
  });

  it('classifies SENT as ACCEPTED regardless of the retryable hint', () => {
    assert.equal(classifyProviderResult({ status: 'SENT' }), 'ACCEPTED');
    assert.equal(classifyProviderResult({ status: 'SENT', retryable: true }), 'ACCEPTED');
    assert.equal(classifyProviderResult({ status: 'SENT', retryable: false }), 'ACCEPTED');
  });

  it('classifies FAILED with retryable=true as REJECTED_RETRYABLE', () => {
    assert.equal(
      classifyProviderResult({ status: 'FAILED', retryable: true }),
      'REJECTED_RETRYABLE',
    );
  });

  it('classifies FAILED without an explicit retryable hint as REJECTED_PERMANENT (conservative default)', () => {
    assert.equal(classifyProviderResult({ status: 'FAILED' }), 'REJECTED_PERMANENT');
    assert.equal(
      classifyProviderResult({ status: 'FAILED', retryable: false }),
      'REJECTED_PERMANENT',
    );
  });

  it('never produces ERROR_UNKNOWN from a classifiable result (it is the orchestration-layer classification)', () => {
    for (const status of ['SENT', 'FAILED'] as const) {
      for (const retryable of [undefined, true, false]) {
        assert.notEqual(classifyProviderResult({ status, retryable }), 'ERROR_UNKNOWN');
      }
    }
  });

  it('marks REJECTED_RETRYABLE and ERROR_UNKNOWN as retryable, everything else terminal', () => {
    assert.equal(isRetryableProviderOutcome('REJECTED_RETRYABLE'), true);
    assert.equal(isRetryableProviderOutcome('ERROR_UNKNOWN'), true);
    assert.equal(isRetryableProviderOutcome('ACCEPTED'), false);
    assert.equal(isRetryableProviderOutcome('REJECTED_PERMANENT'), false);
  });

  it('guards the outcome vocabulary (isDeliveryProviderOutcome)', () => {
    for (const outcome of DELIVERY_PROVIDER_OUTCOMES) {
      assert.equal(isDeliveryProviderOutcome(outcome), true);
    }
    assert.equal(isDeliveryProviderOutcome('DELIVERED'), false);
    assert.equal(isDeliveryProviderOutcome('accepted'), false);
    assert.equal(isDeliveryProviderOutcome(null), false);
    assert.equal(isDeliveryProviderOutcome(42), false);
  });

  it('every classification output is a member of the vocabulary', () => {
    const outputs: DeliveryProviderOutcome[] = [
      classifyProviderResult({ status: 'SENT' }),
      classifyProviderResult({ status: 'FAILED' }),
      classifyProviderResult({ status: 'FAILED', retryable: true }),
    ];
    for (const outcome of outputs) {
      assert.equal(isDeliveryProviderOutcome(outcome), true);
    }
  });
});
