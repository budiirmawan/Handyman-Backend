# CR-BE-PUSH-01 — Mobile / Frontend Push Handoff

Status: PART 05. Authoritative for client integration with push token
registration and push payload handling. This document describes only what the
backend actually implements today — it invents no endpoint, no field and no
navigation scheme.

## 1. The three endpoints (all authenticated, all self-scoped)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/mobile/push-tokens` | Register / re-register this device |
| `GET` | `/mobile/push-tokens` | List **your own** registrations |
| `DELETE` | `/mobile/push-tokens/{tokenId}` | Deactivate one of **your own** registrations |

There is **no** send, test-push, resend, delivery-history, provider or admin
token-management endpoint, and none is planned in this CR. A push token is
**never** an authentication credential: every call is authorised by the normal
session, and `userId` is always taken from the session — never from the body,
path or query. You cannot read or unregister another user's device.

## 2. When to register

1. **After** a successful authenticated session exists — never before login.
2. On **app reinstall** and on **provider token refresh** (the OS/provider can
   rotate the token at any time; re-POST whenever it changes).
3. On **device identity refresh** — if the stable `deviceId` you generate
   changes, register again.
4. On explicit user lifecycle action where your app supports it (for example
   "sign out of this device"), call `DELETE`.

Re-registering the same `(user, deviceId)` **rotates** the token in place — it
updates the existing row and does not create a duplicate.

### Request fields

| Field | Required | Notes |
|---|---|---|
| `deviceId` | yes | stable client-generated device identifier |
| `pushToken` | yes | provider opaque token, 8–512 chars |
| `platform` | yes | `ANDROID` or `IOS` |
| `appVersion` | no | governed device metadata |
| `deviceModel` | no | governed device metadata |
| `deviceOsVersion` | no | governed device metadata |

## 3. Status — and the one you must act on

`status` is one of `ACTIVE`, `INACTIVE`, `INVALID`.

- `ACTIVE` — usable registration.
- `INACTIVE` — you or the user deliberately unregistered the device.
- `INVALID` — **the push provider rejected this registration** (typically the
  token was unregistered on the device). The backend retires the row and keeps
  it as history; it is returned by `GET`. Treat `INVALID` as **"re-register
  this device"**.

The backend never deletes a registration row, so the listing is a full history
of the user's devices, not just the live ones. Filter client-side if you only
want the active ones.

## 4. Registration is not delivery. Acceptance is not delivery.

- Registering a token **sends nothing**. Never present a successful
  registration to the user as "push enabled" or "notifications working".
- A push is only ever produced by the shared outbound delivery engine from an
  existing notification.
- When a push *is* sent, provider acceptance means the provider **queued** it.
  The backend cannot observe whether the device received, displayed or read
  it. No API reports a push as "delivered", and the client must never
  fabricate such a state.
- The **IN_APP inbox is the authoritative record** of what the user was
  notified about. Push is a best-effort nudge toward it.
- Push attempts are **not** in notification history; the history channels stay
  `IN_APP` / `EMAIL` / `WHATSAPP`.

## 5. The push payload is a pointer, not content

The data payload is deliberately pointer-oriented. The governed keys are:

| Key | Meaning |
|---|---|
| `notificationId` | the notification record, when one exists |
| `eventType` | the source event type |
| `entityType` | the kind of entity the event concerns |
| `entityId` | the entity's id |
| `deliveryId` | the outbound delivery record id |

**The payload is not authoritative content.** On tap, the app must fetch the
real, current state over the authenticated API (for example the notification
inbox, or the entity endpoint for `entityType` + `entityId`) and render that.
This keeps the app correct when the data changed between send and open, and it
keeps sensitive content out of the provider's hands.

Route from `entityType` + `entityId`, which the app already understands. **Do
not** expect or invent a deep-link URL scheme — the backend does not emit one.

## 6. Privacy notes for client authors

- The raw device token is accepted on registration and is echoed back in the
  registration/listing response because that is the frozen BE-25L response
  shape. It is not written to operational events, error payloads or logs —
  diagnostics use a non-reversing fingerprint.
- The public representation deliberately exposes **no** provider-internal
  state: no `provider`, `providerMessageId`, `lastSuccessAt`, `lastFailureAt`,
  `consecutiveFailureCount`, `invalidatedAt` or `invalidationReason`, and no
  `delivered` / `deliveredAt` / `deliveryStatus` / `sentAt` field exists to
  read. Do not build UI that depends on them.
- The mobile contract is **provider-neutral**: no FCM project, provider message
  id, provider error vocabulary, OAuth detail or APNs relay information is
  exposed. Do not branch client behaviour on a provider.
