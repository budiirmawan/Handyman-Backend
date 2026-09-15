#!/usr/bin/env python3
"""CR-BE-MOB-01 PART 07 — push delivery boundary (BE-26 channel).

Documentation-only. BE-26 implements IN_APP, EMAIL and WHATSAPP delivery; it
does NOT implement push delivery — there is no push delivery attempt record,
no adapter, no provider integration and no token fan-out anywhere in the
backend. This PART therefore publishes nothing new and invents nothing. It
annotates the two EXISTING, already-published operations that bracket the
gap so the four stages can never be conflated:

  1. token registration     — EXISTING  (BE-25L)
  2. notification creation  — EXISTING  (BE-26A/D/E, IN_APP records)
  3. delivery attempt       — EXISTING for IN_APP / EMAIL / WHATSAPP,
                              MISSING for PUSH
  4. provider delivery      — MISSING for PUSH

It also corrects a stale sentence on `registerPushToken` ("No notification
delivery exists yet (BE-26)") which predates BE-26 in-app delivery. Idempotent.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs/api/openapi.yaml"

TOKEN_ANCHOR = """      operationId: registerPushToken
      summary: Register (or rotate) a mobile push token
      description: >
        BE-25L push token registration. Registers the authenticated user's
        device push token. Re-registering the same `deviceId` ROTATES the
        token on the existing ACTIVE registration; a token re-registered
        from another device of the same user replaces the old device's
        registration. Returns the ACTIVE registration with registered_at /
        last_seen_at / status. No notification delivery exists yet (BE-26).
      tags: [Mobile Execution]
      security:
        - bearerAuth: []
"""

TOKEN_REPLACEMENT = """      operationId: registerPushToken
      summary: Register (or rotate) a mobile push token
      description: >
        BE-25L push token registration. Registers the authenticated user's
        device push token. Re-registering the same `deviceId` ROTATES the
        token on the existing ACTIVE registration; a token re-registered
        from another device of the same user replaces the old device's
        registration. Returns the ACTIVE registration with registered_at /
        last_seen_at / status.

        CR-BE-MOB-01 PART 07 — registration is NOT delivery. Storing a token
        creates no notification, no delivery attempt and no provider send: the
        backend has no push adapter, no push provider integration and no
        token fan-out, so a successful registration must never be presented to
        the user as "push enabled". BE-26 today delivers IN_APP (the
        authoritative mobile path, `listNotifications` /
        `markNotificationRead`), EMAIL and WHATSAPP; PUSH is MISSING at both
        the delivery-attempt and provider stages — see
        `x-push-delivery-lifecycle`. The registration is self-scoped: it is
        bound to the authenticated `userId` and requires no permission code,
        and a user can only ever see or deactivate their own device
        registrations.
      tags: [Mobile Execution]
      security:
        - bearerAuth: []
      x-recipient-scoped: true
      x-push-delivery-lifecycle:
        - stage: 1
          name: TOKEN_REGISTRATION
          status: EXISTING
          authority: BE-25L mobile_push_tokens
          operationIds: [registerPushToken, listPushTokens, deactivatePushToken]
          notes: >-
            Authoritative per user + device, with rotation and deactivation.
            Tokens are stored only; nothing reads them to send anything.
        - stage: 2
          name: NOTIFICATION_CREATION
          status: EXISTING
          authority: BE-26A record + BE-26D subscription + BE-26B template + BE-26C recipient resolution
          operationIds: [listNotifications, getNotification, markNotificationRead]
          notes: >-
            A domain event resolves matching subscriptions, renders the
            template and creates notification records for authoritative
            recipient user ids. The notification record channel enum is
            IN_APP only — creating a notification is not a push.
        - stage: 3
          name: DELIVERY_ATTEMPT
          status: PARTIAL
          authority: BE-26E in-app, BE-26F email, BE-26G WhatsApp, BE-26K history
          operationIds: [listNotificationHistory, getNotificationHistoryItem]
          implementedChannels: [IN_APP, EMAIL, WHATSAPP]
          missingChannels: [PUSH]
          notes: >-
            Every implemented channel persists an attempt row with status,
            sent/failed timestamps, provider and failure reason, surfaced by
            the BE-26K history read model. There is NO push delivery attempt
            record type, so a push send can be neither recorded nor observed.
        - stage: 4
          name: PROVIDER_DELIVERY
          status: MISSING
          authority: none for push (email and WhatsApp have adapters)
          operationIds: []
          notes: >-
            No push adapter, no provider integration, no vendor SDK and no
            fan-out over the registered tokens exists in the backend. Adding
            one requires a push delivery attempt table + migration and a
            provider adapter, which this PART forbids. Mobile must rely on the
            IN_APP inbox; a client must never simulate a push locally and
            report it as delivered, and the backend must never fabricate a
            delivery success.
      x-push-delivery-failure-behavior: >-
        For the implemented channels a failed attempt is persisted as a FAILED
        row carrying `failedAt`, `provider` and `failureReason`, and is
        readable through the history model — failures are recorded, never
        silently dropped, and never retried into a fake success. For PUSH
        there is no attempt record at all: a missing push is invisible to the
        backend, which is precisely why the capability is MISSING rather than
        degraded.
"""

HISTORY_ANCHOR = """      operationId: listNotificationHistory
      summary: List the authenticated user's notification history
      description: >
        BE-26K notification history read model: a unified, chronological view
        of the recipient's own delivery records across IN_APP / EMAIL /
        WHATSAPP channels, newest first. Optional `channel` and `status`
        filters; pagination is opt-in via `page`/`pageSize`. Read-only —
        no second audit engine, no credential/token exposure.
      tags: [Notification History]
      security:
        - bearerAuth: []
"""

HISTORY_REPLACEMENT = """      operationId: listNotificationHistory
      summary: List the authenticated user's notification history
      description: >
        BE-26K notification history read model: a unified, chronological view
        of the recipient's own delivery records across IN_APP / EMAIL /
        WHATSAPP channels, newest first. Optional `channel` and `status`
        filters; pagination is opt-in via `page`/`pageSize`. Read-only —
        no second audit engine, no credential/token exposure.

        CR-BE-MOB-01 PART 07 — the channel enum is exhaustive: it lists every
        channel that can produce a delivery attempt record. PUSH is absent
        because no push delivery attempt exists in the backend, so the absence
        of a PUSH row is not a delivery failure — it means the capability is
        not implemented. Rows are recipient-scoped to the authenticated user.
      tags: [Notification History]
      security:
        - bearerAuth: []
      x-recipient-scoped: true
      x-delivery-channels-implemented: [IN_APP, EMAIL, WHATSAPP]
      x-delivery-channels-missing: [PUSH]
"""


def main() -> None:
    text = SPEC.read_text()
    if "x-push-delivery-lifecycle" in text:
        print("already annotated")
        return

    if TOKEN_ANCHOR not in text:
        raise SystemExit("registerPushToken anchor not found")
    text = text.replace(TOKEN_ANCHOR, TOKEN_REPLACEMENT, 1)

    if HISTORY_ANCHOR not in text:
        raise SystemExit("listNotificationHistory anchor not found")
    text = text.replace(HISTORY_ANCHOR, HISTORY_REPLACEMENT, 1)

    SPEC.write_text(text)
    print("annotated push delivery boundary")


if __name__ == "__main__":
    main()
