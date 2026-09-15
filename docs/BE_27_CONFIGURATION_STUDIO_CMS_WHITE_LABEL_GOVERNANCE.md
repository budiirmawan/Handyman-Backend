# BE-27 — Configuration Studio, CMS & White Label Backend (START GOVERNANCE)

> **Status:** START GOVERNANCE — documentation only. No BE-27A API,
> migration, permission, route, configuration record, or business rule is
> implemented by this step.
> **Baseline:** `main` / Arena branch `arena/01a0121f-asentra-backend` at
> `30d14afaec44ee16f6b78d52bd1cccf23d386a64` (merged PR #29 = BE-26
> Notification & Omnichannel), on top of BE-25 mobile contracts and BE-24
> management/owner read models.
> **Date:** 2026-08-17
> **Repository boundary:** backend only. This repository contains no Web,
> Flutter, chart-rendering, or Configuration Studio UI implementation.

## 1. Governance verdict

- The frozen BE-27A–Q product boundaries are coherent and may remain as
  defined.
- The repository has strong reusable Client/Building context, commercial
  Module Entitlement, RBAC, effective-context, BE-07 Form/Checklist, BE-23/24
  read-model, BE-25 mobile-contract, event-history, transaction, and OpenAPI
  foundations.
- It does **not** yet have a general configuration aggregate, deterministic
  Client→Building override resolver, Feature registry, Navigation/Workspace/
  Widget registries, CMS/branding records, the frozen configuration lifecycle,
  preview contexts, or configuration-specific version/audit APIs.
- There is no hard blocker to an unversioned BE-27A Client key/value
  foundation. Its ACTIVE/INACTIVE record status controls current effectiveness
  only; publication must wait for BE-27N/O and each configuration kind's validator.
- **Ready for BE-27A: YES — BE-27A only**, under the boundaries in §12.

## 2. Frozen boundary and governing invariants

BE-27 is a backend configuration authority. It stores, validates, resolves,
versions, previews, publishes, and audits configuration; it does not implement
the Configuration Studio UI or render configured output.

The following invariants are mandatory across A–Q:

1. **One authority, no parallel engines.** BE-27 may administer or reference
   BE-07 Forms/Checklists, BE-02 Entitlements, RBAC, and BE-23/24 read models;
   it must not copy their runtime rules into a second engine.
2. **Scoped records.** Every BE-27 configuration set belongs to exactly one
   Client and optionally one Building. A Building's Client is derived through
   `Building → Property → Client`; a caller-supplied Client/Building pair is
   never trusted without that check.
3. **Deterministic precedence.** A Building-scoped ACTIVE configuration may
   override the Client-scoped ACTIVE configuration for the same configuration
   kind/key. Override is whole-artifact replacement, not an implicit JSON deep
   merge. If no Building artifact exists, resolve the Client artifact. Missing
   configuration is explicit; no hidden global default grants capability.
4. **Scope authorization.** Normal administrators are limited by
   `contextAccessService`. A platform bootstrap exception, if required for a
   Client with no Building yet, must use a dedicated RBAC permission such as
   `configuration.platform.manage`; never hardcode a role name or silently
   treat `configuration.manage` as cross-Client access.
5. **Entitlement is a ceiling.** Existing Subscription/License/Module
   Entitlement resolution remains the commercial authority. Module/Feature,
   Navigation, Workspace, and Dashboard configuration may only narrow the
   effective capability set; configuration can never enable a commercially
   unavailable Module or bypass a Permission.
6. **RBAC remains runtime authority.** Configured visibility is not
   authorization. Every underlying API continues to enforce its existing
   permission and data-scope rules even if Navigation or Workspace metadata
   exposes an item.
7. **Immutable publication.** A version is mutable only while DRAFT. From a
   successful VALIDATE transition onward its content/checksum is immutable.
   Edits create a new DRAFT version.
8. **Exact lifecycle.** The lifecycle remains:
   `DRAFT → VALIDATE → PREVIEW → PUBLISH → ACTIVE → SUPERSEDED`.
   Failed validation leaves the candidate DRAFT. `PUBLISH` is an auditable
   atomic publication milestone; the externally effective result is ACTIVE and
   the former ACTIVE version becomes SUPERSEDED in the same transaction.
