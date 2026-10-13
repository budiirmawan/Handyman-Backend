# CR-HM-SEC-03 PART04 — final reconciliation

Date: 2026-10-10 (Asia/Jakarta).

**Verdict: READY WITH DEBT for PR review of the frozen SEC-03 scope.** This is
not certification of the entire inventory/procurement surface or corrupted
receipt/issue histories. No PR or merge is performed by PART04.

## 1. Scope, gates and provenance

- Branch: `arena/6b22b6c6-handyman-backend` throughout; no branch creation/switch.
- Initial HEAD and remote branch both
  `beb4b28eeae32c367ab8c91cdc6e04e97ce8cb40`; clean working tree at entry.
  Main stayed `5d04fac9862c5639a47b0130cb538fb29a766716`.
- PART01: `85ba9ade5babb9157e9c1009d12a92e806d15dd6` — item-list containment.
- PART02: `ffa7bb67cf3bb26ea281bd12a9c07a15af2d4691` — six canonical boundaries.
- PART03: `beb4b28eeae32c367ab8c91cdc6e04e97ce8cb40` — nine mobile/reservation boundaries.
- PART04 changes only directly affected OpenAPI and this reconciliation/query
  evidence. No runtime/test changes, new routes, migrations or index creation;
  no Docker or broad test suite. Existing migrations ran only in an isolated
  test PostgreSQL database.

