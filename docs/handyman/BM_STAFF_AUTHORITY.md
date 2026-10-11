# BM staff authority — additive implementation on migration 0452

Baseline: `c578a9969024ca6db388d45d54c5de5e79f256e3`.

This supersedes the missing-authority blocker recorded in
`BM_STAFF_SSO_AND_BUILDING_SCOPE.md`. Migration 0452 and its cryptography,
60-second receipt, durable nonce/replay store and revocation guards are unchanged.
Migration 0453 defines explicit local staff authority; additive 0454 audits
every staff session invalidation, including automatic authority transitions.
Initial focused admission/API tests passed; final expanded validation is pending.

## Authority contract

- An authorized administrator explicitly binds an existing integration issuer +
  opaque subject (the registered Care actor reference used by 0452) to an existing
  local User. The Care actor row is unchanged and remains an independent non-User
  principal for existing integrations. No matching by email/User ID/claim inference.
- Local RBAC permission `handyman.care.staff.access` is the CUSTOMER_CARE
  entitlement. New role `HANDYMAN_CUSTOMER_CARE` groups that permission only.
  Migration creates catalogue entries, never User assignments. Existing authorized
  role/permission administration must assign entitlement before login.
- An explicit staff scope grant binds this identity to one tenant company and
  one exact Building, referencing an existing active User Building assignment.
  Client is derived from Building → Property → Client and must match the tenant.
  A live effective tenant Building context is also required. No sibling Building,
  property-wide, cross-tenant or cross-Client inference grants staff access.
- Each session is bound to ONE scope grant. Other grants require a fresh admission;
  adding a grant never widens an issued session. Mapping/grant revocation is
  irreversible; regrant/rebind produces new rows. Historical facts cannot be deleted.

## Authorized provisioning

All paths are relative to `/api/v1/handyman/care/staff-authority`. They require a
normal local User bearer session (not Care/PIC/staff SSO), plus a live ACTIVE User
holding `user.manage`, `permission.manage`, `tenant_company.manage` and the
permission being delegated (`handyman.care.staff.access`), with explicit active
Building assignment for every affected scope. This is existing RBAC/delegation,
not a new bootstrap. Global binding withdrawal requires access to all its scopes.

- POST `/bindings`: exactly `integrationId`, `subject`, `userId`, `buildingId`,
  `tenantCompanyId`. Atomically creates binding + initial grant; returns 201
  `{id,userId,integrationId,scope:{id,bindingId,tenantCompanyId,buildingId}}` in
  normal success envelope. Does not create Users, roles, User-role assignments or
  User-Building assignments. Duplicate active identity/scope returns 409.
- POST `/bindings/:bindingId/grants`: `buildingId`, `tenantCompanyId`; adds an
  explicit grant after checking existing User Building assignment and tenant context.
- DELETE `/bindings/:id`, `/grants/:id`: irreversibly withdraw authority and
  invalidate linked staff sessions; 204. No body/query fields.
- DELETE `/sessions/:id`: explicitly revoke a bounded staff session; 204.

Every effective provisioning/revocation is audited atomically. Unauthorized
provisioning returns 403, invalid credentials 401, malformed fields 400.

## Admission and lifecycle

POST `/api/v1/handyman/care/staff-sso/launches` retains the signed 0452 body,
HMAC, issuer/audience, ACTIVE integration/actor and transport property checks.
202 still means transport only, never admission. The response contains only the
one-time reference and expiry. Headers now advertise `explicit-authority-required`.

POST `/api/v1/handyman/care/staff-sso/exchange` takes
`{launchReference,tenantCompanyId}`. The tenant is merely a selector, never
trusted authority; the exact Building comes from the signed receipt. Exchange
atomically consumes the receipt and issues a staff session only if binding,
User ACTIVE, live RBAC, explicit tenant/Building grant, original property grant,
physical hierarchy, tenant context, current integration key and expiry all pass.
No User/role/grant is auto-created. A valid but unauthorized reference is consumed
and returns existing 409 `HANDYMAN_BM_STAFF_AUTHORITY_UNAVAILABLE`; missing tenant
selection also fails closed. Invalid/replayed/expired transport returns 401.

201 response: `workspaceToken` (`hbs_`, random 256 bits), `expiresAt`,
`principalType: BM_STAFF`, `userId`, `buildingId`, `tenantCompanyId`, normal envelope.
Only a token hash is stored. It is a genuine local-User-backed **bounded staff
Care session**, not a generic Operations/administration User session or PIC
credential. Reuses the Care session lifecycle/store and existing Care business
services, with immutable staff provenance linking receipt and scope grant.

Bearer only in Authorization, over TLS. Never in WebView URLs, query, path,
logs/audit, or persistent browser URL state. Launch references are POSTed too.
Existing backend bearer convention is retained; no cookie/refresh protocol or
new external IdP is introduced. Absolute maximum 15 minutes, no sliding expiry.

- GET `/api/v1/handyman/care/staff-sso/session`: live local staff context and expiry.
- DELETE same path: idempotent logout, works even after entitlement loss/expiry.
- Existing DELETE `/api/v1/handyman/care/session` also logs out staff tokens.
- POST `/staff-sso/revoke` retains pending-reference cancellation semantics.

Integration/actor transitions retain existing permanent session invalidation.
User, RBAC, binding, scope, User Building assignment, tenant/physical hierarchy
and original property grant withdrawal additionally invalidate staff sessions
without touching legacy Care sessions. Live checks are mandatory, including
context time windows. Withdrawn bound authority also invalidates eligible pending
receipts. Credential binding is checked against the current key at each session
use. Continue the 0452 deactivate → rotate all replicas/BM → reactivate procedure;
no unsupported dual-key grace period or hot-swap/restore guarantee.

## Protected API boundary

The existing `/handyman/care/*` endpoints accept `hbs_` credentials with mandatory
staff checks, not a separate business engine. Prefix changes cannot drop the staff
link. SQL projections filter properties, Buildings, tenants, tenant spaces,
occupancies, requests, quotation inbox/detail and catalogue selections to the
session's grant. Staff context is revalidated under locks for quotation mutations,
request-create exchange issuance AND consumption, and payment reporting authority.
Payment reporting still additionally requires the existing explicit Care actor
payment permission; staff access never grants finance verification.

Non-User `hcw_` Care behavior is unchanged. PIC `hpw_` admission/claim/decision
remains separate. Staff facilitates resident communication and PIC handoff;
only independently authenticated authorized Tenant PIC can approve. No Gatepro,
Platform Admin, generic provisioning, automated resident delivery or PIC elevation.

## Operations prerequisites

Provision existing BM integration/actor/secret and Care property grant; create or
select existing local staff User, assign the explicit local role/permission through
existing authorized administration, and grant exact Building access before creating
the binding/tenant grant. Administrators must already hold delegation authority;
this migration assigns it to nobody. Configure TLS, trusted server signing,
clock synchronization, protected BM delivery and credential-redacting ingress/APM.
Actual BM WebView/frontend deployment and multi-replica rotation remain external
integration checks, not something backend PostgreSQL/HTTP tests can certify.

## Validation

Production typecheck: PASS. Existing 0452 transport tests: 12 PASS.
Initial actual staff admission/API tests: 15 PASS / 0 FAIL / 0 SKIP at `a2e7b1b`.
Expanded tests (issuer isolation, complete RBAC withdrawal, automatic revocation
audit and catalogue filtering) plus bounded Care/PIC regressions pending final run.
