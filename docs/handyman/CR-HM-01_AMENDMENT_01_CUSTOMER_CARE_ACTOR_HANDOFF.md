# CR-HM-01 — AMENDMENT 01: CUSTOMER CARE ACTOR HANDOFF

**Amendment to:** CR-HM-01 — Channel Context & Secure Handoff
**Repository:** Handyman-Backend (only)
**Type:** GOVERNANCE / DESIGN RECORD — **no runtime implementation in this PART**
**Status:** AMENDMENT RECORDED; decisions D4–D8 FROZEN; implementation PARTs 07–12 scheduled, NOT started.

---

## 1. Verified baseline (pre-work gate)

| Check | Result |
|---|---|
| Repository | `Handyman-Backend` |
| Assigned branch | `arena/01a0f51e-handyman-backend` — matches session branch |
| Working tree | CLEAN (`git status --porcelain` = empty) |
| HEAD | `5157645d309ac0ab05c42dda51fab989cde1d0fc` |
| `main` / `origin/main` | `5157645…` — identical to HEAD |
| Main ancestry | `git merge-base --is-ancestor origin/main HEAD` → TRUE |
| CR-HM-01 present | `docs/handyman/CR-HM-01_START_GOVERNANCE.md`, `CR-HM-01_FINAL_VALIDATION.md`, modules `src/modules/handyman-handoff/*`, `src/modules/handyman-channel-attributions/*`, migrations `0374`, `0375` |

**Mismatch check: NO MISMATCH — proceeding.**

Inspection discipline honored: only the CR-HM-01 secure BM handoff seam was
read (handoff runtime/context/binding/HTTP modules, migrations 0374–0375,
channel-attribution domain, and the CR-HM-01 OpenAPI section). No repo-wide
audit. No migration, runtime, OpenAPI, or test execution in this PART.

## 2. GAP — Customer Care actor cannot be represented

**Gap statement.** CR-HM-01 today models exactly **one human actor class**:
the represented customer (Tenant PIC, optionally linked to a local `users`
row). Customer Care operates Handyman through the BM Super App **on behalf
of** a tenant — this actor has no representation, and cannot be added
without violating a frozen invariant.

Evidence (inspection, current HEAD):

1. `src/modules/handyman-handoff/handoff-context.types.ts` —
   `ResolvedHandoffContext.resolvedUserId` is "Local User **linked to the
   customer PIC**; informational only". There is no actor concept at all.
2. `src/modules/handyman-handoff/handoff-context.service.ts` — the resolver
   derives `resolvedUserId` from `tenantPicRepository.findById(...)` →
   `userRepository.findById(pic.userId)`. The only human identity the
   handoff can produce is the customer's linked user (or `null`).
3. `src/modules/handyman-handoff/handoff-runtime.types.ts` — `HandoffAssertion`
   carries integration + context claims only; `HandoffExchangeContextSnapshot`
   carries `resolvedUserId` only.
4. `src/modules/handyman-handoff/handoff-runtime.service.ts` — integration
   trust is `integrationCode` + scoped HMAC secret + `status='ACTIVE'`
   (`handyman_handoff_integrations`); there is no integration-level authority
   over *which class of human actor* an integration may assert.
5. `src/modules/handyman-handoff/handoff-binding.service.ts` — the
   attribution actor is `createdByUserId: consumed.resolvedUserId`, i.e.
   **the represented customer's linked user**. Migration 0374 declares
   `created_by_user_id UUID REFERENCES users (id)`.
6. `src/database/migrations/0375_create_handyman_handoff_runtime.ts` —
   `handyman_handoff_exchanges` has no actor column;
   `handyman_handoff_integrations` has no actor-capability scope.

**Consequences if Customer Care were implemented naively (all forbidden):**

- **False attribution** — recording the Customer Care action under the
  represented customer's linked user (`created_by_user_id`), making a staff
  action indistinguishable from a customer action. Violates actor/tenant
  distinctness.
- **Actor loss** — when the PIC has no linked user (`tenant_pics.userId` is
  nullable and must never be bypassed or fabricated — frozen D2), a
  Customer Care action would be recorded with a null actor: unaccountable.
- **Identity/system fabrication** — minting a local `users` row and/or a
  standard user session for a BM-side operator. Prohibited by frozen D2 and
  by this amendment.
- **Client-supplied identity trust** — accepting an actor id from a request
  body/header without integration attestation. Prohibited by CR-HM-01 §4.

**GAP = the handoff contract has no authenticated, BM-attested, tenant-distinct
Customer Care actor, and no safe carrier from assertion → exchange →
immutable attribution.**

## 3. Contract amendment (backward compatible)

### 3.1 Wire contract — signed actor block inside the handoff assertion

