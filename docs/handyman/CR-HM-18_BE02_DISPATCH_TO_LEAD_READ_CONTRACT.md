# CR-HM-18 BE02 — Dispatch → Lead Read Contract

**Status: FROZEN — GOVERNANCE / OPENAPI CONTRACT ONLY.** Prerequisite: CR-HM-18 BE01 is committed as `5b73c71f3c5b9adc0385bee3e41fa7120aeae4a6`. The assigned branch and remote matched that HEAD and the tracked tree was clean at BE02 entry.

**No runtime routes, services, role/permission mappings, migrations, or tests are authorized or changed by BE02.** The paired `CR-HM-18_BE02_LEAD_READ_OPENAPI.yaml` is a frozen, contract-only OpenAPI document. It is not merged into the published `docs/api/openapi.yaml` while these paths are not registered; that file's existing rule is to document registered runtime endpoints only.

## DISPATCH

Freeze the operational hand-off as:

```text
Customer Care
  → Backend (authoritative request / approved Execution Scope)
  → Dispatch Queue (Operations Portal dispatch view)
  → Dispatcher coordinates Provider / Lead / Crew selection
  → existing CR-HM-04 assignment or reassignment is recorded in Backend
  → current assigned Lead reads that scope in Lead Mobile
```

- Customer Care submits the service request through its existing Backend boundary. It does not select or assign a worker, Lead, crew, or provider.
- Backend owns the request, approved Execution Scope, and the canonical assignment record. “Dispatch Queue” is a workflow/view label in this flow; BE02 defines no queue endpoint, queue table, claim command, or new dispatch lifecycle.
- The Dispatcher coordinates dispatch. An assignment is visible to Lead Mobile only after the existing Backend assignment authority has recorded a current ACTIVE assignment to an eligible crew with a valid current Lead.
- The Lead Mobile read surface exposes only current Backend-recorded assignments for which the authenticated user is the resolved current Lead. A Lead cannot browse the queue, list unassigned scopes, claim work, or self-assign.

## ADMIN_BOUNDARY

- **Admin** and **Dispatcher** are separate, independently granted capabilities in the same Operations Portal. One user may explicitly hold both; co-location in one portal does not merge their authority.
- Dispatcher capability does not imply, inherit, or satisfy Admin capability or any Admin permission. Admin capability likewise does not implicitly grant Dispatcher capability. UI navigation/visibility is not authorization.
- BE02 creates no Admin route, Dispatcher queue route, role, permission, or permission mapping. The two Lead GETs below do not depend on either portal capability; they use the field Lead identity and scope-binding gate in **AUTH**.
- Assignment/reassignment remains under the existing CR-HM-04 provider-authored authority and its existing Backend authorization. A Dispatcher label by itself does not grant that write authority. If a Dispatcher-only account must author assignment directly, that capability mapping is unresolved and requires separate governance; BE02 does not broaden `tenant_company.manage` or convert Dispatcher into Admin.

## CONTRACT

**Only these two Lead read paths are frozen:**

1. `GET /handyman/lead/assigned-scopes` — returns a bounded/paged list of the caller’s current assigned scopes only. Optional pagination is `page` (default 1) and `pageSize` (default 50, maximum 100). No search, status, Client, building, tenant, provider, crew, worker, Lead, or request filters are accepted. Ordering is `assignedAt DESC`, then `executionScopeId ASC`; the pagination total counts only scopes visible to this Lead.
2. `GET /handyman/lead/assigned-scopes/:executionScopeId` — returns field-safe detail for one current assigned scope, including its current readiness facts. The handler rechecks current assignment and Lead authority on every call. It does not accept a request ID or other caller-provided lineage.

Both are read-only Bearer-session operations. An empty assignment set is a successful empty list. An exact scope that is missing or not currently assigned to this Lead is a bounded not-found result; lack of Client access is denied. There is no `POST`, `claim`, unassigned browse, separate readiness path, history path, or Admin/Dispatcher route in BE02. The complete schemas and response shapes are in the paired OpenAPI contract.

