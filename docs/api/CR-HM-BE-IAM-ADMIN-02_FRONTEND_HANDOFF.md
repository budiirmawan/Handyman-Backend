# CR-HM-BE-IAM-ADMIN-02 — Frontend IAM Admin API Handoff

**Consumer:** `budiirmawan/Handyman-Operations` PR #16  
**Authority:** Handyman Backend IAM / RBAC / PostgreSQL. The OpenAPI source of truth is [`openapi.yaml`](./openapi.yaml).  
**Base path:** `/api/v1` (prepend the deployed backend origin).  
**Contract note:** The Backend session could not read Handyman-Operations PR #16 (GitHub returned 403 `Resource not accessible by integration`). This handoff therefore documents the exact existing Backend contract and its additive changes; it does not infer or endorse undocumented frontend payloads.

All example bodies below are the `data` member of the standard response envelope:

```json
{ "success": true, "data": {}, "meta": {} }
```

Errors use the standard shape:

```json
{
  "success": false,
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Permission denied.",
    "category": "FORBIDDEN",
    "retryable": false,
    "requestId": "..."
  }
}
```

Authenticated calls use `Authorization: Bearer <sessionToken>`. Do not treat frontend state, a selected Building, or a role label as authorization: the backend resolves session, permission and Building context for every protected request.

## 1. Invitation lifecycle

### `POST /invitations` — create

- **Permission:** `user.manage` (authenticated).
- **Request:**

```json
{ "email": "care@example.com" }
```

- **201 `data`:**

```json
{
  "id": "uuid",
  "email": "care@example.com",
  "status": "PENDING",
  "expiresAt": "2026-10-18T16:00:00.000Z",
  "invitationToken": "opaque-one-time-secret",
  "delivery": {
    "available": false,
    "method": "CONTROLLED_ONE_TIME_HANDOFF",
    "provider": "noop",
    "sent": false,
    "note": "EMAIL_PROVIDER=noop: invitation email delivery is unavailable. Use the returned one-time token for controlled out-of-band handoff; no email was sent."
  }
}
```

`invitationToken` is returned **once**, only from this create response. It is not logged or stored in plaintext; PostgreSQL stores its SHA-256 hash. Do not put it in analytics, logs, browser persistent storage, or audit metadata. The current invitation service does not call the email adapter; `delivery.sent` is always `false`, even if another email provider is configured. The operator must use an approved out-of-band handoff. Do not display a “sent” success state.

- **Errors:** `400 VALIDATION_ERROR`; `401 AUTHENTICATION_REQUIRED`; `403 PERMISSION_DENIED`; `409 USER_EMAIL_ALREADY_EXISTS`, `INVITATION_ALREADY_PENDING`.
- Concurrent create requests for the same normalized email are serialized. Only one unexpired pending invitation can exist at a time.

### `GET /invitations`

- **Permission:** `user.manage`.
- **Query:** optional exact `email`, `status=PENDING|ACCEPTED|REVOKED|EXPIRED`, `page` (default 1), `pageSize` (default 50, max 200).
- **200:** `data` is `PublicInvitation[]`; `meta` is `{ page, pageSize, total, totalPages }`.
- `EXPIRED` is an effective read status derived from a stored `PENDING` invitation whose `expiresAt` has passed. It is not a persisted database status.
- **Errors:** `400 VALIDATION_ERROR`; `401 AUTHENTICATION_REQUIRED`; `403 PERMISSION_DENIED`.

### `GET /invitations/{id}`

- **Permission:** `user.manage`.
- **200 `data`:**

```json
{
  "id": "uuid",
  "email": "care@example.com",
  "status": "PENDING",
  "expiresAt": "2026-10-18T16:00:00.000Z",
  "invitedByUserId": "uuid",
  "acceptedByUserId": null,
  "acceptedAt": null,
  "revokedAt": null,
  "createdAt": "2026-10-18T15:00:00.000Z",
  "updatedAt": "2026-10-18T15:00:00.000Z"
}
```