`POST /api/v1/handoff/assertions` body (`HandoffAssertion`) gains ONE
**optional** member:

```json
"actor": {
  "type": "CUSTOMER_CARE",
  "actorReference": "<opaque, integration-scoped, stable operator reference>"
}
```

Rules:

- `actor` **absent** ⇒ **exactly** today's semantics, byte-for-byte: the
  canonical signing payload is unchanged (canonical JSON omits absent keys),
  the resolver runs unchanged, and the attribution written is identical to
  a pre-amendment run. **This is the backward-compatibility guarantee.**
- `actor.type` is a closed enum, initially `["CUSTOMER_CARE"]`. Any
  unrecognized value **fails closed** — never ignored, never downgraded.
- `actor.actorReference` is **not** a `users` id, **not** a `tenant_pics` id,
  **not** a session/token, and never resolves against either table. It is an
  opaque, bounded (`1..128`) operational reference that is meaningful only
  inside the attesting BM integration.
- Unknown members inside `actor` fail closed once this schema is final
  (no smuggled semantics).
- The actor block is covered by the existing `x-hub-signature-256`
  HMAC-SHA256 signature over the canonical assertion — **BM attests the
  actor with the same per-integration scoped credential that attests the
  context claims**. There is no separate, weaker actor channel.

### 3.2 Integration attestation scope (who is allowed to assert an actor)

`handyman_handoff_integrations` gains an additive actor-capability scope
(nullable / default `NONE` for existing rows; value `CUSTOMER_CARE` grants
the right to assert Customer Care actors).

Enforcement, all server-side:

1. Assertion carries `actor` ⇒ the attesting integration MUST be `ACTIVE`
   **and** capability-matched; otherwise reject (non-enumerating 401) —
   never silently drop the actor block.
2. Assertion without `actor` on any integration ⇒ legacy path unchanged,
   including integrations that hold a capability.
3. Capability is provisioned by operations; it is never derivable from a
   request.

### 3.3 Server-side actor resolution (no client-supplied identity trust)

New pure resolution step, ordered with the existing PART 02 context resolver
(both must succeed before an exchange is issued):

```
structurally valid actor block
  → integration ACTIVE + actor capability match        (server)
  → registry lookup (integration_id, actor_reference)   (server, ACTIVE only)
  → canonical { careActorId, integrationId, actorType } (server-derived)
```

- New registry store `handyman_handoff_care_actors`: rows are provisioned
  **operationally** (server-side), never created by an assertion. An
  assertion can only *name* a pre-existing, active, integration-scoped actor.
- Unknown / inactive / foreign-integration / malformed actor ⇒ **fail
  closed** with the existing non-enumerating assertion failure
  (`HANDYMAN_HANDOFF_ASSERTION_INVALID`, 401). No new enumerable error
  surface is introduced; no existence or registry leakage.
- The actor block has **no** effect on context resolution. Represented
  tenant/customer (`tenantCompanyId`, optional `tenantPicId`) and
  building/unit (`buildingId`, optional `spaceId`) are resolved exactly per
  frozen PART 02 rules — company ACTIVE, building ACTIVE + client-matched,
  ACTIVE effective tenant-building context, PIC belonging to the company,
  space in building + ACTIVE tenant-space relationship. **An actor cannot
  widen, skip, or substitute any of these checks.**

### 3.4 One-time exchange (preserved, extended additively)

- The exchange remains the **only** credential issued by the handoff:
  opaque high-entropy token returned once, **SHA-256 hash-only at rest**,
  short TTL (default 120s), strictly single-use via the existing race-safe
  `ACTIVE → USED` conditional transition, replay record append-only.
- **No change** to token generation, TTL, hashing, consumption, or atomic
  binding semantics. The actor gets **no** token, **no** session, and
  **no** extended or multi-use exchange.
- Exchange snapshot gains nullable, server-derived actor fields
  (`actor_type`, `care_actor_id`, attested `actor_reference`); legacy rows
  remain valid with NULL actor fields.

### 3.5 Immutable attribution (actor provenance recorded, legacy unchanged)

`handyman_channel_attributions` gains nullable, additive actor columns
(e.g. `actor_type`, `care_actor_id` FK → registry, `actor_reference`), with
constraints enforcing coherence (care fields only when
`actor_type = 'CUSTOMER_CARE'`; care fields can never hold a `users` or
`tenant_pics` id). The table stays **append-only** (no UPDATE/DELETE
surface; DB trigger preserved).

Semantics by flow:

| Flow | `created_by_user_id` | actor columns |
|---|---|---|
| Legacy (no `actor` block) | **unchanged** — PIC linked user when one exists, else `null` | NULL (pre-amendment rows and behavior preserved) |
| Customer Care (`actor.type = CUSTOMER_CARE`) | **NOT** populated from the represented PIC — no false attribution; stays `null` unless a future separately-governed local identity policy exists | server-resolved `care_actor_id` + attested reference + type |

Origin channel is unchanged: **always `BM_SUPER_APP`**; the actor is not a
channel, and the channel is not the actor.

### 3.6 Rollout safety — no silent downgrade

The HMAC covers the received payload, so a **mixed-version fleet** could
otherwise accept an actor-bearing assertion on a node that does not yet
understand actors and silently treat it as a legacy tenant-origin handoff.
Amendment rule: **Customer Care traffic must use a dedicated integration
code** (e.g. `BM_SUPER_APP_CARE`) that exists only once the care-capable
release and registry rows are deployed. A legacy node has no such
integration registered ⇒ rejects (401, fail closed) instead of downgrading.
Rollout order gate: migration → registry/capability provisioning →
release → BM begins signing care assertions. Client-side version checks are
**not** an acceptable substitute (client trust is forbidden).

### 3.7 Compatibility matrix

| Scenario | Result |
|---|---|
| Existing BM assertion, no `actor` | Identical behavior/attribution to pre-amendment |
| Care assertion, care integration, capable release | Actor attested → resolved → snapshotted → attributed |
| Care assertion on a tenant-only integration | Rejected, fail closed (no downgrade) |
| Care assertion on a legacy/unknown node | Rejected via unknown integration, fail closed |
| Pre-amendment exchange rows / attributions | Unaffected (new columns NULL) |
| Existing PART 01–06 tests | Remain the legacy regression baseline, unmodified |

## 4. Security model

Preserved invariants (unchanged, re-affirmed):

- origin authentication ≠ business authorization
- customer ≠ building authorization; building ≠ unit authorization
- channel attribution ≠ BM financial entitlement; ≠ SaaS entitlement

New invariants introduced by this amendment:

1. **Actor ≠ tenant**: the Customer Care actor is never the Tenant PIC,
   never the PIC's linked local user, and never impersonates the customer.
2. **Attested, not asserted**: actor identity is valid only when covered by
   the integration HMAC **and** the integration holds the actor capability
   **and** the reference resolves to an ACTIVE registry row for that
   integration. No request-supplied identity is trusted.
3. **No session/user fabrication**: the actor receives no local `users`
   row, no `user_sessions` row, no RBAC grant, no entitlement. The exchange
   is the only credential and it is single-use.
4. **No privilege by actor**: actor resolution grants no building/unit
   authorization and cannot widen the represented context.
5. **Fail closed / non-enumerating**: any actor failure collapses into the
   single existing 401; no registry, existence, or capability leakage.
6. **Secret & token hygiene unchanged**: secrets only in
   `HANDYMAN_HANDOFF_SECRET_<CODE>` env config; raw signature and raw
   exchange token never logged/echoed/persisted.
7. **Log minimization**: operational logs may name the integration
   id/code and, when resolved, the `care_actor_id` UUID — never the raw
   actor reference alongside secrets, never the assertion signature or
   exchange token.
8. **Append-only provenance**: actor provenance, once bound, is immutable
   with the attribution; no correction surface is designed (separate future
   governance only).

## 5. Persistence requirements (additive only)

| Store | Change | Notes |
|---|---|---|
| `handyman_handoff_care_actors` | **NEW** | `(integration_id, actor_reference)` unique, status ACTIVE/INACTIVE, operational provisioning only, no session/user linkage |
| `handyman_handoff_integrations` | ADD nullable/default `NONE` actor-capability scope | existing rows keep legacy privileges (none) |
| `handyman_handoff_exchanges` | ADD nullable `actor_type`, `care_actor_id`, `actor_reference` | legacy rows NULL; no change to token/status/expiry columns |
| `handyman_channel_attributions` | ADD nullable `actor_type`, `care_actor_id`, `actor_reference` | append-only preserved; coherence constraints; no backfill |

No destructive change, no rewrite of 0374/0375, no backfill, prospective only.

## 6. API / OpenAPI requirements (additive only)

- `HandoffAssertion`: optional `actor` object (closed `type` enum, bounded
  opaque `actorReference`) — documented as BM-attested and untrusted until
  server-resolved; `additionalProperties` behavior stays as-is.
- `HandoffContextSnapshot` / `HandoffExchangeAccepted`: additive nullable
  `actor` object exposing only server-resolved values (never raw claims).
- `HandymanChannelAttribution`: additive nullable actor fields, documented
  read-only and immutable.
- **No new endpoints, no new mount, no `/webhooks` exposure** (frozen D3
  unchanged). Existing paths, envelopes, error codes and `X-Request-ID`
  behavior are untouched.