9. **One ACTIVE version.** At most one ACTIVE version exists for a
   `(client, optional building, configuration kind, stable key)` set. Publish
   uses a transaction and row lock/uniqueness constraint to prevent concurrent
   activation races.
10. **No destructive rollback.** Restoring old content clones that snapshot
    into a new DRAFT version; an ACTIVE/SUPERSEDED row is never edited back in
    place.
11. **Typed data, not executable configuration.** Payloads are schema-versioned
    and allowlisted per configuration kind. No arbitrary SQL, JavaScript,
    template execution, provider credentials, or unbounded HTML is accepted.
12. **Compatibility first.** Existing Web/Mobile endpoints, response fields,
    status enums, Form/Checklist execution identities, and BE-23/24 read-model
    formulas remain unchanged. Effective configuration starts as an additive
    endpoint rather than a breaking rewrite of `/auth/me`.
13. **No rendering.** Dashboard/Widget, CMS, and brand metadata may describe
    presentation, layout, or a read-model source, but the backend does not draw
    charts, generate UI, or implement Flutter/Web behavior.

## 3. Current baseline (verified, not modified)

| Foundation | Current state |
|---|---|
| Runtime | Node.js 20+, TypeScript (strict), Express 5, PostgreSQL |
| Persistence | **245 additive migrations**, `0001`–`0245`; latest is BE-26 secure links |
| API surface | Approximately **1,178 route registrations** in `src/modules/**/*.routes.ts` |
| API contract | Shared success/error envelopes, request IDs, named error codes, conflict metadata, opt-in mobile pagination |
| OpenAPI | `docs/api/openapi.yaml`: **76 paths / 154 schemas**, incrementally maintained; it does not document most legacy administration routes |
| Client/Building scope | Client→Property→Building hierarchy, user Building assignments, `contextAccessService`, and BE-24 selected-scope intersection |
| Commercial availability | Subscriptions, Licenses, global Module catalogue, Module Entitlements, and the authoritative effective-entitlement resolver |
| Effective context | `/auth/me` returns user, roles, permissions, accessible Client/Property/Building hierarchy, Workforce identity, flat scope, and aggregated Module entitlements |
| Dynamic operations | BE-07 Source Forms, Form templates/sections/fields/versions/instances, conditions/repeatables, Checklist templates/items/executions, UOM, evidence requirements, schedules, reviews, tasks, and events |
| Read models | BE-23 KPI/report services and BE-24 management models including Operational KPI, Building Performance, Portfolio Overview, and Operations Command Center |
| Mobile | BE-25 assignment/checklist/evidence/sync/conflict/idempotency/error/app-version contracts; push-token registry remains available |
| History | Append-only `operational_events`; separate authentication-only audit events; request correlation and metadata scrubbing |
| Transactions | Shared `withTransaction`; existing `FOR UPDATE` and partial-unique-index precedents |
| Media storage | Evidence-specific local storage interface/keyspace only; there is no generic CMS/branding media store |

## 4. Reusable foundations by frozen PART