No token or token hash is returned. A pending row past its expiry is projected as `EXPIRED`. Errors: `400 VALIDATION_ERROR`; `401 AUTHENTICATION_REQUIRED`; `403 PERMISSION_DENIED`; `404 INVITATION_NOT_FOUND`.

### `POST /invitations/validate` — public preflight

- **Permission:** none; possession of a token authorizes only this validation call.
- **Request:** `{ "token": "<invitationToken>" }`.
- **200 `data`:** `{ "tokenValid": true, "invitationId": "uuid", "email": "care@example.com", "status": "PENDING", "expiresAt": "..." }`.
- **Errors:** `400 VALIDATION_ERROR`, `INVITATION_EXPIRED`, or `INVITATION_REVOKED`; `404 INVALID_INVITATION_TOKEN`; `409 INVITATION_ALREADY_ACCEPTED`.

### `POST /invitations/accept` — public one-time acceptance

- **Permission:** none. The invite token is the sole authority; there is no open registration path.
- **Request:**

```json
{
  "token": "<invitationToken>",
  "displayName": "Care Operator",
  "password": "candidate-selected-password"
}
```

- **200 `data`:** `{ "user": { "id": "uuid", "email": "care@example.com", "displayName": "Care Operator", "status": "ACTIVE", "createdAt": "...", "updatedAt": "..." } }` (exact public fields follow `PublicUser`).
- The existing password policy and bcrypt credential service are reused. User creation, credential creation and invitation consumption run atomically under a locked invitation row. Acceptance does **not** return a password, credential hash, invitation token or login session. The candidate must then call `POST /auth/login`.
- **Errors:** `400 VALIDATION_ERROR`, `PASSWORD_POLICY_VIOLATION`, `INVITATION_EXPIRED`, `INVITATION_REVOKED`; `404 INVALID_INVITATION_TOKEN`; `409 INVITATION_ALREADY_ACCEPTED`, `USER_EMAIL_ALREADY_EXISTS`.

### `POST /invitations/{id}/revoke`

- **Permission:** `user.manage`.
- **Request:** no body.
- **200:** token-free `PublicInvitation`; repeated revocation is idempotent. Row locking serializes revoke against acceptance. An accepted invitation cannot be revoked.
- **Errors:** `400 VALIDATION_ERROR`; `401 AUTHENTICATION_REQUIRED`; `403 PERMISSION_DENIED`; `404 INVITATION_NOT_FOUND`; `409 INVITATION_ALREADY_ACCEPTED`.

## 2. User identity and canonical roles

### Read available canonical roles

`GET /roles` requires `role.read` and returns `PublicRole[]` (`id`, `code`, `name`, `description`, `status`). Use the returned `id` in assignment requests; do not hardcode role IDs. The canonical role codes are seeded/maintained by Backend IAM. Permission governance remains in `role_permission_assignments`; role names alone grant nothing.

`GET /users` requires `user.read`; it returns bounded user identity records, never credentials. Query filters include exact normalized `email`, `status`, `page`, and `pageSize` (max 200).

`GET /users/{userId}` requires `user.read` and returns only `PublicUser` identity/status fields.

`POST /users` requires `user.manage` and is **not public registration**. It creates an identity without a credential and must not replace the invitation flow for a login-ready account.

### `POST /users/{userId}/roles` — assign

