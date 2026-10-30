# CR-HM-WARRANTY-E2E-01 — PART 01A: agreed item terms

This part establishes prospective contractual terms; it does **not** issue a warranty certificate, start a warranty, accept BAST, or alter claims/rework. An offer or DRAFT is not tenant consent.

## Authoring and issuance

An active, exact-Building Handyman commercial Operations user with both `tenant_company.manage` and `handyman.commercial.manage` may `PUT /api/v1/handyman/quotation-versions/:versionId/lines/:lineId/warranty-terms` while the version is DRAFT. A Tenant PIC cannot author terms, even with dual-role permissions. `GET .../lines` returns the proposal fields subject to the existing quotation visibility/access rules. Every line needs an explicit selection before ISSUE; there is no default.

* `coverage`: `NONE`, `LABOR`, `PARTS`, or `BOTH`.
* For `LABOR`/`BOTH`, supply `coveredServices`; for `PARTS`/`BOTH`, supply `coveredMaterials`. Supply explicit `conditions` and `exclusions` (write an express no-additional-condition/exclusion statement if appropriate). Do not put a covered category on a line that does not cover it.
* For a warranted item, `commencementRule` is `BAST_ACCEPTED_AT`, and exactly one end rule is required: `DURATION_DAYS` with integer `durationDays` (consecutive 24-hour days from the actual acceptance instant), or `FIXED_END_DATE_JAKARTA` with a real `fixedEndDate` (`YYYY-MM-DD`, inclusive through the end of that date in Asia/Jakarta). `NONE` has no covered services/materials, conditions, exclusions, commencement or end rule.
* `replacesQuotationLineId` is optional, and must identify an earlier issued line of the same quotation and type. It is an explicit proposed amendment, not evidence that the earlier line was agreed. Do not use it for an ADD's new item.

Issued quotation sources and PDFs disclose every line's exact terms and identify the item. Per-item terms take precedence over the issuer's general warranty note. Issue is atomic; DB guards prevent edits/deletes after DRAFT and prevent mismatched source snapshots. The existing personal Tenant PIC decision or independently verified Care consent pins the exact quotation document and its source/PDF hashes. There is no consent until the existing decision succeeds.

## Variations and lineage

An issued variation PDF shows the original and revised terms, but **only** the explicitly listed `warrantyChanges` have warranty effect: the exact added item, and revised items with an explicit predecessor. Other revised-quotation lines are informational and do not alter any earlier agreement. A proposed amendment identifies and displays the previous terms and exact consented document; its predecessor must be an item in the hash-pinned approved base quotation or an item in a previously consented and authorized variation. Operations authorization is still required for scope execution. The existing Tenant PIC decision pins the variation offer ID, version and PDF hash; that immutable document includes the source hash, changes and predecessors.

A successful Tenant approval creates an immutable `handyman_warranty_term_supersessions` edge for each amendment. A unique predecessor fence prevents competing approved branches, including concurrent writers. A subsequent amendment must refer to the current consented successor, not its superseded ancestor. Offered or rejected changes do not create an edge. The ADD item is identified by the exact affected revised quotation line; it does not amend another line merely because its description resembles one.

## Historical and future certificate boundary

No historical offer, decision, warranty row, coverage row, or date is backfilled. If a historical source lacks `HANDYMAN_QUOTATION_LINE_WARRANTY_V1`, or the applicable exact consent/lineage is missing, its item terms are **undisclosed**, not `NONE` or `BOTH`; an official certificate must treat that item as ineligible until a valid supplemental agreement is obtained. This part does not implement that supplemental-agreement workflow. A newly agreed ADD item does not repair an ambiguous original item.

The end rule is contractual and is not the lifecycle warranty's `expired_at`, which is only the recorded EXPIRE transition. The existing generic WORKMANSHIP/MATERIAL lifecycle rows do not establish individual contractual coverage. Before any future certificate or claim-entitlement calculation, independently verify the exact applicable quotation/variation consent chain, completed item and quantities, an applicable accepted BAST and its actual timestamp, conditions/exclusions and the contractual end rule. A date, issued offer, authorization, generic lifecycle default, or Work Request closure alone must not manufacture coverage or acceptance.