## AUTH

For either GET, derive actor identity solely from the authenticated Backend session (`req.auth.userId`). Authorization requires **all** of:

1. the scope has a current ACTIVE CR-HM-04 assignment;
2. the assignment resolves through its crew to the current CR-HM-04 Lead designation, ACTIVE membership, ACTIVE worker context, and workforce profile with a non-null `userId`;
3. the resolved current Lead `userId` exactly equals the authenticated session user; and
4. `contextAccessService.canAccessClient(authenticatedUserId, scope.clientId)` succeeds for the server-resolved scope Client.

The Lead chain is dynamically resolved; caller-supplied IDs, stale list entries, role labels, or portal capability claims cannot substitute for it. Do **not** require or infer `tenant_company.read` for either Lead GET. Do not accept caller-supplied `clientId`, tenant, provider, crew, worker, Lead, or request identity as authorization input. Reauthorize detail after every reassignment or Lead change.

## DTO

The OpenAPI schema freezes only the following field-safe projection:

- **List card:** `executionScopeId`, current `assignmentId`, `assignmentStatus=ACTIVE`, `scopeStatus=AUTHORIZED`, `assignedAt`, Backend catalogue `serviceLabel`, assigned-scope location labels, and an optional `preferredWindow` summary.
- **Detail:** the same current binding and field-safe service/location facts, approved work items limited to `lineType`, sanitized operational `description`, `quantity`, and `unitLabel`; plus the current readiness view:
  - scheduling: active preferred-window start/end and building-derived timezone;
  - unit access: active access-window start/end;
  - Handyman permit readiness: active Handyman permit type and validity window.
- A missing current readiness fact is `null` (or an empty permit array). No readiness history is returned. `preferredWindow` is a customer preference only; it is never named or presented as a confirmed appointment or scheduled execution window.
- Excluded: prices, reference/final quoted amounts, totals, currency, payment/settlement data, quotation identifiers or commercial notes, customer/tenant/PIC names or contact data, raw customer request text, Care-actor/attribution provenance, free-text authorization notes, evidence or private storage references, provider/crew membership details, Lead user/profile identifiers, and unrelated internal authorship fields.
- Location/service/work descriptions must be field-safe and scoped to the assigned work. No assignment or readiness mutation is permitted by the DTO or either GET.

## REASSIGNMENT

CR-HM-04 remains the sole assignment/reassignment and history authority. The existing provider-authored assignment and atomic reassignment paths, validation, Client isolation, permissions, and append-only/supersession semantics are unchanged. These Lead GETs neither select nor write an assignment.

After reassignment, only the new current assignment’s valid current Lead can discover/read the scope, subject to `canAccessClient`. A former Lead loses access on the next request; changing the crew’s current Lead is also reflected dynamically. Superseded assignment history is not exposed through these Lead paths.

## BLOCKERS

- **Dispatcher write-authority mapping is not solved by BE02.** Existing assignment/reassignment remains under its current CR-HM-04 provider-authored authorization (including its existing `tenant_company.manage` route gate). Dispatcher-only does not inherit Admin or that permission. If a Dispatcher must call assignment directly, define a narrow, separate authority in a later approved change; otherwise an already-authorized provider actor records the assignment. This does not block freezing the two Lead reads.
- There is no dispatch-queue HTTP contract in BE02. Any Backend queue/browse/claim surface needs separate scope and must not be exposed to Lead Mobile as unassigned work.
- Lead accounts must satisfy the existing active Building-assignment context needed for `canAccessClient`; otherwise the field read is denied even if a stale client/UI label says “Lead.”
- CR-HM-05 currently supplies a preferred window, not a confirmed schedule. A confirmed appointment requires a separately authorized schedule-binding authority.
- The paired OpenAPI file is intentionally contract-only and not published in `docs/api/openapi.yaml` until the routes are registered, preserving that document's registered-route rule.

**BE02 exit: two read contracts frozen; role boundaries and existing assignment authority preserved; no runtime coding, tests, or build. STOP.**