- **Permission:** `role.manage`.
- **Request:** `{ "roleId": "uuid-from-GET-roles" }`.
- **201 `data`:** `PublicRole`.
- No user may assign a role to themselves (`403 SELF_ROLE_ASSIGNMENT_DENIED`). `PLATFORM_ADMIN` and roles defining IAM/Building administration require an existing `PLATFORM_ADMIN` actor (`403 PRIVILEGED_ROLE_ASSIGNMENT_DENIED`). The canonical `SYSTEM_ADMIN` role does not have `role.manage`; its attempt to call this endpoint is denied by RBAC (`403 PERMISSION_DENIED`).
- **Errors:** `400 VALIDATION_ERROR` or `ROLE_INACTIVE`; `401 AUTHENTICATION_REQUIRED`; `403 PERMISSION_DENIED`, `PRIVILEGED_ROLE_ASSIGNMENT_DENIED`, `SELF_ROLE_ASSIGNMENT_DENIED`; `404 USER_NOT_FOUND`, `ROLE_NOT_FOUND`; `409 ROLE_ALREADY_ASSIGNED`.

### `GET /users/{userId}/roles`

- **Permission:** `role.read`.
- **200:** active `PublicRole[]`.
- **Errors:** `400 VALIDATION_ERROR`; `401 AUTHENTICATION_REQUIRED`; `403 PERMISSION_DENIED`; `404 USER_NOT_FOUND`.

### `DELETE /users/{userId}/roles/{roleId}` — revoke

- **Permission:** `role.manage`.
- **200:** revoked `PublicRole`.
- The last usable active account with `PLATFORM_ADMIN` cannot lose that assignment (`409 LAST_OWNER_ROLE_REQUIRED`). Owner-role mutation is transactionally serialized; an actor other than an existing Owner cannot revoke privileged authority.
- **Errors:** `400 VALIDATION_ERROR`; `401 AUTHENTICATION_REQUIRED`; `403 PERMISSION_DENIED`, `PRIVILEGED_ROLE_ASSIGNMENT_DENIED`; `404 USER_NOT_FOUND`, `ROLE_NOT_FOUND`, `ROLE_ASSIGNMENT_NOT_FOUND`; `409 LAST_OWNER_ROLE_REQUIRED`.

### `POST /roles/{roleId}/permissions` — governed grant (IAM E2E audit PART 02)

- **Permission:** live `permission.manage`; **request:** `{ "permissionId": "uuid-from-GET-permissions" }`; **201 `data`:** the existing `PublicPermission` shape.
- `role.manage`, `permission.manage`, `user.manage`, and `building.manage`, the `PLATFORM_ADMIN` target, and any target role already granting one of those codes require an ACTIVE `PLATFORM_ADMIN` actor (`403 PRIVILEGED_ROLE_ASSIGNMENT_DENIED`), matching the existing revoke policy. Owners retain explicit administration of protected roles.
- Other delegates may grant only an ACTIVE permission in their current effective multi-role union, to an ordinary role they do **not** hold. Beyond-authority grants and held-role self-consolidation return `403 PERMISSION_DENIED`. This is not a blanket Owner-only endpoint.
- The actor comes from the authenticated session, not request-body identity/role/permission/scope claims. Authority checks and insertion run in one serialized transaction; denied grants change no assignment/history row and emit no successful `PERMISSION_GRANTED` event. Successful grants preserve the existing audit context/metadata.
- Existing active/inactive/not-found/validation and authorized-duplicate (`409 PERMISSION_ALREADY_ASSIGNED`) contracts remain. Always honor the Backend's 403, even when a previously rendered control was enabled; permissions can be revoked while a request is pending.
- Roles are **installation-wide metadata**, not Client-owned records. A permission grant does not assign Buildings or expand Client/Building data reach. Do not delegate `permission.manage` expecting tenant-local role administration. Default role sets, including the System Admin's lack of `permission.manage`, are unchanged.
- `DELETE /roles/{roleId}/permissions/{permissionId}` remains unchanged: bounded ordinary revocation, Owner-only privileged revocation, `409 LAST_ADMIN_PERMISSION_REQUIRED`, soft-revoked history, live session permission refresh, and `PERMISSION_REVOKED` audit. A delegate cannot use POST to restore privileged authority; recovery requires a currently authorized Owner.

## 3. Building scope

A role grants **what** a user can do; a Building assignment grants **where**. No user receives all Buildings automatically.

### `POST /users/{userId}/buildings`

