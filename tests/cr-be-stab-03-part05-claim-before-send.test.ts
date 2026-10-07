import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it, mock } from 'node:test';
import { notificationReminderRepository } from '../src/modules/notification-reminders/notification-reminder.repository';
import { dispatchReminder } from '../src/modules/notification-reminders/notification-reminder.service';
import type { NotificationReminderRecord } from '../src/modules/notification-reminders/notification-reminder.types';
import { notificationEscalationRepository } from '../src/modules/notification-escalations/notification-escalation.repository';
import { triggerEscalation } from '../src/modules/notification-escalations/notification-escalation.service';
import type { NotificationEscalationRecord } from '../src/modules/notification-escalations/notification-escalation.types';
import { notificationTemplateRepository } from '../src/modules/notification-templates/notification-template.repository';
import type { NotificationTemplateRecord } from '../src/modules/notification-templates/notification-template.types';
import { notificationRepository } from '../src/modules/notifications/notification.repository';
import {
  clampDueItemLimit,
  DUE_ITEM_RETRIEVAL_LIMIT,
} from '../src/shared/due-retrieval';

/**
 * CR-BE-STAB-03 PART 05 — claim-before-send (focused NON-DB tests).
 *
 * Proves, without PostgreSQL:
 *   - `dispatchReminder` / `triggerEscalation` claim the guarded
 *     PENDING→SENT / PENDING→TRIGGERED transition (`markSent` /
 *     `markTriggered`) BEFORE any send work, using the existing repository
 *     claim functions,
 *   - a LOST claim (null) sends nothing: no recipient resolution is reached
 *     and `recordNotification` is never invoked,
 *   - a WON claim returns the claimed row and only then sends,
 *   - pre-existing behavior is preserved: non-PENDING is an idempotent
 *     no-op, an inactive template leaves the item PENDING (unclaimed), and
 *     an unknown id still throws not-found,
 *   - due-item retrieval is bounded by a small clamped LIMIT.
 *
 * Non-DB technique: the repository singletons are plain objects, so their
 * methods are swapped with in-memory fakes (restored after each test). The
 * send phase is observed WITHOUT a database via two facts:
 *   - an empty recipient rule `{ specs: [] }` resolves to zero recipients
 *     with no pool access (happy path), and
 *   - a USER-spec rule reaches `getPool()`, which throws
 *     "Database pool has not been initialized" — proof that dispatch moved
 *     past the claim into the send phase.
 */

const FIXED = new Date('2026-01-01T00:00:00.000Z');
const CLAIMED_AT = new Date('2026-02-02T08:00:00.000Z');

function buildTemplateRecord(
  overrides: Partial<NotificationTemplateRecord> = {},
): NotificationTemplateRecord {
  return {
    id: randomUUID(),
    key: 'tpl.part05.claim',
    type: 'REMINDER',
    channel: 'IN_APP',
    subject: 'Follow up: {{title}}',
    body: 'Please follow up on {{title}}.',
    variables: ['title'],
    status: 'ACTIVE',
    createdAt: FIXED,
    updatedAt: FIXED,
    ...overrides,
  };
}

function buildReminderRecord(
  overrides: Partial<NotificationReminderRecord> = {},
): NotificationReminderRecord {
  return {
    id: randomUUID(),
    key: 'reminder.part05.claim',
    clientId: randomUUID(),
    sourceEntityType: 'WORK_ORDER',
    sourceEntityId: randomUUID(),
    recipientRule: { specs: [] },
    templateKey: 'tpl.part05.claim',
    variables: { title: 'pump inspection' },
    reminderAt: FIXED,
    status: 'PENDING',
    sentAt: null,
    createdAt: FIXED,
    updatedAt: FIXED,
    ...overrides,
  };
}

function claimedReminder(
  pending: NotificationReminderRecord,
): NotificationReminderRecord {
  return { ...pending, status: 'SENT', sentAt: CLAIMED_AT };
}

