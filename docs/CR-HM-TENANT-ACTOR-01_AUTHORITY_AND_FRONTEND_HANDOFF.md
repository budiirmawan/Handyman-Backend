# CR-HM-TENANT-ACTOR-01 — Authority audit and Frontend handoff

> **Commercial bridge PART01 addendum (2026-10-25):** the personal-PIC rules below remain unchanged for direct decisions. A separate default-BLOCKED BM Care-recording channel can feed the same quotation/BAST transactions after independent customer verification; it never grants Care customer authority or requires a customer account. Variation/rework/other personal decision rules are not expanded. See [bridge contract](handyman/CR-HM-COMMERCIAL-DECISION-BRIDGE-01_PART-01.md).

## Existing authority discovered

* Authentication resolves a server-side session to `req.auth.userId`; decision actors are never accepted from request bodies.
* RBAC requires `tenant_company.manage` on both quotation mutations and the quotation decision route. Building access additionally requires an active assignment to the exact request Building. These are outer guards, not proof of customer authority.
* `handyman_service_requests` is the immutable request lineage snapshot: Client, Tenant Company, optional Tenant PIC, Building and Space come from its channel attribution.
* `tenant_pics.user_id` binds a PIC to an authenticated User; PIC and Tenant Company have ACTIVE/INACTIVE revocation states.
* `tenant_space_relationships` records status and effective dates for exact Company + Building + Space occupancy.
* Quotation decisions already lock the exact version, require current `ISSUED` state and unexpired validity, enforce one immutable decision per version, fingerprint idempotent requests, create an approved execution scope atomically, and record actor/audit provenance.
* Variation decisions already lock the variation, enforce optimistic `expectedVersion`, bind the revised quotation version, enforce idempotency, and write actor/event provenance.
* Before this CR, quotation decisions stopped at RBAC + Building membership. An operator, Customer Care user, or unrelated tenant with those guards could be recorded as the deciding user. Variation had a request-PIC check, but it did not consistently validate active Company/current exact-space occupancy.

## Authority contract

A quotation, variation, BAST acceptance/rejection, free-rework authorization or chargeable-work customer decision is allowed only when all of the following are true at decision time:

1. the authenticated session User passes the existing route permission and exact-Building guards;
2. the decision target resolves server-side to one Handyman Request under the same Client, Tenant Company and Building;
3. that request has an explicit `tenant_pic_id`;
4. the referenced PIC belongs to that Tenant Company, is ACTIVE, and its `user_id` equals the authenticated ACTIVE User;
5. the Tenant Company is ACTIVE and belongs to the request Client;
6. when the request identifies a Space/Unit, an ACTIVE and currently effective relationship exists for the exact Tenant Company + Building + Space;
7. existing current-version, expiry, optimistic concurrency, uniqueness and idempotency rules pass; the transaction holds share locks on the current PIC and account until the decision/history commit. Governed relinks serialize against this check, including before idempotent replay.

Building membership alone never satisfies steps 2–6. Generic `tenant_company.manage` never substitutes for them. There is no staff/Customer Care/admin impersonation fallback.

## Policy decision / unsupported delegation

The current schema has no decision-purpose delegation grant with grantor, delegate User, request/unit scope, validity and revocation. Therefore delegated decisions fail closed. Adding delegation requires a separate approved business policy and data model; this CR does not infer delegation from roles, Building membership, Tenant Company management permission, creator/reporter provenance, primary-PIC status, email or phone.

A request with no explicit PIC is not customer-decidable. It must be corrected through an approved request/PIC binding workflow; Backend does not fabricate an actor.

## PART 03 — Governed PIC identity maintenance

The request's PIC **reference** is immutable; `tenant_pics.user_id` is a governed mutable identity link. It is not a free contact field. PART 03 fixes the mutable trust-root gap prospectively without adding a role, endpoint, delegation grant or schema migration.

Existing endpoints remain:

* `POST /tenant-companies/{tenantCompanyId}/pics`
* `PATCH /tenant-pics/{id}`

Both still require authenticated `tenant_company.manage` and Client access. Additional identity policy, explicitly approved for PART 03:

| Intent | Authority |
| --- | --- |
| Create unbound contact; edit name/email/phone/title/primary/status with omitted or currently unchanged `userId` | Existing contact maintenance; no additional `user.manage` requirement |
| Initially link or replace an approving User | ACTIVE identity administrator with live `tenant_company.manage` **and** `user.manage`; an existing ACTIVE target, never a new self-binding |
| Clear own current binding | ACTIVE current linked customer with `tenant_company.manage` and required scope; `userId: null` only, not a transfer |
| Clear another User's binding | Identity administrator with the same required scope |
| Assign a target already linked to a different Tenant Company | Denied; existing bindings/history are not automatically rewritten |