| PART | Reusable authority | Reuse rule / limitation |
|---|---|---|
| **A — Client Configuration** | `clients`, Client status/code identity, `getAccessibleClientIds` | Keep Client master legal/commercial fields authoritative; configuration is a separate scoped artifact. Client scope currently derives from at least one accessible Building, so platform bootstrap needs the explicit permission policy in §2.4. |
| **B — Building Configuration** | `buildings`, Property→Client ownership, IANA timezone validation, `assertBuildingAccess` | Do not duplicate address/status/timezone master data. A Building override must derive its Client from the hierarchy. |
| **C — Module Configuration** | Global `modules` catalogue and stable module codes | Configuration may add scoped labels/order/local enablement, but must not create a competing Module catalogue. |
| **D — Feature Entitlement Configuration** | Subscription/License/Module Entitlement resolver plus Permission registry | Reuse the resolver as the commercial ceiling. No Feature catalogue or per-Feature resolver exists yet. `/auth/me` entitlement output is aggregated across Clients and is insufficient for selected-Client resolution. |
| **E — Navigation Registry** | Stable permission/module codes and registered backend route capabilities | There is no Navigation record. Registry entries must reference allowlisted capability keys, not arbitrary API URLs or permission substitutes. |
| **F — Workspace Registry** | Effective context and E Navigation output | `EffectiveUserContext` explicitly defers Available Workspace/Configuration. There is no Workspace record or resolver. |
| **G — Dashboard / Widget** | BE-23 KPI/report services; BE-24 scope resolver and management read models | These are authoritative data sources only. They intentionally contain no Widget/layout/chart authority. Widgets must reference stable source keys and never carry SQL or recalculate KPIs. |
| **H — Dynamic Form Administration** | Existing Source Form, Form template, section/field, Form version, condition/repeatable, UOM, evidence and schedule APIs | Extend/administer the existing engine. Existing Form versions use `DRAFT/PUBLISHED/RETIRED`, not BE-27 lifecycle, and remain a separate operational-template lifecycle referenced by BE-27 configuration. |
| **I — Checklist Administration** | Existing Checklist template/item/execution, UOM/evidence, and domain binding services | Reuse the engine. Checklists currently have mutable templates/items and **no Checklist version snapshot**, which is a publication prerequisite for I. |
| **J — Operational Settings** | Building timezone, UOM/measurement rules, schedules, utility type configuration, domain services | Existing domain-owned configuration stays authoritative. BE-27 settings must be typed/allowlisted and consumed through explicit adapters; environment variables and provider secrets are not tenant settings. |
| **K — Organization Presentation** | Client-scoped Organization master and workforce hierarchy | Presentation data may reference an Organization, but must not duplicate Organization membership/status/hierarchy authority. |
| **L — CMS Content** | Mobile app release metadata, Notification templates, Tenant communications | These are specialized authorities, not a general CMS. Reuse by reference where semantically exact; do not relabel notification templates or tenant communication records as CMS content. |
| **M — Branding & White Label** | Evidence storage interface pattern, Document/version records, reporting output contracts | Reuse the storage abstraction pattern, not the evidence table/keyspace. No generic logo/font/favicon asset backend or pre-auth published-brand resolver exists. |
| **N — Configuration Versioning** | Form-version and Document-version precedents; immutable operational history conventions | No general version model spans configuration kinds. Form/Document versions must not be repurposed as BE-27 versions. |
| **O — Draft / Validate / Publish** | Status-transition services, `withTransaction`, row locks, partial unique indexes, conflict errors | No shared configuration validator registry or publish transaction exists. |
| **P — Preview Context** | Effective context, selected-scope validation, BE-25 app/device context | No preview token/context or side-effect-free effective resolver exists. Preview must never alter ACTIVE runtime context. |
| **Q — Configuration Audit** | `operational_events`, actor/building/client metadata, scrubbed JSON metadata, request IDs | Prefer configuration event types/projections over this append-only log. Authentication audit is unsuitable because its event-type constraint is security-specific. |

## 5. Missing capabilities

