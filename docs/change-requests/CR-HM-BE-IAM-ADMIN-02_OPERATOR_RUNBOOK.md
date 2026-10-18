# CR-HM-BE-IAM-ADMIN-02 — IAM User Provisioning Operator Runbook

**Scope:** Post-bootstrap user invitations, role/building scope assignment, account lifecycle and IAM audit.  
**Production is not accessed or changed by this runbook's implementation.** Existing sessions, credentials, PostgreSQL, first Owner and migration 0452 remain authoritative.

## Release gate

1. Review and merge the Backend change through its PR; deploy only through the existing release process.
2. Apply the additive migration `0453_extend_iam_admin_audit_events` using the approved migration role and standard deployment procedure before starting application instances that write new IAM role/Building audit events.
3. Verify migration status reports `0453_extend_iam_admin_audit_events` applied. Do **not** run Owner bootstrap again. Do **not** reset an existing account or credential.
4. Do not treat deployment as evidence that invitation email works. The invitation service is not wired to the email adapter: `delivery.available=false` and `delivery.sent=false` for every provider. For `EMAIL_PROVIDER=noop`, the response explicitly says email delivery is unavailable.

The backend process refuses to serve against an unapplied migration history under the existing readiness gate. This release requires no migration beyond 0453 and no production data reset.

## Create and hand off an invitation

1. An authenticated account with `user.manage` calls `POST /api/v1/invitations` with `{ "email": "candidate@example.com" }`.
2. Confirm HTTP `201`, `data.status=PENDING`, `data.delivery.available=false`, and `data.delivery.sent=false`.
3. `data.invitationToken` is a bearer secret disclosed **once**. Copy it only to an approved, access-controlled out-of-band channel. Do not paste it in a ticket, logs, support chat, audit metadata or persistent browser storage. The response is the only retrievable copy; the database stores only the hash.
4. Use `GET /api/v1/invitations?email=...` or `GET /api/v1/invitations/{id}` to monitor lifecycle. These read endpoints never return the token/hash. `EXPIRED` is projected from `expiresAt`.
5. If the handoff was incorrect, call `POST /api/v1/invitations/{id}/revoke`. Do not try to retrieve or re-send a previous token; create a new invitation after revocation.

## Candidate acceptance and provisioning

1. Candidate calls public `POST /api/v1/invitations/validate` with `{ "token": "..." }`.
2. On `{ tokenValid: true }`, candidate calls public `POST /api/v1/invitations/accept` with `{ token, displayName, password }`.
3. The candidate selects the password. Backend applies the existing password policy and bcrypt credential service. Acceptance creates an ACTIVE user and credential and consumes the invitation atomically; it does not create a session, assign a role or grant Building access.
4. Candidate calls `POST /api/v1/auth/login` with their own credentials. Backend session and account-status checks remain authoritative.
5. An administrator uses `GET /api/v1/roles` and `POST /api/v1/users/{userId}/roles` to assign an existing canonical role. User-selected role codes/permissions are not accepted in the assignment body.
6. An authorized administrator explicitly adds an exact Building assignment using `POST /api/v1/users/{userId}/buildings`. A role without Building scope does not open Building data; a Building without the appropriate role permission does not authorize operations.
7. Verify `GET /api/v1/auth/me`, `GET /api/v1/auth/me/buildings`, and the target persona's actual workspace endpoints. Test one allowed Building and one unauthorized sibling/tenant Building.

## Role and Building safeguards

- Canonical role IDs come from `GET /roles`. Do not create a role as a substitute for canonical role assignment.
- SYSTEM_ADMIN is an account/lifecycle administrator, not an authority administrator. It does not have `role.manage` or `permission.manage`; attempts to grant `PLATFORM_ADMIN` are denied. A delegated role that happens to carry `role.manage` is still prevented from assigning privileged authority.
- Self role assignment is denied. Only a current PLATFORM_ADMIN actor can assign/revoke `PLATFORM_ADMIN` or roles that define IAM/Building administration.
- Revocation of the last usable PLATFORM_ADMIN assignment returns `409 LAST_OWNER_ROLE_REQUIRED`. The check and write are serialized transactionally.
- Owner may administer an arbitrary explicit Building assignment, but this does **not** automatically assign a Building to the Owner. Non-Owner scope administrators are limited to exact Buildings they themselves can access. Same-Client sibling scope is not sufficient.
- Non-Owner `GET /users/{id}/buildings` reads are filtered to the actor's exact accessible Building IDs.
- Deactivate/suspend revokes active sessions. Reactivate supports INACTIVE and SUSPENDED but never restores a revoked session; the user must log in again.
- SYSTEM_ADMIN cannot modify the Owner account. Self-suspension/deactivation and last Owner lockout are blocked.

## Audit and incident triage

Authorized auditors call `GET /api/v1/auth/audit-events` with `auth.audit.read`. Use filters such as `eventType`, `userId` (target), `actorUserId`, `outcome`, date window, `limit` and `offset`. IAM events record invitation, activation, lifecycle, role, Building scope and credential actions with event time and outcome. The API never returns password/hash/token material; sensitive metadata keys are redacted at the read boundary.

If a sensitive mutation succeeds but its expected audit event is absent, first verify migration 0453 status and application logs via existing approved operations. Do not write directly to production tables to repair audit history.

## Production boundary and rollback

- This work does not repeat bootstrap, seed users, modify credentials, invalidate existing sessions, or configure/access production infrastructure.
- Migration 0453 extends the audit event CHECK vocabulary only. It adds no IAM tables, columns, credentials or default data. Existing event types are preserved.
- If release rollback is needed, follow the normal Backend database release policy. Do not manually drop audit data or rerun Owner provisioning. Audit event-type rollback can be blocked if new event rows already exist; use the approved forward-fix/restore plan rather than deleting audit records.
- No email provider or delivery success is simulated. Until invitation delivery is separately integrated and verified, controlled out-of-band handoff is mandatory.

## API handoff

Exact request/response schemas, permissions, error codes, session behavior and lifecycle examples are in [`CR-HM-BE-IAM-ADMIN-02_FRONTEND_HANDOFF.md`](../api/CR-HM-BE-IAM-ADMIN-02_FRONTEND_HANDOFF.md) and [`docs/api/openapi.yaml`](../api/openapi.yaml).
