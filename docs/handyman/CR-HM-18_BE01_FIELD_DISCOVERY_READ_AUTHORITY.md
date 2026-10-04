# CR-HM-18 BE01 — Field Discovery / Read Authority

**Status: MAPPING COMPLETE — GOVERNANCE ONLY.** This is a source/API/authentication map and a minimum read-contract proposal for the Mobile Lead Worker. It does not authorize runtime changes. No migrations, routes, controllers, services, OpenAPI, tests, or builds are included in BE01.

**Boundary:** assigned jobs (the existing Handyman Execution Scopes), their existing readiness facts, and field-safe job/scope detail only. This is not a Customer Care transport change, a provider/crew assignment change, or a new work-order/job lifecycle.

## BASELINE

- Assigned branch: `arena/01a10470-handyman-backend`.
- At inspection start, `HEAD` and `origin/main` both resolved to `9ec88f0fa8b51b11a708b7d3b042c26853dd5a67`.
- The working tree and index were clean at the baseline gate. The BE01 report is the only intended repository change.
- Source and governance were inspected read-only. No runtime code was changed; no tests or builds were run.

## EXISTING

| Need / authority | Existing backend source and surface | Current behavior relevant to BE01 |
|---|---|---|
| **Assignment / Lead authority** | CR-HM-04 `handyman_execution_scope_assignments`, provider/crew/Lead tables, `src/modules/handyman-scope-assignments/handyman-scope-assignment.service.ts` | Provider authors assignment to one CR-HM-06 scope. The current Lead is resolved dynamically through ACTIVE assignment → crew → current Lead row → ACTIVE membership → ACTIVE worker context → workforce profile `userId`. No Lead snapshot is stored on the assignment. |
| **Assignment read** | `GET /handyman/execution-scopes/:executionScopeId/assignment` in `handyman-scope-assignments-api` | Exact read guarded by authentication + `tenant_company.read`; service checks `canAccessClient`. The response includes the dynamically resolved Lead identifiers, but the handler does not require that the authenticated user is that Lead. There is no assigned-scope collection endpoint. The repository has a helper to list by an already-known `(clientId, crewId)`, not a caller-to-Lead discovery service. |
| **Readiness authority** | CR-HM-05 scheduling, unit-access, and Handyman permit readiness in `handyman-scheduling`; `handyman-readiness-api` | Existing exact GETs are keyed by `handymanRequestId`, and history GETs are also exposed. They use authentication + `tenant_company.read`; service reads enforce Client access, not assignment-to-current-Lead access. Services return current readiness plus history. Readiness remains request-owned; the execution scope carries the request lineage needed to bind it server-side. |
| **Execution Scope authority / detail** | CR-HM-06 `handyman_execution_scopes`; `handyman-quotations-api` and `handyman-quotations/handyman-execution-scope.service.ts` | The existing scope GET is `GET /handyman/quotation-versions/:quotationVersionId/execution-scope`, not a scope-ID/Lead read. It is guarded by `tenant_company.read` + Client access and returns the public scope DTO. There is no field-specific scope-detail endpoint. The scope DTO is primarily lineage and location snapshot data, not a field-safe projection of approved work details. |
| **Approved work detail** | `GET /handyman/quotation-versions/:quotationVersionId/lines` and `/totals` | Existing quotation reads use `tenant_company.read` + Client access. Public quotation lines include commercial amounts, currency, source item and author fields; they are not a least-privilege Lead DTO. A Lead detail projection must derive the approved version through the scope and whitelist only field-needed work facts. |
| **Customer Care** | CR-HM-17 request list/detail and other Customer Care read transports | Customer Care reads use `tenant_company.read` + server-side `canAccessClient`, under the Customer Care boundary. Request projections can include attribution/Care-actor provenance and a scope pointer. They are not Mobile Lead authorization or a substitute for assignment filtering. Existing Customer Care routes and permissions remain unchanged. |

The canonical job target for this contract is `executionScopeId`. “Job” is only a Mobile UX label; BE01 does not introduce a generic Job, Task, FM Work Order, or parallel lifecycle.

### Evidence pointers

