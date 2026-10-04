# CR-HM-18 BE11 — Material Mobile Contract Gate

Date: 2026-10-04 (Asia/Jakarta)
Branch: `arena/01a10470-handyman-backend`
Reviewed Backend baseline: `61b0d67`
Status: **Contract-only review; Lead Mobile material execution remains blocked pending the Backend gaps in §8. No runtime or Mobile changes are authorized by BE11.**

```text
CR_HM_18_BE11=MATERIAL_MOBILE_CONTRACT_GATE_REVIEWED
CR_HM_09_MATERIAL_AUTHORITY=BACKEND_ONLY
MATERIAL_MOBILE_GATE=BLOCKED_PENDING_BACKEND_CONTRACT_REMEDIATION
MOBILE_PRICE_OR_CHARGE_CALCULATION=FORBIDDEN
```

## 1. Gate decision

CR-HM-09 has Backend-owned commands for quotation-linked estimate/approval,
exclusive issue-or-purchase acquisition, use, return, and line settlement.
That is not yet a safe Lead Mobile contract: there is no Lead-safe read of
in-flight lines, execution quantities have no unit in their DTO, the aggregate
final-used read mixes quantities without unit grouping, and the current
return/final-used rules can produce a negative final-used quantity. Material
writes also resolve the current Lead before—not under—the line transaction's
lock.

Mobile must not infer quantities from a status, infer units from a catalogue
price, or calculate any price/charge. The Backend is the sole material and
financial authority. This gate freezes what the existing surface does and
lists the contract blockers; it does not repair them.

## 2. Existing material lifecycle

| Stage | Existing Backend action | Frozen current meaning |
| --- | --- | --- |
| Material requirement / estimate | `POST .../material-lines/estimate` | Creates an `ESTIMATED` execution line linked to one `MATERIAL` line on the scope's approved quotation version. `estimatedQty` must be positive and no greater than the approved quotation quantity; `approvedQty` is copied from that quotation line. This endpoint cannot create a plain, unquoted material requirement. |
| Approval | `POST .../{lineId}/approve` | `ESTIMATED` → `APPROVED`; quantities do not change. |
| Obtain material | `POST .../{lineId}/issue` **or** `POST .../{lineId}/purchase` | Positive quantity deltas accumulate on exactly one acquisition axis per line. The cumulative issued or purchased quantity cannot exceed `approvedQty`; mixed modes return a conflict. Purchase accepts a bounded supplier/receipt reference, not a price or purchase-order transaction. |
| Use | `POST .../{lineId}/use` | Positive delta; requires an acquired line and is capped by remaining held quantity. The first use moves the line to `USED`; later uses accumulate. |
| Return unused | `POST .../{lineId}/return` | Positive delta; `RETURNED` is not a status. The current service describes this as returning held-not-used quantity and caps it by `issuedQty + purchasedQty - usedQty`. |
| Final usage handoff | `POST .../{lineId}/settle`, then `GET .../final-charge-ready` | `ISSUED`, `PURCHASED`, or `USED` → terminal `FINAL_CHARGE_READY`. The read exposes settled lines and a quantity aggregate only; it is not a charge or price. |

`MATERIAL_RUN` is a separate CR-HM-08 work-clock event: it changes the
session's clock state and creates **no** material transaction, quantity, or
cost. None of the material command bodies accepts a `sessionId`; the material
API does not require a `MATERIAL_RUN` session or attach events to a work
session.

## 3. Existing HTTP surface and authority

All paths below are under `/api/v1`.

### Lead commands (7)

| Method / path | Body |
| --- | --- |
| `POST /handyman/execution-scopes/{executionScopeId}/material-lines/estimate` | `quotationVersionId`, `quotationLineId`, `estimatedQty`, `idempotencyKey` |
| `POST /handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/approve` | `idempotencyKey` |
| `POST /handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/issue` | `quantity` delta, `idempotencyKey` |
| `POST /handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/purchase` | `quantity` delta, optional `supplierReference`, `idempotencyKey` |
| `POST /handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/use` | `quantity` delta, `idempotencyKey` |
| `POST /handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/return` | `quantity` delta, `idempotencyKey` |
| `POST /handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/settle` | `idempotencyKey` |