| ID | Missing capability | Impact |
|---|---|---|
| M1 | Shared configuration-set identity and Client/optional-Building scope | A–Q cannot share deterministic identity, precedence, or uniqueness. |
| M2 | Typed schema registry and schema-version validation per configuration kind | Arbitrary JSON would make the backend non-authoritative and unsafe. |
| M3 | General immutable version/checksum model | Published A–M configuration cannot meet the versioning rule. |
| M4 | Exact DRAFT→…→SUPERSEDED state machine, validator registry, atomic publish | No safe lifecycle or one-ACTIVE guarantee exists. |
| M5 | Effective configuration resolver with whole-artifact Building override | Web/Mobile cannot obtain one authoritative context-specific result. |
| M6 | Per-selected-Client entitlement projection | `/auth/me` deduplicates Module codes across all accessible Clients; using it for one Building could leak availability from another Client. |
| M7 | Feature registry and Feature-to-Module relationship | D has no stable features to configure or validate. |
| M8 | Navigation, Workspace, Widget source, and Dashboard composition registries | E–G are greenfield. |
| M9 | Scope-safe administration over legacy Form/Checklist definition APIs | Several BE-07 administration routes enforce RBAC but do not consistently intersect records with `contextAccessService`. |
| M10 | Checklist immutable versions and version-bound executions/responses | Publishing Checklist administration would expose mutable definitions and break reproducibility. |
| M11 | Complete Form snapshot hardening | Form publication is not transaction-wrapped; multiple PUBLISHED versions are possible; measurement/UOM columns added later to live fields are not present in the original version snapshot schema. Historical values cannot be perfectly reconstructed after mutation. |
| M12 | Operational setting key/type/sensitivity registry | Arbitrary settings could become an unreviewed second business-rule engine or secret store. |
| M13 | Organization presentation, CMS, and scoped brand profiles | K–M are greenfield. Existing specialized content is not a substitute. |
| M14 | Generic managed media storage/publication | Evidence storage is evidence-specific and cannot safely serve public branding/CMS assets as-is. |
| M15 | Preview context/token, expiry/revocation, and preview-only resolver | P is greenfield; unsafe preview plumbing could leak drafts into runtime. |
| M16 | Configuration audit projection/event vocabulary and before/after policy | Operational events can store it, but no standard event types, diff policy, or Q API exists. |
| M17 | BE-27 RBAC family and platform-bootstrap scope policy | Existing permissions do not distinguish scoped configuration administration, lifecycle actions, preview, publish, and audit. |
| M18 | OpenAPI coverage for configuration and most existing Form/Checklist admin routes | Generated consumers cannot rely on the current spec for BE-27. |

## 6. Recommended backend model

### 6.1 Shared aggregate

Use a hybrid model:

- a stable `configuration_sets` identity carrying `client_id`, optional
  `building_id`, `kind`, stable `key`, and ownership metadata;
- lifecycle-controlled rows in `configuration_versions`, carrying a monotonic
  version number, schema version, lifecycle state, typed JSONB snapshot,
  checksum, base-version reference, actor/timestamps, and publication metadata;
  only DRAFT content is mutable, and successful validation freezes it;
- normalized registries where relational identity matters (Feature,
  Navigation, Workspace, Widget source), referenced by stable IDs/codes from a
  version snapshot;
- kind-specific validators/services. A generic payload table must not become a
  bypass around relational, entitlement, permission, Form, or Checklist
  validation.

Use separate partial unique indexes for Client-level and Building-level set
keys (to handle nullable `building_id`) and a partial unique index for the one
ACTIVE version. Verify Building→Client consistency in the same transaction;
consider a database trigger only if service-level derivation cannot provide a
hard invariant without duplicating Client ownership on `buildings`.

### 6.2 Effective resolution

For an authenticated request and selected Building:

```text
authenticated user
→ RBAC capability
→ accessible Building / derived Client
→ ACTIVE Building artifact, else ACTIVE Client artifact
→ effective Module Entitlement for that Client
→ configured Module/Feature narrowing
→ Permission narrowing
→ available Navigation / Workspace / Dashboard projection
```

The resolver must call the existing entitlement algorithms per Subscription;
it must not use the cross-Client deduplicated `/auth/me.entitlements` list as a
selected-Client decision. A dedicated additive effective-configuration endpoint
should precede any optional `/auth/me` extension.

### 6.3 Lifecycle semantics

- **DRAFT:** only mutable state; use optimistic revision/ETag conflict checks.
- **VALIDATE:** reached only after all kind validators succeed against the exact
  payload checksum and selected scope. Failure leaves DRAFT plus diagnostics.
- **PREVIEW:** immutable validated snapshot exposed only through P's authorized,
  expiring preview context. It has no operational side effects.
- **PUBLISH:** auditable transaction milestone; revalidate entitlement/reference
  freshness, lock the configuration set, and activate atomically.
- **ACTIVE:** sole runtime candidate for its scope/kind/key.
- **SUPERSEDED:** former ACTIVE snapshot, immutable and readable as history.

Every transition emits a scoped `operational_event`. Publish emits version,
checksum, previous-active ID, actor, reason, and request ID metadata, but no
secret, raw token, binary content, or unbounded full payload.

## 7. Dependencies and recommended execution order

The product labels stay A–Q, but implementation should follow dependencies
rather than assume every alphabetical part may publish immediately:

```text
A (scoped Client key/value record + effective ACTIVE read)
└─ N (shared immutable versions/history)
   └─ O1 (validator registry + lifecycle through PREVIEW eligibility)
      ├─ B → C → D → E → F → G1 → G2
      ├─ H1 → H2
      ├─ I1 → I2
      ├─ J
      ├─ K
      ├─ L
      └─ M
          ↓
         P (authorized preview context)
          ↓
         O2 (atomic publish/ACTIVE/SUPERSEDED)

Q event writes begin with A; Q's filtered audit API/final policy closes the wave.
```

Detailed dependencies:

- **A/B:** Client/Building masters, context access, scoped/global configuration
  permission policy.
- **C/D:** A/B plus Module catalogue, Subscription/License/Entitlement resolver,
  Permission catalogue; D cannot grant outside C's effective Module ceiling.
- **E/F:** C/D plus stable capability keys; F composes E, never duplicates its
  item definitions.
- **G:** F plus stable BE-23/24 source keys and BE-24 selected-scope semantics.
- **H:** BE-07 Forms, UOM, evidence, schedules; H2 is required before Studio-led
  Form publication is treated as reproducible.
- **I:** BE-07 Checklists and domain bindings; I2 version migration is required
  before a Checklist can be safely referenced by published configuration.
- **J:** explicit owning-domain adapters and per-key validators. A setting with
  no authoritative consumer is metadata only and must not claim runtime effect.
- **K:** Organization master plus A/B scope.
- **L/M:** N/O lifecycle, safe content schemas, and (for managed assets) a
  storage abstraction separate from Evidence.
- **P:** validated immutable version, effective resolver, caller scope, expiry,
  recipient binding, and revocation.
- **Q:** Operational Event vocabulary, config filters, pagination, and payload
  redaction.

## 8. Migration requirements

All changes must be additive after migration `0245`; do not rewrite the existing
245 migrations.

### Shared configuration migrations

1. Client-scoped key/value/status storage (A). Its ACTIVE/INACTIVE status is
   record availability, not the later version/publish lifecycle.
2. Configuration version/checksum/lifecycle metadata (N), including monotonic
   `(configuration_set_id, version_number)` uniqueness.
3. One-ACTIVE partial uniqueness and transition timestamps/actors; publish uses
   `withTransaction` + `FOR UPDATE` (O).
4. Validation diagnostics tied to version + checksum, so stale validation
   cannot authorize a changed payload (O1).
5. Preview context records only if P uses opaque preview tokens: store a hash,
   caller, version, Client/Building, expiry, usage/revocation state; never store
   the raw token (P).
6. Idempotent BE-27 permission seed additions. Separate read/manage from
   validate/preview/publish/audit and any explicit platform-wide permission.

### Domain migrations

- Feature catalogue/Module relationship and scoped Feature configuration (D).
- Navigation, Workspace, Widget-source, Dashboard composition definitions
  (E–G), with stable codes and version references.
- Form snapshot hardening only through additive columns/constraints and service
  refactoring; existing Form instance/version IDs remain valid (H2).
- Checklist version and version-item snapshots (I2). Backfill a baseline
  snapshot from each current template; add nullable version references to
  executions/responses first, backfill, and preserve old columns/contracts for
  compatibility before considering later constraints. This extends the same
  Checklist engine; it is not a second engine.
- Operational setting definitions plus typed scoped values (J).
- Organization presentation, CMS content/locales/audience, brand profiles and
  asset metadata (K–M). Store binary assets outside PostgreSQL through a
  dedicated storage interface; database rows store backend-generated keys and
  safe metadata.

### Backfill constraints

- There is no existing general published configuration to backfill for A–G or
  J–M.
- Existing Client, Building, Module, Permission, Organization, Form, Checklist,
  and read-model data should be referenced, not copied into new master tables.
- Existing Form versions retain `DRAFT/PUBLISHED/RETIRED`; do not alter that
  enum to the BE-27 lifecycle. Missing historical measurement snapshot values
  cannot be reconstructed with certainty and must not be fabricated.
- Existing Checklist executions must keep their current API identity and
  response behavior while I2 introduces version-aware writes.
- `mobile_app_versions`, Notification templates, and Notification subscriptions
  are not Client/Building-scoped general CMS records and are not silently
  migrated into BE-27.