- **Permission:** `building.manage`.
- **Request:** `{ "buildingId": "uuid" }`.
- **201 `data`:** `{ "id": "assignment-uuid", "userId": "uuid", "buildingId": "uuid", "status": "ACTIVE", "assignedByUserId": "actor-uuid", "assignedAt": "..." }`.
- A `PLATFORM_ADMIN` owner may administer any assignment but does not gain Building data access merely by doing so. Other administrative actors must themselves have an ACTIVE assignment to the exact target Building. Same-Client or sibling-Building access does not qualify.
- **Errors:** `400 VALIDATION_ERROR`; `401 AUTHENTICATION_REQUIRED`; `403 PERMISSION_DENIED`, `BUILDING_ACCESS_DENIED`; `404 USER_NOT_FOUND`, `BUILDING_NOT_FOUND`; `409 BUILDING_NOT_AVAILABLE`, `USER_BUILDING_ALREADY_ASSIGNED`.

### `GET /users/{userId}/buildings`

- **Permission:** `building.read`.
- **200:** `PublicUserBuildingAssignment[]`. A PLATFORM_ADMIN sees the full assignment history; other actors see only assignments to exact Buildings they can access.
- **Errors:** `400 VALIDATION_ERROR`; `401 AUTHENTICATION_REQUIRED`; `403 PERMISSION_DENIED`; `404 USER_NOT_FOUND`.

### `DELETE /users/{userId}/buildings/{buildingId}`

- **Permission:** `building.manage`.
- **200:** the assignment with `status: "INACTIVE"`; the row is retained, not deleted.
- Non-owner actors must have access to the exact target Building. Removal records `BUILDING_REVOKED`; the removed Building is no longer returned by `GET /auth/me/buildings` or accessible through Building-scoped workspace authorization.
- **Errors:** `400 VALIDATION_ERROR`; `401 AUTHENTICATION_REQUIRED`; `403 PERMISSION_DENIED`, `BUILDING_ACCESS_DENIED`; `404 USER_NOT_FOUND`, `USER_BUILDING_ASSIGNMENT_NOT_FOUND`.

### `GET /auth/me/buildings`

Authentication only. Returns the caller's own ACTIVE Building contexts (`building` plus resolved `property`/`client`). A zero-scope user receives `200` with `[]`. This is a read of explicit assignments, not a mutable "current Building" grant.

## 4. Account lifecycle and credentials

### `POST /users/{userId}/deactivate` and `POST /users/{userId}/suspend`

- **Permission:** `user.manage`; no body.
- **200:** `PublicUser` with `INACTIVE` or `SUSPENDED`.
- Revokes active sessions and prevents authentication. Self-transition is denied. A non-Owner `SYSTEM_ADMIN` cannot transition a `PLATFORM_ADMIN` account. The last usable Owner cannot be removed from service.
- **Errors:** `400 INVALID_ACCOUNT_STATE`; `401 AUTHENTICATION_REQUIRED`; `403 PERMISSION_DENIED`, `SELF_ACCOUNT_ACTION_DENIED`, `PRIVILEGED_ACCOUNT_PROTECTED`; `404 USER_NOT_FOUND`; `409 LAST_OWNER_ACCOUNT_PROTECTED`.

### `POST /users/{userId}/reactivate`

- **Permission:** `user.manage`; no body.
- **200:** `PublicUser` with `ACTIVE` for a prior `INACTIVE` or `SUSPENDED` account. Previously revoked sessions stay revoked; the user must log in again. Reactivation is audited as `ACCOUNT_REACTIVATED`.
- **Errors:** `400 INVALID_ACCOUNT_STATE`; `401 AUTHENTICATION_REQUIRED`; `403 PERMISSION_DENIED`, `PRIVILEGED_ACCOUNT_PROTECTED`; `404 USER_NOT_FOUND`.

### `POST /users/{userId}/password-reset`