- Route mounting: `src/routes/index.ts:804-826`.
- Assignment endpoints and generic read permission: `src/modules/handyman-scope-assignments-api/handyman-scope-assignments-api.routes.ts:10-39`.
- Assignment read handler (including Lead projection): `src/modules/handyman-scope-assignments-api/handyman-scope-assignments-api.controller.ts:57-90`.
- Current assignment Client check and resolver: `src/modules/handyman-scope-assignments/handyman-scope-assignment.service.ts:67-74, 100-175, 324-379`; crew-list repository helper: `handyman-scope-assignment.repository.ts:149-163`.
- Readiness GETs and permission boundary: `src/modules/handyman-readiness-api/handyman-readiness-api.routes.ts:19-43, 64-80`; current/history result shape and Client check: `src/modules/handyman-scheduling/handyman-scheduling.service.ts:281-338` (unit access and permit services follow the same request-keyed pattern).
- Scope read path and permission boundary: `src/modules/handyman-quotations-api/handyman-quotations-api.routes.ts:37-48, 103`; scope-by-approved-version Client check: `src/modules/handyman-quotations/handyman-execution-scope.service.ts:159-175`; immutable scope fields: `src/modules/handyman-quotations/handyman-execution-scope.types.ts:17-47`.
- Approved quotation-line response fields (including quoted amounts, currency, source item, author): `src/modules/handyman-quotations/handyman-quotation-line.service.ts:55-74`.
- Customer Care separation: `docs/handyman/CR-HM-17_CUSTOMER_CARE_TRANSPORT_GAP_GOVERNANCE.md:24-39`; request list/detail routes are in `src/modules/handyman-api/handyman-api.routes.ts:65-88`.
- Existing field-actor convention: work-session routes authenticate without a tenant permission for field commands, and the service requires both Client access and `resolution.leadUserId === actorUserId` (`src/modules/handyman-work-sessions-api/handyman-work-sessions-api.routes.ts:30-35, 44-61`; `src/modules/handyman-work-sessions/handyman-work-session.service.ts:155-182`).
- Authentication resolves the local session user into `req.auth.userId` (`src/modules/auth/authentication.middleware.ts:14-34`). `canAccessClient` derives access only through the user’s active Building assignments (`src/modules/context-access/context-access.service.ts:59-65` and `src/modules/building-assignments/building-assignment.service.ts:87-131`).

## AUTH_GAP

1. **Discovery gap:** there is no HTTP/service operation that discovers active scope assignments for the authenticated current Lead. The existing repository helper requires a known crew and Client; a mobile caller must not supply either as authority.
2. **Assignment-read gap:** the existing exact assignment GET is Client/RBAC-scoped, not Lead-scoped. Resolving and returning the Lead’s ID is not equivalent to asserting that `req.auth.userId` equals the current Lead’s user ID.
3. **Readiness gap:** request-keyed readiness GETs authorize a user with Client access, but do not establish that the request belongs to a scope currently assigned to that user as Lead. They also expose history that is not required for minimum field discovery.
4. **Scope/detail gap:** there is no GET by `executionScopeId` that first proves current assignment to the authenticated Lead and then returns a field-safe scope projection. The existing scope-by-quotation-version and quotation-line GETs have a different lookup key and a general `tenant_company.read` boundary.
5. **Projection gap:** using existing public Customer Care/request or quotation DTOs directly would over-read Care attribution/customer context or quotation/commercial data. The assignment, scope, readiness, and approved-version authorities exist; the missing capability is an actor-bound discovery/read projection, not new lifecycle authority.

These are contract gaps for the Mobile Lead reader, not defects in the existing Customer Care APIs or provider-authored assignment model.

## MIN_CONTRACT

### Proposed read surface (no implementation in BE01)

1. `GET /handyman/lead/assigned-scopes`
   - Discover only scopes whose current assignment resolves to the authenticated user as the current valid Crew Lead.
   - Return a bounded/paged collection of minimal cards: `executionScopeId`, current `assignmentId` and `assignedAt`, the existing scope status, and only a field-safe summary/location needed to identify the assigned work. A current readiness badge may be included if useful to the list; it must use the same authoritative readiness values as detail, not inferred execution statuses.
   - Filters are server-authoritative. At most bounded pagination inputs are caller-controlled; no caller-selected Client, tenant, provider, crew, Lead/worker ID, request ID, or arbitrary scope list.

2. `GET /handyman/lead/assigned-scopes/:executionScopeId`
   - Re-authorize the exact scope on every request; a list result is not a bearer capability.
   - Return a bounded field projection of the immutable CR-HM-06 scope/location snapshot and the approved quotation version’s work description/line facts needed to perform the approved work. Keep line content to field-needed description/type/quantity/UOM; omit quoted unit amounts, line totals, currency, pricing provenance, and unrelated authorship fields.
   - Include the **current** readiness view, linked by the scope’s server-resolved `handymanRequestId`: scheduling readiness (`preferredWindowStart`, `preferredWindowEnd`, building-derived timezone), unit-access readiness (current access window/status), and Handyman permit readiness (current type/status/validity where present). Return `null`/empty for no current fact. Do not return readiness history in the minimum contract.
   - Name scheduling fields as a **preferred window**. CR-HM-05 readiness is not a scheduled/committed execution slot. Unit access readiness is not arrival/check-in proof; Handyman permit readiness is not FM Permit-to-Work.

A separate readiness endpoint is not necessary for the minimum BE01 contract: the exact detail response can carry the current readiness facts. If Mobile later requires independently refreshed readiness, that should be a separately governed exact-scope read with the same Lead guard—not reuse of the request-keyed Customer Care path.