Mutation routes require an authenticated session; domain services require
Client access and resolve the actor as the current assigned Crew Lead. Each
per-line command verifies that the line belongs to the `executionScopeId` in
the path; an unknown/mismatched line is not used as a cross-scope locator.
Only ESTIMATE explicitly checks that the scope is `AUTHORIZED`; later
commands rely on the current Lead and line-state checks.

This is **scope-bound, not session-bound or assignment-snapshot-bound**:
`executionScopeId` is stored on the line/event, but no assignment ID or
session ID is stored. A new current Lead may act on the same scope's existing
line. The Lead check happens in `authorityPreamble` before the mutation
transaction; the material service then locks the material line (or quotation
line for ESTIMATE), but does not lock/revalidate the scope assignment or crew
inside that transaction. A reassignment/Lead-change race therefore is not
closed by the material mutation's row lock.

### Reads

- `GET /handyman/execution-scopes/{executionScopeId}/material-lines` is a
  Customer Care projection guarded by `tenant_company.read`; it is not a
  Lead Mobile read contract. It returns all line states and events.
- `GET /handyman/execution-scopes/{executionScopeId}/material-lines/final-charge-ready`
  is current-Lead/Client-authorized. It returns **settled lines only** and
  `totalFinalUsedQty`; unsettled/working lines are absent. It is not a
  progress read.
- There is no Lead-safe list/read of `ESTIMATED` through `USED` lines, no
  individual line read, and no Lead-safe line-event history read. A command
  response is the only Lead-facing line head today.

## 4. Existing Mobile-safe DTO boundary

Successful handlers return the standard Backend envelope; the material
payload is in `data`:

```json
{
  "data": {
    "line": {
      "id": "<uuid>",
      "executionScopeId": "<uuid>",
      "quotationVersionId": "<uuid>",
      "quotationLineId": "<uuid>",
      "sourceItemId": "<uuid-or-null>",
      "status": "ESTIMATED|APPROVED|ISSUED|PURCHASED|USED|FINAL_CHARGE_READY",
      "acquisitionMode": "ISSUED|PURCHASED|null",
      "estimatedQty": 0,
      "approvedQty": 0,
      "issuedQty": 0,
      "purchasedQty": 0,
      "usedQty": 0,
      "returnedQty": 0,
      "supplierReference": "<reference-or-null>",
      "createdAt": "<server date-time>",
      "updatedAt": "<server date-time>"
    },
    "event": {
      "id": "<uuid>",
      "lineId": "<uuid>",
      "executionScopeId": "<uuid>",
      "eventType": "ESTIMATE|APPROVE|ISSUE|PURCHASE|USE|RETURN|FINAL_CHARGE_READY",
      "idempotencyKey": "<key>",
      "occurredAt": "<server date-time>"
    },
    "replayed": false
  }
}
```

The handler deliberately omits internal `clientId` and `actorUserId`, and
accepts no caller-authored status, absolute quantity, time, assignment, or
session authority. It also omits a material description and every UOM field
(`uomId`, code, and symbol). `sourceItemId` and quotation IDs are references,
not display labels or units.

`supplierReference` is documented for PURCHASE only, but the shared quantity
parser accepts it on ISSUE/PURCHASE/USE/RETURN and the controller forwards it
to ISSUE as well as PURCHASE; the service stores it for either acquisition
mode. Mobile should send it only on PURCHASE. Backend contract alignment is
needed so ISSUE cannot mutate this reference unexpectedly.

For the final-charge-ready GET, the current payload is
`{ executionScopeId, lines, totalFinalUsedQty }`; lines use the same bounded
line projection and **do not contain per-line `finalUsedQty`**. The Customer
Care-only read adds per-line `finalUsedQty` and events, but is not a Lead
substitute. OpenAPI currently advertises a `projectedAt` property on the
Lead projection that the domain type and HTTP serializer do not emit; its
200 response schema also needs alignment with the actual success envelope.

## 5. Quantity and unit contract

- Every input `quantity` is a **positive delta**, never an absolute head.
  The Backend returns the new cumulative line head. ESTIMATE is the opening
  estimated quantity; APPROVE copies the immutable quotation quantity.
- Persistence uses `NUMERIC(14,3)` for quantity axes and the HTTP DTO uses
  JSON numbers. The current validators require finite positive values but do
  not reject more than three fractional digits; the database can therefore
  round an accepted input to its stored scale. Until a separately authorized
  Backend fix, Mobile should send no more than three decimal places and must
  use the returned server quantities as truth.