## 9. OpenAPI impact

The OpenAPI document needs additive expansion as each route is implemented.
Governance must not add unregistered paths.

Expected contract families (names are design guidance, not implemented routes):

- scoped configuration set/DRAFT CRUD and effective ACTIVE reads;
- version list/get/clone/diff metadata;
- validate, preview-context, publish, and audit actions/reads;
- Feature, Navigation, Workspace, Widget/Dashboard registry administration;
- CMS and published brand/content reads;
- existing/new scope-safe Form and Checklist administration routes rather than
  a duplicate Form/Checklist API family.

Add schemas for scope, kind, lifecycle, version/checksum, validation diagnostics,
effective-source provenance (`CLIENT` vs `BUILDING`), entitlement/permission
filter outcomes, preview expiry, and audit events. Add stable errors such as
configuration not found, scope mismatch, invalid transition, stale version,
validation failure, publish conflict, invalid reference, and expired/revoked
preview context, using the existing error envelope/category/conflict metadata.

Compatibility requirements:

- Do not remove or rename existing paths or fields.
- Do not change existing Client/Building/Module/Form/Checklist status enums.
- Prefer an additive effective-configuration endpoint with `version`, `ETag` or
  checksum, scope, provenance, and cache metadata. This is suitable for both
  Web and BE-25 Mobile caching without forcing existing clients to consume it.
- Do not add draft/preview material to normal Mobile/Web runtime responses.
- A later additive `/auth/me` workspace/configuration summary is optional and
  must be separately contract-reviewed; `/auth/me` currently documents these
  dimensions as deferred.
- BE-23/24 APIs remain data-only. G adds configuration around stable source
  keys; it does not modify KPI formulas or inject chart rendering into those
  responses.

## 10. Risks and blockers

| ID | Risk / blocker | Governance control | Status |
|---|---|---|---|
| R1 | Client access is currently derived through Building assignments; a new Client with no Building has no normal effective Client scope. | Default to scoped access; use an explicit platform-wide configuration permission for bootstrap if required. Never infer access from role name. | Managed for A |
| R2 | `/auth/me` aggregates entitlements across Clients. | Resolve entitlements for the selected Client/Building using existing Subscription resolver calls. | Managed; required by D/effective resolver |
| R3 | Configuration could grant unauthorized UI/API capability. | Effective output is intersection of ACTIVE config, commercial Module entitlement, Feature narrowing, RBAC permission, and Building scope. Source APIs still authorize. | Managed invariant |
| R4 | Concurrent publishes could yield two ACTIVE versions or lost DRAFT edits. | ETag/revision conflict checks, row lock, partial unique index, one atomic publish/supersede transaction. | Managed by N/O2 |
| R5 | Form publishing is not fully transactional/snapshot-complete. | H2 hardens the existing engine; do not publish Form references through BE-27 before validator coverage. | Downstream blocker for H publication, not A |
| R6 | Checklist definitions are mutable and unversioned. | I2 adds snapshots/backfill/version-aware execution within the same engine. | Hard prerequisite for I publication, not A |
| R7 | Legacy Form/Checklist admin routes have uneven data-scope enforcement. | H1/I1 add or refactor to one scope-safe service path; do not expose unsafe routes as Studio contracts. | Managed |
| R8 | Arbitrary settings/JSON become a second business-rule or secret engine. | Per-kind/key typed schemas, size limits, sensitivity classification, explicit domain adapters; secrets remain env/provider-managed. | Managed by J/O1 |
| R9 | Draft preview leaks into ACTIVE runtime or across scope. | Dedicated caller-bound/expiring preview context; preview-only resolver; no global context mutation and no operational side effects. | Managed by P |
| R10 | CMS content introduces XSS/unsafe links or oversized payloads. | Plain text/Markdown or allowlisted structured blocks, URL/media policy, field/total size limits, published-only public reads. | Managed by L/M |
| R11 | Branding assets misuse Evidence storage or expose private files. | Separate storage namespace/interface and explicit public/private publication policy; reuse the pattern only. | Managed; M dependency |
| R12 | Referenced Module/Permission/Form/Checklist/read-model source later becomes inactive. | Validate at transition and publish; runtime always re-intersects current entitlement/RBAC; surface admin diagnostics and safely omit unavailable consumer items. Never let config reactivate the source. | Managed |
| R13 | Audit metadata leaks secrets or grows without bound. | Operational-event scrubbing, allowlisted compact diff/checksum metadata, request ID, pagination; no raw tokens/binaries/full sensitive payloads. | Managed by Q |
| R14 | Hand-authored OpenAPI drifts from the large route surface. | Incremental paths only after registration, focused route/spec tests, unresolved-ref validation and final contract review. | Managed |