### Backend ownership / derivation

- The list query derives the actor from `req.auth.userId`, then filters by the existing current Lead chain. It must join/read the canonical CR-HM-04 assignment and Lead authorities; it must not trust caller-supplied `crewId`, `workerContextId`, `leadUserId`, or `providerContextId`.
- The detail query starts from the `executionScopeId`, derives Client, request and approved-version lineage from the stored scope/assignment, and reads readiness only for that scope’s own request. No request ID or tenant/location context is accepted from the mobile client.
- Only ACTIVE assignment + valid current Lead is discoverable. The scope remains CR-HM-06 `AUTHORIZED`; do not add job or execution states. No assignment history, superseded scopes, or other crews’ work is included.
- Both operations are read-only. CR-HM-04 remains the sole authority for provider-authored assignment/reassignment, crew, Lead, and history; CR-HM-05 remains the readiness authority; CR-HM-06 remains the scope authority.

## SECURITY

| Control | Required contract |
|---|---|
| Authentication | Require a valid local Bearer session. Use only backend-resolved `req.auth.userId`; unauthenticated request fails closed. |
| Lead authority | Resolve `executionScopeId → ACTIVE assignment → assigned crew → current Lead row → ACTIVE membership → ACTIVE worker context → workforce profile userId`; authorize only when the resolved non-null `leadUserId` equals the authenticated user. Re-evaluate dynamically on every list/detail request so replacement/reassignment immediately changes access. Helpers with no login `userId` cannot authenticate as Lead. |
| Permission boundary | Do **not** gate this Mobile Lead read with `tenant_company.read` or `tenant_company.manage`, and do not add a new RBAC permission in BE01. Follow the existing field-actor pattern: authentication plus service-level current-Lead proof. A generic Client read permission is not assigned-scope authority. |
| Tenant isolation | Retain the existing `contextAccessService.canAccessClient(authenticatedUserId, scope.clientId)` boundary in addition to the exact assignment/Lead check. Compare the stored scope, assignment, crew and provider Client chain server-side. Client/building/tenant/request selectors from the caller are not authority. |
| Non-enumeration | The collection contains only the caller’s current assignments. Exact reads of a missing, inactive, reassigned, invalid-Lead, or foreign scope must fail closed without disclosing another assignment’s details; use a bounded not-found/denied response consistently with the API error policy. |
| Data minimization | Whitelist field DTOs. Do not return Care-actor/attribution provenance, tenant PIC/contact data, private intake evidence/storage keys, raw customer records, quotation amounts/totals, provider/BM financial or settlement facts, challenge secrets, or unrelated crew membership. Review free-text authorization notes before exposing them. |
| Authority firewall | No assignment, reassignment, readiness mutation, schedule binding, arrival, check-in, work-session, or FM work-order behavior is added. Existing Customer Care endpoints, `tenant_company.read/manage` behavior, and response schemas are unchanged. |

## PARTS

- **BE01 — this part: COMPLETE.** Baseline verified; existing authorities, APIs and auth mapped; minimum Mobile Lead read contract proposed. Documentation only.
- **BE02 — NOT STARTED.** Freeze endpoint/DTO details, pagination, safe location labels and any free-text note exposure with the Mobile owner. Preserve the current-only readiness minimum unless a history need is explicitly approved.
- **BE03 — NOT AUTHORIZED BY BE01.** If separately approved, implement only the Lead-scoped read service/transport and field-safe projection over CR-HM-04/05/06 authorities. No reassignment or Customer Care changes; no new lifecycle table is indicated by this mapping.
- **BE04 — NOT RUN / FUTURE ONLY.** If BE03 is authorized, add focused auth/tenant/assignment/reassignment/data-minimization contract tests and API schema validation. No test or build was run for BE01.

## BLOCKERS

- **No authority or persistence blocker for defining a read-only contract:** assignment, current Lead resolution, scope, approved quotation version and the three readiness authorities already exist.
- **Rollout precondition:** the existing field-actor Client gate is based on explicit active User→Building assignments. Confirm Mobile Lead accounts receive the appropriate active Building assignment(s) for the assigned scope’s Client; otherwise the existing `canAccessClient` boundary will deny them even when the assignment Lead chain matches.
- **Schedule semantics:** current CR-HM-05 data is a customer-preferred window, not a committed execution schedule. If Mobile requires a confirmed slot, BE01 cannot manufacture it; that requires a separately authorized schedule-binding authority.
- **Privacy decision before implementation:** do not expose `authorizationNote`, raw request description, customer contacts, or any commercial quotation fields by default. Confirm any additional field need and classify it in BE02.

**BE01 exit: MAPPING ONLY; no runtime coding, tests, or build. STOP.**