- The execution line neither stores nor returns a UOM. Although the line is
  linked to an approved quotation MATERIAL line, this surface does not carry
  the linked line's unit into the response or quantity requests. Do not label
  a quantity or combine values across lines until a Lead-safe DTO supplies
  the unit.
- `totalFinalUsedQty` is currently a raw sum across settled lines, without
  grouping by UOM. It is not a dimensionally safe total when lines use
  different units; Mobile must not present it as a meaningful aggregate.

## 6. Idempotency and stale/conflict behavior

The persistence uniqueness boundary is
`(lineId, eventType, idempotencyKey)`. A retry of the same command must reuse
the same key and the same payload; it returns `replayed: true` and does not
apply the quantity delta twice. Use a new key for a genuinely new command.
The stored event is stable, but replay serializes the current line head with
that event, so a replay after later transitions is not a historical
line-state snapshot.

CR-HM-09 governance specifies UUID idempotency keys. The HTTP schema/parser
allows up to 200 characters while the domain service rejects keys longer
than 128; a UUID key fits both. Mobile should use a fresh UUID per new command
and persist it unchanged for offline retries. The length mismatch and
OpenAPI's stronger claim that replay returns the same rows require Backend
contract alignment.

Current bounded failures include: `401` unauthenticated; `403`
`HANDYMAN_MATERIAL_EXECUTION_NOT_AUTHORIZED` / Client-access denial; `404`
unknown scope/line or a line outside the path scope; `400` `VALIDATION_ERROR`,
`HANDYMAN_MATERIAL_EXECUTION_ESTIMATE_INVALID`, or
`HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED`; and `409`
`HANDYMAN_MATERIAL_EXECUTION_SCOPE_NOT_ELIGIBLE`,
`HANDYMAN_MATERIAL_EXECUTION_LINK_INVALID`,
`HANDYMAN_MATERIAL_EXECUTION_LINK_CONFLICT`, or
`HANDYMAN_MATERIAL_EXECUTION_ILLEGAL_TRANSITION`. Once settled, a new
mutation key is a `409`; an exact already-recorded key still replays. There is
no line version, `If-Match`, ETag, or dedicated stale-version conflict for
Mobile to send.

## 7. Final-used and finance boundary

The current CR-HM-09 rule and implementation calculate
`finalUsedQty = usedQty - returnedQty`; the settled projection aggregates that
same expression. This is the server's present execution-truth rule, **not a
price or charge**. However, the same contract describes RETURN as returning
held-not-used material and permits `returnedQty <= issuedQty + purchasedQty
- usedQty`; it does not require `returnedQty <= usedQty`. For example,
`acquired=10, used=1, returned=3` satisfies the current quantity checks but
produces `finalUsedQty=-2`. The current Lead projection can consequently
return a negative or cross-unit `totalFinalUsedQty`; the Customer Care schema's
non-negative final-used declarations are not enforced by the write invariants.

This contradiction blocks Mobile consumption of final-used quantities until
Backend resolves what a return means, aligns the invariant and projection,
and exposes the authoritative per-line result. Mobile must not clamp, sum,
or otherwise repair these values locally.

CR-HM-09 exposes no price, currency, amount, or charge. `supplierReference`
is a bounded reference only. `FINAL_CHARGE_READY` means the usage-basis handoff
is closed; it does not mean the material has been priced or charged. Mobile
must not calculate or display a charge from quantities, reference prices, or
purchase references.

## 8. Required next parts

1. **Backend material contract/runtime remediation (separately authorized):**
   add a Lead-safe in-flight line/read-history projection with item description
   and unit; resolve `RETURN` versus `finalUsedQty` and enforce a non-negative
   server result; group/remove cross-UOM totals; validate the persisted
   three-decimal quantity scale; align idempotency length/replay DTO and
   `supplierReference` behavior; align OpenAPI with the actual envelope; and
   revalidate/serialize current scope assignment and Lead at the write
   boundary. Explicitly decide whether material commands are intentionally
   independent of a work session or should carry an optional session
   reference—do not conflate them with `MATERIAL_RUN`.
2. **Lead Mobile integration:** only after the Backend contract and focused
   certification are complete. Mobile sends Backend commands, renders
   Backend-returned quantities/units/statuses, and never owns material truth
   or pricing/charge calculations.

BE11 makes no runtime, OpenAPI, test, or Mobile change; this document records
the gate findings and the contract decisions/blockers for a separately
authorized Backend follow-up.