function buildEscalationRecord(
  overrides: Partial<NotificationEscalationRecord> = {},
): NotificationEscalationRecord {
  return {
    id: randomUUID(),
    key: 'escalation.part05.claim',
    clientId: randomUUID(),
    sourceEntityType: 'WORK_ORDER',
    sourceEntityId: randomUUID(),
    currentRecipientUserId: null,
    escalationRule: { specs: [] },
    templateKey: 'tpl.part05.claim',
    escalationAt: FIXED,
    triggeredAt: null,
    status: 'PENDING',
    reason: null,
    createdAt: FIXED,
    updatedAt: FIXED,
    ...overrides,
  };
}

function claimedEscalation(
  pending: NotificationEscalationRecord,
): NotificationEscalationRecord {
  return { ...pending, status: 'TRIGGERED', triggeredAt: CLAIMED_AT };
}

/** USER spec — resolution reaches `getPool()` and throws without a database. */
const userSpecRule = {
  specs: [{ kind: 'USER' as const, userId: randomUUID() }],
};

/** Guards that `recordNotification` (notificationRepository.create) is never reached. */
function forbidNotificationCreate() {
  return mock.method(notificationRepository, 'create', async () => {
    throw new Error('recordNotification must not be called for this scenario');
  });
}

afterEach(() => {
  mock.restoreAll();
});

describe('CR-BE-STAB-03 PART 05 — claim-before-send: dispatchReminder', () => {
  it('does not resolve recipients or record notifications when the claim is lost', async () => {
    const pending = buildReminderRecord({ recipientRule: userSpecRule });
    mock.method(notificationReminderRepository, 'findById', async () => pending);
    mock.method(notificationTemplateRepository, 'findByKey', async () =>
      buildTemplateRecord(),
    );
    const claim = mock.method(
      notificationReminderRepository,
      'markSent',
      async () => null,
    );
    const create = forbidNotificationCreate();

    // With the old send-before-claim order, recipient resolution (USER spec)
    // would throw here because no database pool exists. A clean null proves
    // the lost claim short-circuits BEFORE any send work.
    const result = await dispatchReminder(pending.id);

    assert.equal(result, null);
    assert.equal(claim.mock.callCount(), 1);
    assert.equal(create.mock.callCount(), 0);
  });

  it('claims (markSent) before resolving recipients and recording notifications', async () => {
    const pending = buildReminderRecord({ recipientRule: userSpecRule });
    mock.method(notificationReminderRepository, 'findById', async () => pending);
    mock.method(notificationTemplateRepository, 'findByKey', async () =>
      buildTemplateRecord(),
    );
    const claim = mock.method(
      notificationReminderRepository,
      'markSent',
      async () => claimedReminder(pending),
    );
    const create = forbidNotificationCreate();

    // Reaching recipient resolution (which throws only because no pool is
    // initialized) proves dispatch moved past the claim into the send phase;
    // the claim having already run proves claim-before-send ordering.
    await assert.rejects(
      dispatchReminder(pending.id),
      /Database pool has not been initialized/,
    );
    assert.equal(claim.mock.callCount(), 1);
    assert.equal(create.mock.callCount(), 0);
  });

  it('returns the claimed SENT row and records nothing for an empty recipient rule', async () => {
    const pending = buildReminderRecord();
    mock.method(notificationReminderRepository, 'findById', async () => pending);
    mock.method(notificationTemplateRepository, 'findByKey', async () =>
      buildTemplateRecord(),
    );
    const claim = mock.method(
      notificationReminderRepository,
      'markSent',
      async () => claimedReminder(pending),
    );
    const create = forbidNotificationCreate();

    const result = await dispatchReminder(pending.id);

    assert.ok(result);
    assert.equal(result.reminder.id, pending.id);
    assert.equal(result.reminder.status, 'SENT');
    assert.equal(result.reminder.sentAt, CLAIMED_AT.toISOString());
    assert.deepEqual(result.notifications, []);
    assert.equal(claim.mock.callCount(), 1);
    assert.equal(create.mock.callCount(), 0);
  });

  it('leaves the reminder PENDING (unclaimed, unsent) when the template is not ACTIVE', async () => {
    const pending = buildReminderRecord();
    mock.method(notificationReminderRepository, 'findById', async () => pending);
    mock.method(notificationTemplateRepository, 'findByKey', async () =>
      buildTemplateRecord({ status: 'INACTIVE' }),
    );
    const claim = mock.method(notificationReminderRepository, 'markSent', async () => {
      throw new Error('an inactive template must not be claimed');
    });
    const create = forbidNotificationCreate();

    const result = await dispatchReminder(pending.id);

    assert.equal(result, null);
    assert.equal(claim.mock.callCount(), 0);
    assert.equal(create.mock.callCount(), 0);
  });

  it('does not claim or send a non-PENDING reminder (idempotent no-op)', async () => {
    const alreadySent = claimedReminder(buildReminderRecord());
    mock.method(notificationReminderRepository, 'findById', async () => alreadySent);
    const claim = mock.method(notificationReminderRepository, 'markSent', async () => {
      throw new Error('a non-PENDING reminder must not be claimed');
    });
    const create = forbidNotificationCreate();

    const result = await dispatchReminder(alreadySent.id);

    assert.equal(result, null);
    assert.equal(claim.mock.callCount(), 0);
    assert.equal(create.mock.callCount(), 0);
  });

  it('still throws not-found for an unknown reminder', async () => {
    mock.method(notificationReminderRepository, 'findById', async () => null);

    await assert.rejects(dispatchReminder(randomUUID()), {
      message: 'Notification reminder not found.',
    });
  });
});