For a PIC already designated by requests, **all** their exact Buildings must be accessible to the actor and any replacement, not just a sibling Building in the same Client. Non-terminal exact-space requests need effective Company + Building + Space occupancy. Existing CANCELLED/REFERRED requests and CLOSED scopes do not require historical lease renewal for contact maintenance; all referenced Buildings remain scoped, and decision authority independently checks current occupancy even on replay. For an unreferenced PIC, current effective tenant locations require a shared Building; if no effective locations exist, existing Client-scoped pre-occupancy provisioning remains possible and confers no request/Building rights.

Contact forms should **omit `userId`** unless explicitly changing identity. The comparison uses the freshly locked current PIC, not a stale pre-transaction snapshot: an Operations/Care form resubmitting an old `userId` after a concurrent relink is a forbidden identity change, not a no-op. Editing email/phone never updates the linked login identity.

Successful identity changes atomically record `tenant_pic.identity_link_changed` with server actor/correlation, Company, old/new User ids and authorization basis; audit failure rolls back binding and primary-contact changes. There is no new customer-delegation authority. Identity administration does not itself permit customer approval or staff impersonation. Existing contact, verification, primary-PIC and success-response contracts remain.

After a valid PIC change, old quotation/variation decision actors and immutable events remain the original facts. The old User loses current decision authority. A now-authorized User may receive an existing same-intent idempotent result, but that result retains its original deciding User; replay is not new consent.

For denials retain existing envelopes/codes: `403 PERMISSION_DENIED` for forbidden identity changes/foreign-company targets; `403 BUILDING_ACCESS_DENIED` for actor scope; `400 TENANT_PIC_USER_CLIENT_MISMATCH` for target scope; `404 USER_NOT_FOUND`, `409 TENANT_PIC_USER_ALREADY_LINKED`, and `400 TENANT_COMPANY_INACTIVE` where applicable. See [PART 03 audit](audits/CR-HM-BE-IAM-E2E-AUDIT-01-PART-03.md) for limits and database evidence.

## Exact Frontend handoff

No endpoint or success payload changed.

### Quotation

`POST /handyman/quotation-versions/{quotationVersionId}/decision`

Headers/session:
* authenticated session;
* existing `tenant_company.manage` permission;
* existing exact-Building access.

Body:
```json
{
  "decision": "APPROVE",
  "idempotencyKey": "frontend-generated-stable-key"
}
```

`decision` is exactly `APPROVE` or `REJECT`. Retry the same intent with the same key. Never send actor, Client, company, PIC, Building, Space, version status or timestamps; Backend derives all authority and lineage.

### Variation

`POST /handyman/execution-scopes/{executionScopeId}/variations/{variationId}/tenant-decision`

Body:
```json
{
  "decision": "APPROVED",
  "revisedQuotationVersionId": "uuid-shown-for-this-variation",
  "evidenceReference": "managed-evidence-reference",
  "notes": "optional",
  "idempotencyKey": "frontend-generated-stable-key",
  "expectedVersion": 3
}
```

Send the exact revised quotation version and current variation version returned by Backend. Retry the same intent with the same key.

### Errors relevant to Frontend

* `403 HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN`: session User is not the active exact-request PIC, the Company/PIC was revoked, or exact-space occupancy is absent/not yet effective/expired. Do not offer staff impersonation; ask the tenant administrator to correct authoritative bindings.
* Existing Building/RBAC 403 errors remain unchanged.
* Existing quotation stale/non-current/expired state errors remain `HANDYMAN_QUOTATION_INVALID_TRANSITION` (409).
* Existing quotation replay conflict remains `HANDYMAN_QUOTATION_DECISION_CONFLICT` (409).
* Existing variation optimistic-lock/replay/state errors remain unchanged.

## PART 04 — BAST and related customer decisions

The separately approved PART 04 contract is **personal authenticated PIC electronic consent, not a certified digital signature**. Existing BAST `/accept`, `/reject` and `/sign-off` all reuse the current exact request-PIC/Company/Building/occupancy authority above. `/sign-off` is the customer decision alias, not provider signing. Backend derives and verifies the canonical SHA-256 of the authoritative issued v2 BAST, original approved quotation version, QC and optional finalized/byte-verified evidence. A digest alone never establishes identity; Operations/Care/Manager/Owner or generic manage cannot attest on behalf of the customer.

Existing free-rework `/authorize` and chargeable-work `/accept`/`/reject` now enforce the same personal customer guard before replay/mutation. Their separate provider lifecycles/payment-trigger transactions remain. Unlike the pre-existing quotation/variation historical-result replay behavior described above, PART 04 BAST/rework/chargeable replay requires the **original actor**: a replacement PIC cannot adopt the old actor's receipt. Old immutable history remains the original actor's fact.

See [the exact canonical protocol and Frontend rollout contract](handyman/CR-HM-BAST-CUSTOMER-CONSENT-01_CONTRACT.md). No new endpoint/migration/public payload field was added. Opaque old digests must be replaced by correct canonical confirmation in clients, never backend backfill. Legacy staff-only accepted rows are not retrospectively certified; qualified read/close/warranty gates fail closed. No delegation or certified signature verification is invented. Production/live identity and legacy reconciliation gates remain open.
