# CR-HM-CUSTOMER-CONTEXT-01 — PART 01 DECISION FREEZE

**Status: FROZEN (governance only), 2026-10-07.** Baseline HEAD:
`852ec82656eb3215527ba6efaef150f10a1bcabb`; assigned branch:
`arena/2129140a-handyman-backend`; tracked tree clean at start.
No schema, API, runtime, migration, OpenAPI, or test change in this PART.

This decision governs subsequent customer-context implementation. It builds on
`CR-HM-01_AMENDMENT_01_CUSTOMER_CARE_ACTOR_HANDOFF.md` (D4–D8), the existing
Handyman handoff/attribution/request chain, and the BE-02/BE-14 location and
tenant masters. It does not itself make the current bearer-user request-create
route usable by an attested Customer Care actor.

## Frozen decisions

**C1 — Unit authority.** Handyman's unit identifier is the existing `spaceId`
(`spaces` under room/area/floor/building). There is **no new Unit master** and
no competing unit identity. A unit reference must resolve through the physical
space-to-building chain; it is optional only where the existing Handyman
context contract permits an absent `spaceId`.

**C2 — Occupancy authority.** The effective `tenant_space_relationships`
and `tenant_building_contexts` are the operational authority for a represented
tenant's space/building context. Evaluate ACTIVE status and effective windows
at the relevant authorization decision, and verify the space belongs to the
building and the building belongs to the represented tenant's Client.
These relationships are **not** a lease, title, commercial tenancy contract,
or permission to infer one. Do not create a parallel occupancy truth from an
assertion, attribution, or request snapshot.

**C3 — Customer Care property scope.** An attested Customer Care actor requires
an **explicit care-actor↔property grant** for the property in which it acts.
The grant is separate from both the BM integration's actor-attestation
capability and the tenant's occupancy. Its active/applicable scope must be
checked server-side against the **derived property** of the resolved building
(`buildings.propertyId`), not against a caller-supplied property identifier or
merely a shared Client. A property grant alone does not identify a represented
tenant, authorize a different property, or replace tenant-building/unit checks.
A grant spanning a property's buildings does not grant every building or
customer outside that property.

**C4 — Attested request-create actor.** Customer Care request creation must
use the authenticated, attested care-actor authority carried by the BM
handoff/exchange and its trusted binding lineage. It must be authorized for
the represented context and derived property before a request is accepted;
caller-supplied actor/customer/property/unit values cannot substitute for
that chain. Never create a local `users` row or session for the care actor,
borrow `tenant_pics.userId`, or record the represented customer as the acting
user. Preserve the existing immutable attribution and one-request-per-
attribution boundary; any future create transport/credential mechanism must
be governed separately before implementation. An exchange is single-use: this
decision does **not** authorize its reuse or treating an attribution ID alone
as an acting-actor credential.

**C5 — Separate dimensions.** Keep each authority distinct:

| Dimension | Existing anchor / decision |
|---|---|
| Acting operator | Attested `CUSTOMER_CARE` registry identity, separate from a User/PIC |
| Represented customer | `tenantCompanyId` and optional `tenantPicId`, resolved server-side |
| Property | Derived from the authoritative building; care-actor grant checked against it |
| Unit | Optional existing `spaceId`, resolved through the building chain |
| Occupancy | Effective tenant-space and tenant-building relationships; not a lease |
| Channel | Immutable `BM_SUPER_APP` origin/reference; provenance, not actor or authorization |

Neither channel attribution, Client membership, property scope, occupancy,
nor actor identity may silently stand in for any other dimension. Context
snapshots preserve provenance; they do not become independent permissions.

**C6 — Turnover isolation.** At tenancy turnover, a new occupant must never
see the former tenant's private customer context, requests, evidence, or
history simply because the property, building, or space matches. Current
care/customer access must verify the represented tenant and applicable
occupancy as well as the actor's property grant; no cross-tenant fallback or
`spaceId`-only access. Preserve historical request/attribution facts without
reassigning them to the new tenant. Any exceptional access to former-tenant
private history requires a separately governed authority; this freeze does
not grant it.

**C7 — Legacy compatibility.** A handoff with no care-actor block keeps its
existing no-actor validation, single-use exchange, attribution, and request
semantics. Do not require a Customer Care property grant for that legacy
path, fabricate a care actor for it, or silently downgrade an actor-bearing
assertion to legacy on failed attestation or scope validation. D4–D8
attestation, no-local-session, immutability, and no-borrow invariants remain.

## Exact supersession boundary

This decision **supersedes only** the prior exclusion in
`CR-HM-01_AMENDMENT_01_CUSTOMER_CARE_ACTOR_HANDOFF.md` §10:
“**No multi-tenant/multi-building ‘care scope’ grant — context stays
per-assertion.**” It replaces that exclusion **only to permit an explicit,
server-enforced care-actor↔property grant** across that property's buildings.
Representation still stays per assertion, with tenant/building/space validated
independently. It does not itself authorize bulk multi-tenant access.

All other CR-HM-01 Amendment 01 decisions and non-goals remain in force,
including D4–D8, no care-actor login/local user/session, no PIC impersonation,
no new actor type, no privileged attribution correction, no `IntakeChannel`
repurposing, and no `/webhooks` exposure. Its earlier “no change to
service-request creation” describes the scope of *that amendment*; this
separate CR freezes a future Customer Care creation authority but implements
no request-create change in PART 01. Existing FM/SaaS and Handyman lifecycle
boundaries are unchanged.

## Implementation gate (later PARTs only)

Before implementation, define the grant lifecycle and fail-closed lookup,
the exact point where the derived-property check is applied to an attested
handoff, how the single-use attested lineage authorizes request creation
without a local-user session, and read isolation for tenancy turnover.
Only then may separately scoped schema, runtime, HTTP/OpenAPI, and validation
PARTs proceed. No such implementation is included here.