**PART00 provenance gap:** the original SEC-03 PART00 report was not found in
tracked files, available Git history, local report search, or GitHub issues/PRs.
Do not interpret this document as a recovered audit or verified closure of
its original numbered findings. The recoverable predecessor is
[PR #17](https://github.com/budiirmawan/Handyman-Backend/pull/17), whose residual
HIGH item-list finding states that only the first returned Building was
checked. Baseline `5d04fac` controller/repository source confirms that defect.
The following reconstruction maps the requested sixteen boundaries using that
baseline, implementation diffs and focused tests, not invented PART00 findings.
The final user instruction authorizes documentation-only completion with
residual risks recorded; original audit line-by-line closure remains unverified.

## 2. Runtime authority and sixteen-boundary matrix

BE-02G `resolveBuildingsForUser` remains the only assignment/hierarchy resolver:
ACTIVE user assignment + ACTIVE Building, Building → Property → Client.
Canonical scope resolution and the shared `resolveMaterialScope` produce exact
`{clientId, buildingId}` pairs; neither expands to sibling Buildings, independent
Client/Building sets or an unrestricted empty scope. RBAC capability is separate
from data scope; PLATFORM_ADMIN has no implicit bypass. The item-list requires
`material_request.read`, not an additional inventory-item permission.

MR chain: PR Client/Building matches MR; Item Client matches MR; optional
Warehouse Client/Building matches MR. Field requests additionally require the
parent Work Order in the same pair. Reservation chain: MR Client/Building/Item
matches reservation; optional MR target Warehouse matches reservation Warehouse;
Warehouse belongs to the same pair; source MR chain is consistent. Independent
foreign keys alone do not establish these relationships.

| # | Boundary | Verified resolution / effect |
|---:|---|---|
| 1 | GET `/items/{itemId}/material-requests` | Item visible only in reachable Clients; every line intersected with exact pairs and MR chain in SQL. Mixed/unauthorized-only histories cannot leak or deny based on the first row. |
| 2 | POST `/purchase-requests/{purchaseRequestId}/material-requests` | Scoped parent resolved/locked and input Item/Warehouse visibility checked before trusted creation; ownership derives from parent. |
| 3 | GET `/purchase-requests/{purchaseRequestId}/material-requests` | Scoped parent before list; inconsistent child chains excluded in SQL. |
| 4 | GET `/buildings/{buildingId}/material-requests` | Existing explicit Building middleware plus exact-pair service scope and chain-filtered SQL. |
| 5 | GET `/material-requests/{id}` | Scoped consistent MR before nested projection/receipt totals; see separate aggregate risk below. |
| 6 | PATCH `/material-requests/{id}` | Scoped consistent source locked in mutation transaction; replacement Warehouse checked for visibility and compatibility. |
| 7 | POST `/material-requests/{id}/cancel` | Scoped source locked in transaction before ACTIVE-reservation check and status update. |
| 8 | GET `/mobile/work-orders/{workOrderId}/material-requests` | Scoped Work Order before context; MR/PR/Item/Warehouse/WO consistency; rows with inconsistent reservation children excluded before fulfillment. |
| 9 | POST `/mobile/work-orders/{workOrderId}/material-requests` | Scoped WO, field-actor and item visibility checks before idempotency claim; inconsistent field parent rolls back claim/MR/event; replay revalidates persisted MR chain and children, returning original valid stored response. |
| 10 | GET `/mobile/material-requests/{materialRequestId}` | Scoped field chain and reservation-child consistency before detail/fulfillment/issues; no additional field-actor mutation gate for read. Issue-child risk is separate below. |
| 11 | POST `/mobile/material-requests/{materialRequestId}/cancel` | Scoped field chain plus existing field-actor gate; MR/field chain and child checks repeated under MR lock before withdrawal/event. |
| 12 | POST `/material-requests/{materialRequestId}/reservations` | Scoped consistent MR locked first; inconsistent existing reservation children rejected; input visibility and compatibility before demand/stock allocation. Usage-aggregate risk is separate below. |
| 13 | GET `/material-requests/{materialRequestId}/reservations` | Scoped source before list; reservation-chain-consistent rows only, with empty visible result preserved. |
| 14 | GET `/material-reservations/{id}` | Scoped reservation/source/Warehouse ownership before nested projection. |
| 15 | POST `/material-reservations/{id}/release` | Scoped consistent source and reservation rechecked under locks; MR → Reservation → Stock Balance order retained. |
| 16 | POST `/material-reservations/{id}/cancel` | Same scoped/locked chain as release; remaining unconsumed allocation cancelled once. |

### Resource hiding, not blanket 404

- Capability/authentication failures retain 403/401. Body/path/query validation
  remains 400; accessible semantic/lifecycle mismatches retain existing 400/409.
- Unknown/inaccessible parent PR → `PURCHASE_REQUEST_NOT_FOUND` 404;
  MR → `MATERIAL_REQUEST_NOT_FOUND` 404; reservation →
  `INVENTORY_MATERIAL_RESERVATION_NOT_FOUND` 404; mobile WO →
  `WORK_ORDER_NOT_FOUND` 404. Ownership-inconsistent source chains are hidden
  or omitted, not enriched first. Hidden item/warehouse inputs use their 404
  not-found codes; accessible incompatible inputs retain mismatch errors.
- **Explicit Building list retains uniform 403 `BUILDING_ACCESS_DENIED` for
  both unknown and inaccessible valid UUID Buildings.** This is preserved
  BE-02G middleware behavior, not an existence-dependent 404/403 split.
- **Item-list zero-context actor receives fixed 403 before item lookup**;
  with nonempty scope, unknown and foreign-Client items both yield 404.
  Accessible items with no visible requests return the ordinary empty array.
- Canonical and reservation lists retain envelopes and descending creation/id
  order. Mobile WO context retains `{workOrderId, availableActions,
  materialRequests: []}` for an accessible empty WO, and ascending creation/id
  order. No hidden counts, export or pagination authority is introduced.

### Mutation and preserved contracts

Focused tests assert zero request/reservation/balance/movement/event/idempotency
mutation on unauthorized or tested inconsistent-source paths; they do not
prove safety for every possible database corruption or concurrent reassignment.
Source resolution is in mutation transactions. Existing quantity/UOM and demand
caps, stock allocation, audit/lifecycle, remaining-allocation release/cancel,
field-actor permissions and valid idempotent stored responses remain intact.
Trusted internal actor-less repository/service contracts retain their existing
caller-owned authorization and executor semantics; they are not new HTTP bypass
routes. SQL scope predicates are equivalent across canonical/shared versions;
no global authorization redesign was made.

## 3. OpenAPI / consumer compatibility

`docs/api/openapi.yaml` now documents the sixteen existing operations above:
exact authority, resource-hiding codes, empty results, supported canonical list
filters, stable ordering, input visibility versus compatibility, replay ownership
revalidation, lock order and remaining-allocation behavior. Read validation 400
responses are documented. The explicit Building 403 and item no-scope 403 are
stated rather than incorrectly generalized to 404. Receipt/issue projection
assumptions are disclosed on affected operations. No DTO, operation ID, path,
permission vocabulary or external consumer was changed.

In-repo callers reviewed: canonical controllers use actor-facing APIs; mobile
creation retains the transaction-aware trusted create service; reservations,
receivings, controlled material usage and procurement approvals retain their
existing internal repository contracts. No external frontend checkout exists
here, so external consumer integration was not asserted. The R2P handoff's
shared envelope/error table was reviewed but not rewritten: it governs other
procurement surfaces, not a new blanket MR 403 promise. Consumers must tolerate
intentional scoped not-found results and omissions; no authorization weakening
was used to preserve old leakage. Directly affected legacy expectations had
already been narrowly pristine-compared in PART02/03; PART04 changes no tests.

## 4. Focused validation

Disposable DB on `127.0.0.1:55584`, `asentra_test`; sequential files because
fixtures truncate shared tables. No skipped database tests.

| Check | Result |
|---|---:|
| `material-request-item-isolation.test.ts` | 20 passed |
| `material-request-canonical-isolation.test.ts` | 10 passed |
| `material-request-mobile-parity.test.ts` | 10 passed |
| `material-request-reservation-parity.test.ts` | 12 passed |
| Security regression total | **52 passed; 0 failed/skipped** |
| Ten focused compatibility/OpenAPI files below, final run | **158 passed; 0 failed/skipped** |
| Distinct tests across security + compatibility | **210 passed** |
| `npx tsc --noEmit` | PASS |
| `git diff --check` | PASS |

Compatibility files: `material-requests.test.ts`,
`material-request-approved-quantity.test.ts`, `mobile-material-requests.test.ts`,
`inventory-material-reservations.test.ts`, `mobile-material-actions.test.ts`,
`mobile-material-context-contract.test.ts`,
`mobile-material-issue-awareness.test.ts`, `mobile-material-usage.test.ts`,
`work-order-material-issue-control.test.ts`, `material-chain-openapi.test.ts`.
The last file checks YAML parse, router/documented paths, schemas and registered
error vocabulary; the context suite also checks the mobile OpenAPI contract.
Repeated compatibility runs are not added to the distinct test total.

Common invocation (substitute the four security or ten compatibility filenames):

```bash
DB_HOST=127.0.0.1 DB_PORT=55584 DB_USER=postgres DB_PASSWORD=postgres \
DB_NAME=asentra_test DB_SSL=false NODE_ENV=test LOG_LEVEL=error \
ASENTRA_USE_EMBEDDED_POSTGRES=false npx tsx --test --test-concurrency=1 <focused-files>
npx tsc --noEmit
git diff --check
```

## 5. Query-plan finding

See [retained EXPLAIN evidence](CR-HM-SEC-03_PART04_ITEM_LIST_EXPLAIN.md) for
fixture design, actual SQL, parameters, existing indexes and six text plans.
80,000 additional synthetic requests: hot-item execution 3.391–3.552 ms for
one Building/997 rows, 16.542–16.780 ms for five/4,997 rows,
33.701–34.953 ms for a forty-pair scope/9,997 rows. Existing indexes were used;
no MR sequential scan, sort spill or temporary I/O observed in warm runs.

No immediate index migration is justified. Future authorized evaluation could
compare composite Item + exact Client/Building (+status/order variants) indexes
because repeated bitmap work and a nonleading unique-index scan were observed.
Top row estimates of 1 versus up to 9,997 actual, JSON scope estimates, larger
histories, cold/generic plans and unpaginated output growth remain unresolved.
Sandbox PostgreSQL 18.4 timings are not a deployed-version SLA.

## 6. Residual risks — separate follow-up scope

### R1 — Receipt/issue aggregate ownership corruption (security; not closed)

**Potential cross-context metadata disclosure and derived-quantity poisoning
if historical/direct-write child ownership is inconsistent with its linked MR.**
This is separate from the tested MR/reservation source-chain containment.

- `material-request.repository.ts::sumReceivedQuantity` selects by
  `material_request_id` and RECEIVED/FINALIZED status only. Canonical detail
  can therefore include ownership-corrupt linked receipts in received/remaining
  totals after authorizing an otherwise valid MR.
- `inventory-material-reservation.repository.ts::DEMAND_FROM` sums usage by
  `material_request_id` only. Mobile fulfillment and reservation-create demand
  arithmetic can therefore be affected by ownership-corrupt linked usages.
- `mobile-material-request.repository.ts::listIssuesByMaterialRequest` filters
  only by linked MR and joins Warehouse by ID. A corrupt linked issue could
  expose foreign Warehouse metadata/IDs, usage notes or actor references through
  an authorized MR detail. The MR and reservation-child checks do not validate
  each usage child's Client/Building/Work Order/Item/Warehouse ownership.
- Reviewed receiving and controlled usage write paths validate MR/item/WO or
  parent/warehouse compatibility and preserve row locks. That reduces ordinary
  write-path exposure but does **not** establish read-side corruption immunity
  for historical/direct writes or other unreviewed writers.

No receipt/issue implementation, corruption-regression suite or remediation
migration was added in PART04. Track separately for scoped projection/aggregate
ownership checks, writer/legacy data audit and explicit acceptance criteria.
Do not call this risk closed by the 52 MR/reservation security tests.

### R2 — Database ownership constraints (not closed)

The reviewed MR/reservation/receipt/usage relationships use independent FKs and
partial constraints, not complete composite ownership enforcement. Existing RFQ
scope uniqueness/references do not enforce every MR→PR/Item/Warehouse or
reservation/usage/receipt relationship. Direct SQL/imports or future unguarded
writers can create ownership-inconsistent rows; runtime predicates are not a
replacement for database integrity. Constraints/data repair require separately
authorized schema work. Related ownership rows/scope are not globally locked
against every concurrent reassignment/hierarchy edit; no blanket concurrency
certification is claimed.

### R3 — Mobile material-items/usage boundaries (not hardened by SEC-03)

`GET /mobile/work-orders/{workOrderId}/material-items` and
`POST /mobile/work-orders/{workOrderId}/material-usages` retain prior contracts
and are outside these sixteen boundaries. Their existing Building/field-actor
and controlled-issue guards were not redesigned or certified as SEC-03 parity.
Compatibility passes are not security closure for those surfaces.

### R4 — Other inventory/procurement endpoints (not audited end-to-end here)

Other item/warehouse/stock, approval, receiving, procurement and financial
surfaces retain their existing authorization/ownership assumptions. Trusted
internal APIs remain caller-guarded. No system-wide readiness claim follows
from this focused reconciliation; review those endpoints under a separate CR.

### R5 — Query-plan scaling / statistics (unresolved)

Cardinality estimates, nonleading index selection for status, deployed-version
behavior, cold/prepared plans and growing unpaginated histories require further
measurement before index recommendations become migration proposals.

### R6 — Audit provenance / external consumers (unverified)

Original PART00 finding IDs and external frontend integration cannot be certified
from available evidence. This limitation is explicit, not substituted with
fabricated audit findings or invented consumers.

## 7. Disposition

The frozen sixteen-boundary implementation regressions and affected contracts
pass focused validation. Documentation is ready for a future PR with **the
above debt explicit**, particularly R1; broader corruption-proof ownership is
not claimed. Commit/push only these documentation changes on the assigned Arena
branch. No migrations, runtime expansion, PR or merge. STOP after reporting the
final documentation commit SHA and validation results.
