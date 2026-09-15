# Asentra Backend — Engineering Governance

This document is the engineering authority for `asentra-backend`.

It records START GOVERNANCE only. It does **not** implement product APIs,
database schema, or domain modules. Those arrive in later `BE-XX PART XX`
instructions.

---

## Platform

Asentra Backend is the production backend for **Asentra Facility & Housekeeping
Management**.

| Surface | Repository | Role |
|---|---|---|
| Backend | `asentra-backend` | Final business and security authority |
| Web | `asentra-web` | UI consumer |
| Mobile | Flutter repository | UI consumer |

Technology target:

- Node.js
- TypeScript
- PostgreSQL
- Versioned REST API
- Environment-based configuration
- Database migrations
- Automated backend tests

---

## Core architecture

The backend is the **final authority** for:

- Authentication and session security
- Authorization, RBAC, and permissions
- Module entitlement
- Client data isolation
- Property / building data isolation
- Data scope
- Business rules
- Workflow state
- Approval rules
- Available actions
- Database persistence
- Audit trail
- Configuration lifecycle

Frontend and mobile applications must **never** become the authority for these
rules. Hiding a control in the UI is not authorization.

---

## Platform principle

Asentra must support:

```text
ONE BACKEND PLATFORM
+ MULTI CLIENT
+ MULTI PROPERTY
+ MULTI BUILDING
+ DYNAMIC ORGANIZATION
+ DYNAMIC ROLE / PERMISSION
+ MODULE ENTITLEMENT
+ CONFIGURATION
```

Do **not**:

- build separate backend logic for individual buildings
- hardcode `if building == Graha Mampang`
- hardcode `if role == BM then allow everything`

Business behavior must be resolved through configuration, permission,
entitlement, context, workflow, and data scope.

---

## Effective user context

An authenticated user must eventually resolve to an effective context containing:

- User
- Client
- Property
- Building
- Organization
- Department
- Team
- Position
- Role
- Permission
- Data scope
- Entitlement
- Available workspace
- Configuration

The backend remains the final authorization authority even when the frontend
hides unavailable functions.

Never trust `clientId` or `buildingId` sent by a client without validating that
the authenticated user has access to that scope.

---

## Domain capability target

The architecture must remain capable of supporting these domains
**progressively**. Tables, APIs, and services for a domain are created only
when a PART requires them.

### Platform foundation

Identity, authentication, session, user management, RBAC, permission, client,
property, building, organization, department, team, position, workforce
assignment, module entitlement, configuration.

### Building structure

Campus, floor, area, room, space, functional location.

### Asset & engineering

Asset, equipment, asset hierarchy, work order, preventive / corrective
maintenance, breakdown, inspection, meter reading, equipment log, engineering
checklist, finding, verification, spare part / material, vendor maintenance.

### Housekeeping

Cleaning area, cleaning standard, cleaning schedule, team assignment, daily
cleaning, toilet / public area / supervisor inspection, finding, rework,
consumable, quality audit, complaint, housekeeping reporting.

### Security

Security shift, post, patrol, daily activity, finding, incident, emergency
readiness, visitor / contractor linkage, key control, lost & found, security
reporting.

### Front desk

Expected visitor, walk-in visitor, check-in / check-out, visitor pass,
delivery / courier, tenant assistance, front desk log, shift handover.

### Tenant

Tenant company, tenant PIC, service request, complaint, visitor request,
utility meter review, utility approval / rejection, permit, parking, invoice
notification, announcement, document.

### Vendor

Vendor company, vendor PIC, assigned work, work permit, vendor checklist,
evidence, service / completion report, BAST, verification, finding, rework,
vendor work history.

### Shared operations

Dynamic form, checklist, measurement, UOM, evidence, scheduler, assignment,
finding, rework, verification, approval, reject, escalation, available
actions, operational timeline.

### Utility & resources

Meter, meter reading, verification, tenant approval, billing readiness,
inventory, stock, material usage, consumable, material request, purchase
request, receiving.

### Lite ERP

Intentionally lightweight: invoice, electricity bill, payment status,
operational finance.

Do **not** implement a full accounting or ERP suite unless explicitly requested.

### Reporting

Daily / weekly / monthly reports, domain KPIs, approval, revision, report
archive.

### Configuration studio

Client, building, organization, department, team, position, role assignment,
module, navigation, workspace, dashboard, operational settings, approval
matrix.

### Dynamic operations administration

Form template, checklist template, evidence rule, measurement / UOM,
scheduler configuration, workflow configuration.

### CMS & branding data

Announcement, help, FAQ, knowledge, portal content, release information,
logo / brand / theme / login / report branding.

Configuration lifecycle:

```text
DRAFT → VALIDATE → PREVIEW → PUBLISH → ACTIVE → SUPERSEDED
```

---

## API principles

Use versioned REST routes:

```text
/api/v1/...
```

Examples (implemented only when a PART requires them):

- `/api/v1/auth`
- `/api/v1/users`
- `/api/v1/context`
- `/api/v1/clients`
- `/api/v1/buildings`
- `/api/v1/roles`
- `/api/v1/permissions`
- `/api/v1/entitlements`

Web and mobile consume the same backend business authority. Device-specific
APIs exist only when genuinely necessary.

### Response contract

Success:

```json
{
  "success": true,
  "data": {},
  "meta": {}
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Readable message"
  }
}
```

Do not expose internal stack traces to API consumers.

---

## Security principles

Every protected operation must be validated by the backend:

- Authentication
- Authorization
- Permission checks
- Client isolation
- Building isolation
- Data scope
- Module entitlement
- Input validation
- Secure password handling
- Secure session / token handling

Frontend visibility is **not** authorization.

---

## Database principles

PostgreSQL is the authoritative persistent store.

Design must support:

- UUID primary keys where appropriate
- `created_at` / `updated_at`
- `created_by` / `updated_by` where relevant
- status / state where relevant
- foreign-key integrity
- indexes for important lookup fields
- migrations
- seed data only when explicitly needed

Avoid premature denormalization.

Do **not** create tables for future Waves unless they are genuinely needed by
the current PART.

Do **not** store large binary files in PostgreSQL unless explicitly required.
File / evidence storage must remain abstracted so local, cloud, hybrid, or
on-premise deployment can be supported later.

---

## Multi-tenant isolation

Progressive isolation model:

```text
Client → Property → Building → operational data
```

Never trust client-supplied scope identifiers without access validation.

---

## Workflow principles

Workflow authority belongs in the backend.

The backend should eventually determine:

- current state
- valid transitions
- required permission
- required verification
- required approval
- available actions

Frontend should receive backend-provided available actions instead of
recreating workflow rules locally.

Example concept:

```json
{
  "status": "PENDING_VERIFICATION",
  "availableActions": ["VERIFY", "REJECT", "REQUEST_REWORK"]
}
```

Do **not** implement a generic workflow engine prematurely. Build it
incrementally according to the backend roadmap.

---

## Audit principles

Critical operations should progressively support:

- Actor
- Timestamp
- Entity
- Action
- Previous state
- New state
- Relevant context

Do not silently overwrite operational history when historical traceability is
required.

---

## Implementation structure

Prefer a modular monolith:

```text
asentra-backend/
├── src/
│   ├── config/
│   ├── database/
│   │   ├── migrations/
│   │   └── seeds/
│   ├── middleware/
│   ├── shared/
│   ├── modules/
│   ├── routes/
│   ├── app.ts
│   └── server.ts
│
├── tests/
├── docs/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```

Inside a domain module, prefer separation only where justified:

```text
modules/
└── users/
    ├── user.model.ts
    ├── user.repository.ts
    ├── user.service.ts
    ├── user.controller.ts
    ├── user.routes.ts
    ├── user.validation.ts
    └── user.types.ts
```

Do not create empty architecture layers purely for appearance.

---

## Engineering rules

Use:

- TypeScript strict mode where practical
- Environment variables and centralized configuration
- Centralized error handling
- Request validation
- Structured logging
- Database migrations
- Clear service boundaries
- Reusable authorization middleware
- Automated focused tests

Avoid:

- giant controllers or service files
- duplicated business rules
- raw SQL scattered across controllers
- frontend-derived authorization
- building-specific hardcoded logic
- role-specific forks
- unnecessary dependencies
- premature microservices

---

## PART execution rules

This project is implemented in **small parts**.

For every instruction:

1. Inspect the existing repository first.
2. Preserve working implementation.
3. Implement **only** the requested Wave / PART.
4. Do **not** implement future PARTs.
5. Do **not** refactor unrelated modules.
6. Keep changes small.
7. Run focused validation.
8. Fix only issues introduced or directly exposed by the current PART.
9. Update documentation only where relevant.
10. Summarize changed files.
11. Stop.

If a PART becomes too large, split it:

```text
PART 03A
PART 03B
PART 03C
```

Do not combine unrelated backend capabilities merely to finish faster.

---

## Git governance

Preferred Wave branch pattern:

```text
wave/be-00-foundation
wave/be-01-identity
wave/be-02-platform-context
```

Arena sessions are bound to a fixed session branch. Work stays on that branch
when a session constraint applies.

One backend Wave follows:

```text
START GOVERNANCE
→ PART 01
→ PART 02
→ …
→ Integration Validation
→ Documentation
→ FINAL REVIEW
→ Fix
→ Final Validation
→ Commit
→ Push
→ Pull Request
```

Do **not** automatically create a Pull Request during normal PART execution.

Do **not** automatically merge a Pull Request.

A PR in the middle of a Wave is allowed only when explicitly requested as a
Change Request.

---

## Current status

| Item | State |
|---|---|
| Repository | Node.js + TypeScript + PostgreSQL |
| Wave / PART | BE-01 Identity, Authentication & Access complete |
| Identity | Users (UUID, normalized unique email, status: INVITED/ACTIVE/INACTIVE/SUSPENDED) |
| Credentials | bcrypt password hashing, verification, policy, password change foundation |
| Sessions | Opaque-token sessions (hash-only storage), expiry, revocation, logout |
| Roles / Permissions | `roles`, `permissions`, user-role and role-permission assignments |
| Authorization | Default-deny RBAC via `requirePermission(...)` + effective permission resolver |
| Onboarding | Invitations (create/accept/revoke) + account lifecycle (deactivate/suspend/reactivate) |
| Security | Persistent authentication audit + per-IP login rate limiting |
| Effective context | `GET /api/v1/auth/me` returns User + active Roles + effective Permissions |
| Tests | Node test runner + SuperTest; isolated `asentra_test` |
| Database | Local PostgreSQL + 11 migrations + idempotent `PLATFORM_ADMIN` bootstrap seed |

**Next:** review of the BE-01 Pull Request. Client, Subscription, Entitlement,
Property, Building, Organization, Data Scope, Workspace, and Configuration
remain deferred to later Waves.