- **Permission:** `user.manage`.
- **Request:** `{ "newPassword": "administrator-supplied-temporary-secret" }`.
- **200:** `{ "reset": true, "mustChangePassword": true }`. All target sessions are revoked; the existing bcrypt credential is updated and `must_change_password` is set. Password/hash is never returned or logged. An ordinary System Admin cannot reset an Owner credential (`403 PRIVILEGED_ACCOUNT_RESET_DENIED`).

### `GET /auth/password/status` and `POST /auth/password`

- Both require the caller's authenticated session (no additional RBAC permission).
- Status `200`: `{ "mustChangePassword": true|false }`.
- Change request: `{ "currentPassword": "...", "newPassword": "..." }`; success: `{ "changed": true }`. Reuses password policy/bcrypt, clears the forced-change flag, revokes every other session and retains the current session. While forced change is pending, only `/auth/password`, `/auth/password/status`, `/auth/logout`, and `/auth/me` are reachable.
- Neither endpoint returns password or hash.

### Login

`POST /auth/login` accepts `{ "email": "...", "password": "..." }`. On success it returns `{ "sessionToken": "...", "expiresAt": "...", "user": <PublicUser> }`. Suspended and inactive accounts cannot authenticate. There is no open account registration or password recovery endpoint.

## 5. IAM audit

### `GET /auth/audit-events`

- **Permission:** `auth.audit.read`.
- Optional filters: `eventType`, `userId` (target), `actorUserId`, `outcome`, `from`, `to`, `limit` (default 50, max 100), `offset` (default 0).
- **200:** `data: AuditEvent[]`, `meta: { limit, offset, total }`.
- IAM event types include `INVITATION_CREATED`, `INVITATION_ACCEPTED`, `INVITATION_REVOKED`, `ACCOUNT_DEACTIVATED`, `ACCOUNT_REACTIVATED`, `ACCOUNT_SUSPENDED`, `PASSWORD_RESET`, `PASSWORD_CHANGED`, `ROLE_ASSIGNED`, `ROLE_REVOKED`, `BUILDING_ASSIGNED`, and `BUILDING_REVOKED` (plus login/logout and bootstrap events).
- Each event has `eventType`, `outcome`, target `userId` where available, `actorUserId`, `createdAt`, correlation fields and non-secret metadata. For a not-yet-accepted invitation, `metadata.invitationId` and `metadata.targetEmail` identify the target. The API read boundary redacts metadata keys containing password/hash/token/secret/credential/authorization. It never exposes credential hashes or passwords.
- **Errors:** `400 VALIDATION_ERROR`; `401 AUTHENTICATION_REQUIRED`; `403 PERMISSION_DENIED`.

## 6. Lifecycle example: Customer Care onboarding

1. Owner calls `POST /invitations` and delivers the one-time token over an approved channel. `delivery.available=false` means no email was sent.
2. Candidate calls `POST /invitations/validate`, then `POST /invitations/accept` with their selected password. The account is ACTIVE; no role or Building is inferred from the invitation.
3. Owner calls `GET /roles`, finds `CUSTOMER_CARE`, and posts its returned ID to `POST /users/{userId}/roles`.
4. Owner authorizes an exact Building with `POST /users/{userId}/buildings`. No sibling or portfolio-wide access is implied.
5. Candidate calls `POST /auth/login`, then `GET /auth/me` and `GET /auth/me/buildings`.
6. Building-scoped Care operations succeed only for the explicitly assigned Building; an unauthorized sibling or tenant Building is denied.
7. To remove access, use role revocation or Building-assignment deactivation; to block login, suspend/deactivate the account. Session invalidation, last-Owner guards and audit events are backend-enforced.

## 7. Generated source and boundaries

This handoff summarizes the deployed backend route/service implementation and is kept with the canonical [`OpenAPI`](./openapi.yaml). The frontend must consume these exact names and shapes; Backend acceptance tests and OpenAPI are authoritative. No frontend repository files were modified.