## 7. Audit / idempotency

- Operational events (PART-gated implementation): actor attested+resolved,
  actor rejected, actor provenance bound — same transaction as the state
  change, requestId-correlated, SENSITIVE_KEYS-scrubbed.
- Replay/idempotency semantics preserved exactly: the append-only assertion
  replay record remains keyed `(integration_id, assertion_id)`; care uses
  its own integration, so legacy replay domains are untouched.
- No historical backfill/retroactive actor attribution.

## 8. Decisions FROZEN by this amendment

- **D4 (FROZEN) — ACTOR MODEL.** A distinct actor class `CUSTOMER_CARE`
  exists for BM Super App operators acting on behalf of a tenant. The
  actor is permanently distinct from the tenant/customer and from any
  local user; the actor is never a PIC and never a `users` row.
- **D5 (FROZEN) — ATTESTATION.** Actor identity must be (a) covered by the
  per-integration HMAC signature, (b) asserted only by an integration
  holding the actor capability, and (c) resolved server-side against an
  ACTIVE, integration-scoped registry row. Otherwise fail closed, with no
  silent downgrade to legacy semantics. No client-supplied identity is
  ever trusted.
- **D6 (FROZEN) — REPRESENTATION.** The represented tenant/customer and
  building/unit context are resolved by the unchanged PART 02 rules and
  are never derived from actor claims. The actor cannot widen context.
- **D7 (FROZEN) — SESSION & EXCHANGE.** No standard user session and no
  local user is ever created for the actor; the existing short-lived,
  hash-only, single-use exchange remains the only credential and keeps
  its replay-safe semantics; the exchange snapshot carries nullable
  server-derived actor provenance.
- **D8 (FROZEN) — ATTRIBUTION & COMPATIBILITY.** Attribution records
  server-resolved actor provenance immutably and must not reuse the
  represented customer's user as the acting user. Absent `actor` means
  byte-identical legacy behavior; changes are additive-only; Customer Care
  traffic uses a dedicated integration code so mixed-version fleets fail
  closed instead of downgrading.

Changes to D4–D8 require an explicit new decision record.

## 9. Implementation PARTs (recommendation — NOT started)

Continues CR-HM-01 numbering; no PART 01–06 artifact is modified.

| PART | Scope | Depends on |
|---|---|---|
| **PART 07** | Customer Care actor domain & persistence foundation: `handyman_handoff_care_actors` + integration actor-capability scope (additive migration, types, repository, operational provisioning path). No HTTP. | — |
| **PART 08** | Attested actor resolver: structural validation of the signed `actor` block, capability + registry resolution, non-enumerating failures; pure application service; no side effects. | 07 |
| **PART 09** | Runtime attestation integration: optional `actor` on the assertion, capability enforcement, downgrade protection, exchange snapshot extension; token/TTL/single-use/replay untouched. | 08 |
| **PART 10** | Attribution actor binding: immutable actor provenance from the consumed snapshot; `created_by_user_id` never borrowed from the represented PIC; legacy path unchanged. | 09 |
| **PART 11** | Contract exposure: additive OpenAPI extension for the three surfaces in §6; no new endpoints/mounts. | 10 |
| **PART 12** | Focused integration validation: legacy parity (no-actor byte-identical), care flow end-to-end, capability/downgrade fail-closed, replay + single-use, no session/user fabrication, actor/tenant distinctness, attribution immutability, firewall (no entitlement) — exit-gate evidence. | 11 |

Dependency shape: 07 → 08 → 09 → 10 → 11 → 12 (08 may land with 07).
Each PART remains within the CR-HM-01 governance envelope and the frozen
D1–D8 decisions.

## 10. Explicit non-goals

- No Customer Care actor directory management API, no actor self-registration,
  no actor login, no local identity provisioning.
- No actor type beyond `CUSTOMER_CARE` (additions require a new decision
  record).
- No change to service-request creation (CR-HM-02 remains the consumer of
  the attribution contract, unchanged).
- No multi-tenant/multi-building "care scope" grant — context stays
  per-assertion.
- No privileged attribution correction mechanism.
- No `IntakeChannel` repurposing; channel remains `BM_SUPER_APP`.
- No `/webhooks` exposure.

## 11. Amendment integrity statement

This record is **governance/design only**. It changes no runtime code, no
migration, no OpenAPI document, and no test. It records the gap, the
backward-compatible contract amendment, the security model, frozen
decisions D4–D8, and the implementation PART decomposition for CR-HM-01
PARTs 07–12.

**AMENDMENT 01 RECORDED — CR-HM-01 remains COMPLETE for PARTs 01–06; PARTs
07–12 NOT started.**