describe('CR-BE-STAB-03 PART 05 — claim-before-send: triggerEscalation', () => {
  it('does not resolve recipients or record notifications when the claim is lost', async () => {
    const pending = buildEscalationRecord({ escalationRule: userSpecRule });
    mock.method(notificationEscalationRepository, 'findById', async () => pending);
    mock.method(notificationTemplateRepository, 'findByKey', async () =>
      buildTemplateRecord({ subject: 'Escalation', body: null, variables: [] }),
    );
    const claim = mock.method(
      notificationEscalationRepository,
      'markTriggered',
      async () => null,
    );
    const create = forbidNotificationCreate();

    const result = await triggerEscalation(pending.id);

    assert.equal(result, null);
    assert.equal(claim.mock.callCount(), 1);
    assert.equal(create.mock.callCount(), 0);
  });

  it('claims (markTriggered) before resolving recipients and recording notifications', async () => {
    const pending = buildEscalationRecord({ escalationRule: userSpecRule });
    mock.method(notificationEscalationRepository, 'findById', async () => pending);
    mock.method(notificationTemplateRepository, 'findByKey', async () =>
      buildTemplateRecord({ subject: 'Escalation', body: null, variables: [] }),
    );
    const claim = mock.method(
      notificationEscalationRepository,
      'markTriggered',
      async () => claimedEscalation(pending),
    );
    const create = forbidNotificationCreate();

    await assert.rejects(
      triggerEscalation(pending.id),
      /Database pool has not been initialized/,
    );
    assert.equal(claim.mock.callCount(), 1);
    assert.equal(create.mock.callCount(), 0);
  });

  it('returns the claimed TRIGGERED row and records nothing for an empty recipient rule', async () => {
    const pending = buildEscalationRecord();
    mock.method(notificationEscalationRepository, 'findById', async () => pending);
    mock.method(notificationTemplateRepository, 'findByKey', async () =>
      buildTemplateRecord({ subject: 'Escalation', body: null, variables: [] }),
    );
    const claim = mock.method(
      notificationEscalationRepository,
      'markTriggered',
      async () => claimedEscalation(pending),
    );
    const create = forbidNotificationCreate();

    const result = await triggerEscalation(pending.id);

    assert.ok(result);
    assert.equal(result.escalation.id, pending.id);
    assert.equal(result.escalation.status, 'TRIGGERED');
    assert.equal(result.escalation.triggeredAt, CLAIMED_AT.toISOString());
    assert.deepEqual(result.notifications, []);
    assert.equal(claim.mock.callCount(), 1);
    assert.equal(create.mock.callCount(), 0);
  });

  it('leaves the escalation PENDING (unclaimed, unsent) when the template is not ACTIVE', async () => {
    const pending = buildEscalationRecord();
    mock.method(notificationEscalationRepository, 'findById', async () => pending);
    mock.method(notificationTemplateRepository, 'findByKey', async () =>
      buildTemplateRecord({ status: 'INACTIVE', subject: 'Escalation', body: null, variables: [] }),
    );
    const claim = mock.method(
      notificationEscalationRepository,
      'markTriggered',
      async () => {
        throw new Error('an inactive template must not be claimed');
      },
    );
    const create = forbidNotificationCreate();

    const result = await triggerEscalation(pending.id);

    assert.equal(result, null);
    assert.equal(claim.mock.callCount(), 0);
    assert.equal(create.mock.callCount(), 0);
  });

  it('does not claim or send a non-PENDING escalation (idempotent no-op)', async () => {
    const alreadyTriggered = claimedEscalation(buildEscalationRecord());
    mock.method(notificationEscalationRepository, 'findById', async () => alreadyTriggered);
    const claim = mock.method(
      notificationEscalationRepository,
      'markTriggered',
      async () => {
        throw new Error('a non-PENDING escalation must not be claimed');
      },
    );
    const create = forbidNotificationCreate();

    const result = await triggerEscalation(alreadyTriggered.id);

    assert.equal(result, null);
    assert.equal(claim.mock.callCount(), 0);
    assert.equal(create.mock.callCount(), 0);
  });

  it('still throws not-found for an unknown escalation', async () => {
    mock.method(notificationEscalationRepository, 'findById', async () => null);

    await assert.rejects(triggerEscalation(randomUUID()), {
      message: 'Notification escalation not found.',
    });
  });
});