**Hard blockers for BE-27A: none.** R5/R6 are downstream publication
blockers isolated to H/I.

## 11. Can A–Q remain as defined?

All frozen product labels remain valid. Only Arena-light execution subdivision
is recommended for four genuinely heavy parts.

| PART | Decision | Arena-light boundary |
|---|---|---|
| A | ✅ Keep | Client-scoped key/value/status foundation and effective ACTIVE read; no version/publish |
| B | ✅ Keep | Building-scoped override identity/resolution |
| C | ✅ Keep | Scoped Module metadata/narrowing; global catalogue unchanged |
| D | ✅ Keep | Feature registry + scoped narrowing in one bounded part; never commercial grant |
| E | ✅ Keep | Navigation registry with stable capability references |
| F | ✅ Keep | Workspace registry/effective availability composition |
| G | ⚠️ Split **G1/G2** | **G1:** Widget/source registry and BE-23/24 source-key validation. **G2:** Dashboard composition/layout and effective projection. No chart rendering in either. |
| H | ⚠️ Split **H1/H2** | **H1:** scope-safe administration facade/refactor over existing Source Form/template/section/field APIs. **H2:** existing Form version/publish snapshot hardening plus conditions/repeatables/UOM/evidence completeness. |
| I | ⚠️ Split **I1/I2** | **I1:** scope-safe Checklist template/item administration. **I2:** immutable Checklist snapshots, backfill, and version-aware execution compatibility in the same engine. |
| J | ✅ Keep | Typed setting definitions/values and explicit consumer adapters only |
| K | ✅ Keep | Organization presentation profile; Organization master remains authority |
| L | ✅ Keep | Bounded CMS entry/content model; no notification or new communication engine |
| M | ✅ Keep (strict boundary) | Brand profile/tokens and safe asset references. If managed binary upload/serving is required, execute internally as M1 metadata then M2 storage without changing frozen M scope. |
| N | ✅ Keep | Shared immutable version/history/clone model |
| O | ⚠️ Split **O1/O2** | **O1:** validation registry and guarded candidate transitions. **O2:** atomic publish, ACTIVE uniqueness, supersession, concurrency/idempotency. P runs between them. |
| P | ✅ Keep | Side-effect-free, authorized preview context |
| Q | ✅ Keep | Configuration event vocabulary + scoped audit read projection over append-only history |

## 12. Ready for BE-27A

**YES — BE-27A only.** Its next implementation must remain small:

- introduce the minimum Client-scoped configuration record with a stable key,
  JSON-safe value, and ACTIVE/INACTIVE record-availability status;
- authorize normal access through accessible Client scope, with any future
  bootstrap exception expressed as a dedicated permission rather than a role bypass;
- add Client-configuration read/manage permissions, stable errors, additive
  OpenAPI, and focused A-only tests;
- support create/list/get/update administration and an effective read containing
  ACTIVE records only;
- do **not** expose version, validate, preview, publish, supersede, Workspace,
  Navigation, Dashboard, CMS, branding, Form/Checklist engine changes, or an
  `/auth/me` configuration field in A.

BE-27N/O/P must own general version history and lifecycle behavior before any
BE-27 configuration version is published and activated.

## 13. What was not done

- No BE-27A implementation, migration, route, permission, error code, test, or
  OpenAPI path was added.
- No Form/Checklist, entitlement, RBAC, reporting, mobile, notification, CMS,
  branding, frontend, or Flutter behavior was modified.
- No full repository tests, focused tests, migration, typecheck, build, or
  server were run.
- No BE-28 work was started. No PR was created and nothing was merged.
