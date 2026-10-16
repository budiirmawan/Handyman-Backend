# CR-HM-TENANT-ACTOR-01 — Authority audit and Frontend handoff

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

A quotation or variation customer decision is allowed only when all of the following are true at decision time:

1. the authenticated session User passes the existing route permission and exact-Building guards;
2. the decision target resolves server-side to one Handyman Request under the same Client, Tenant Company and Building;
3. that request has an explicit `tenant_pic_id`;
4. the referenced PIC belongs to that Tenant Company, is ACTIVE, and its `user_id` equals the authenticated User;
5. the Tenant Company is ACTIVE and belongs to the request Client;
6. when the request identifies a Space/Unit, an ACTIVE and currently effective relationship exists for the exact Tenant Company + Building + Space;
7. existing current-version, expiry, transaction locking, optimistic concurrency, uniqueness and idempotency rules pass.

Building membership alone never satisfies steps 2–6. Generic `tenant_company.manage` never substitutes for them. There is no staff/Customer Care/admin impersonation fallback.

## Policy decision / unsupported delegation

The current schema has no decision-purpose delegation grant with grantor, delegate User, request/unit scope, validity and revocation. Therefore delegated decisions fail closed. Adding delegation requires a separate approved business policy and data model; this CR does not infer delegation from roles, Building membership, Tenant Company management permission, creator/reporter provenance, primary-PIC status, email or phone.

A request with no explicit PIC is not customer-decidable. It must be corrected through an approved request/PIC binding workflow; Backend does not fabricate an actor.

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

## BAST boundary

This CR does not authorize or implement Tenant BAST signing. Existing BAST sign-off remains blocked from being represented as genuine tenant consent until a separately approved signature identity, intent, evidence, anti-replay and verification contract is implemented.
