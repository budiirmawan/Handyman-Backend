# CR-HM-18 BE12 — Material Quantity & Lead Read

Date: 2026-10-04 (Asia/Jakarta)
Branch: `arena/01a10470-handyman-backend`
Status: **Backend material quantity/read gaps implemented; assignment-mutation race and session binding remain out of scope.**

```text
CR_HM_18_BE12=MATERIAL_QUANTITY_AND_LEAD_READ_IMPLEMENTED
MATERIAL_AUTHORITY=BACKEND
LEAD_PROGRESS_READ=CURRENT_ASSIGNED_LEAD_ONLY
FINAL_USED_QTY=SETTLED_USED_QTY
QUANTITY_STORAGE=NUMERIC(14,3)
MATERIAL_TOTALS=GROUPED_BY_AUTHORITATIVE_UOM
```

## 1. Lead progress read

Added the distinct authenticated Lead route:

```text
GET /api/v1/handyman/execution-scopes/{executionScopeId}/material-lines/progress
```

The handler uses the existing Client-access and current-assigned-Crew-Lead
service authority. Its bounded DTO returns the current line status, material
description and source-item identity, authoritative UOM, and
`estimatedQty`, `approvedQty`, `issuedQty`, `purchasedQty`, `usedQty`,
`returnedQty`, and `finalUsedQty`. `finalUsedQty` is `null` before settlement.
The read has no event array, Customer Care history, client/actor internals,
supplier reference, timestamps, prices, amounts, or charges. The existing
Customer Care history route is unchanged and is not used as the Lead read.

The UOM identity is the non-null `uom_id` on the execution line's linked,
approved quotation MATERIAL line. Code, name, symbol, and category are
resolved from that same `units_of_measure` record with a Client match; no
catalogue or source-item UOM inference is used.

## 2. Quantity precision and final-used meaning

Before database writes, ESTIMATE and all quantity-delta commands now reject
values that cannot be represented by the execution columns' `NUMERIC(14,3)`:
positive inputs must have at most three fractional digits and be below
`100000000000` (maximum representable value `99999999999.999`). OpenAPI
quantity schemas describe the same scale and upper bound.

RETURN remains the existing lifecycle command, idempotency boundary, and
quantity adjustment: it returns held-but-unused stock and stays a non-sticky
status. It does not undo a USE fact. For the Lead progress/final-charge-ready
projections, a settled line has `finalUsedQty = usedQty`; this is non-negative
because persisted used quantity is constrained to be non-negative.
Settlement, acquisition modes, quantity caps, event history, and command
replay semantics are unchanged. The material-pricing composition consumes
this server-derived final-used value; no commercial fields were added to the
Lead material DTO.

## 3. UOM-safe settled totals and OpenAPI

The Lead `GET .../final-charge-ready` response now includes the same
field-safe line state and `totalsByUom`. Each total carries the UOM identity
and `totalFinalUsedQty`; grouping is by UOM ID, so unlike units are never
summed into one scalar. The former scalar `totalFinalUsedQty` and the
OpenAPI-only `projectedAt` field are absent from this Lead response. Both
Lead read operations are documented with the runtime `SuccessEnvelope`.

No assignment locking/revalidation inside mutation transactions and no
session ID/material command binding were introduced. Those BE11 findings
remain explicitly deferred.

## 4. Focused verification

Focused quantity, UOM, Lead read, and authorization tests cover scale/range
rejection, three-decimal persistence, current-Lead/outsider access, the new
field-safe progress response, non-negative final-used with returns exceeding
used quantity, UOM-grouped totals, and OpenAPI/runtime parity. No full suite,
build, or typecheck is part of BE12 verification.