describe('CR-BE-STAB-03 PART 05 — bounded due-item retrieval limit', () => {
  it('the shared bound is a small positive integer batch', () => {
    assert.ok(Number.isInteger(DUE_ITEM_RETRIEVAL_LIMIT));
    assert.ok(DUE_ITEM_RETRIEVAL_LIMIT > 0);
    assert.ok(DUE_ITEM_RETRIEVAL_LIMIT <= 500);
  });

  it('keeps explicit in-range batch requests', () => {
    assert.equal(clampDueItemLimit(1), 1);
    assert.equal(clampDueItemLimit(25), 25);
    assert.equal(clampDueItemLimit(DUE_ITEM_RETRIEVAL_LIMIT), DUE_ITEM_RETRIEVAL_LIMIT);
    assert.equal(clampDueItemLimit(7.9), 7);
  });

  it('clamps out-of-range, fractional, and non-finite requests into the bound', () => {
    assert.equal(clampDueItemLimit(), DUE_ITEM_RETRIEVAL_LIMIT);
    assert.equal(clampDueItemLimit(0), 1);
    assert.equal(clampDueItemLimit(-10), 1);
    assert.equal(clampDueItemLimit(Number.MAX_SAFE_INTEGER), DUE_ITEM_RETRIEVAL_LIMIT);
    assert.equal(clampDueItemLimit(Number.NaN), DUE_ITEM_RETRIEVAL_LIMIT);
    assert.equal(clampDueItemLimit(Number.POSITIVE_INFINITY), DUE_ITEM_RETRIEVAL_LIMIT);
    assert.equal(clampDueItemLimit(Number.NEGATIVE_INFINITY), DUE_ITEM_RETRIEVAL_LIMIT);
  });
});
