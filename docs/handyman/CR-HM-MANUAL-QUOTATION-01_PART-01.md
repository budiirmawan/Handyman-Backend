# CR-HM-MANUAL-QUOTATION-01 — PART 01: Unlisted Triage & Manual Quote Readiness

Baseline: `arena/9fdd2eb4-handyman-backend` @ `346888e` (fast-forwarded onto
`arena/47104401-handyman-backend`). Additive only: one new migration (0487),
one new capability on the existing Unlisted Service Intake module, no change to
quotation, dispatch, finance, IAM or catalog semantics.

## 1. What PART 01 adds

Authorized **Operations triage** over the Customer Care unlisted-service intake
case created by CR-HM-CARE-UNLISTED-INTAKE PART 01 (migration 0486), and the
**manual-quotation-readiness projection** PART 02 quotes against.

| Decision (immutable fact) | Projected case status (only legal target) | Branch payload |
| --- | --- | --- |
| `MATCH_EXISTING_CATALOG_SERVICE` | `TRIAGED_CATALOG_MATCHED` | `catalogServiceId` — must already exist, `ACTIVE`, same Client |
| `CREATE_CLIENT_CUSTOM_SERVICE` | `TRIAGED_CLIENT_CUSTOM_SERVICE` | `customServiceName` (+ optional `customServiceNotes`) |
| `ONE_TIME_MANUAL_QUOTATION_REQUIRED` | `TRIAGED_MANUAL_QUOTATION_READY` | `manualQuoteSummary`, `manualQuoteQuantity`, `manualQuoteUomId` |
| `REQUEST_MORE_INFORMATION_OR_INSPECTION` | `AWAITING_INFORMATION` | `clarificationRequest` (exactly one round) |
| `REJECT_UNSUPPORTED` | `REJECTED_UNSUPPORTED` | justification only |

`FUTURE_TRIAGE_DECISIONS` from PART 01 is kept verbatim; the implemented set is
that superset plus the one-time manual quotation branch.

## 2. Migration 0487 (`0487_handyman_unlisted_intake_operations_triage`)

* `handyman_unlisted_intake_triage_decisions` — append-only (UPDATE/DELETE
  blocked by trigger). Stores decision, server-derived `status_after`,
  justification, actor, `triaged_at`, and the Client/Building/Tenant snapshot.
  Scope parity with the intake row, catalog-entry validity (same Client,
  `ACTIVE`), UOM validity, the one-clarification law and the "no
  customer-facing Tenant PIC author" law are all DB-enforced (`23514`).
* `handyman_unlisted_intake_triage_state` — the 1:1 projection anchor
  (`intake_case_id` PRIMARY KEY, `triage_decision_id` UNIQUE NOT NULL,
  `triaged_at`): exactly ONE effective decision per case, and one decision can
  never anchor two cases. Its own trigger re-validates that the anchored
  decision belongs to that case in that Client/Building and is not a
  clarification; DELETE/UPDATE of the anchor is blocked.
* `handyman_unlisted_service_intake_cases` — ONLY the `status` CHECK is widened
  (plus a partial index for the readiness queue) and a `guard_projection`
  UPDATE trigger is added: a status change must be authorized by the case's own
  state row and the immutable decision it anchors (`status_after` must equal
  the status being written), a terminal status can never move again, and
  `PENDING_TRIAGE` can never be re-entered. Intake fields, complaint text,
  visit preference and internal notes stay exactly as 0486 froze them
  (regression-asserted).
* Deliberately NO column is added to the 0486 table and no FK points at it:
  0486's own reversible `down()`/`up()` (exercised by the PART 01 suite)
  recreates that table, and an FK would make its rollback impossible. Every
  0487 binding is therefore enforced by guards, not by declared references.

## 3. HTTP surface (`src/modules/handyman-unlisted-intake/handyman-unlisted-intake.routes.ts`)

* `POST /api/v1/handyman/operations/unlisted-intake-cases/:intakeCaseId/triage-decisions`
  — `authenticationMiddleware` + `requirePermission('tenant_company.manage')`
  (the vocabulary every other Handyman quotation write uses), plus the
  service-side active-user, not-customer-facing and `BUILDING_ACCESS_DENIED`
  (BE-02G exact-Building) checks. Whitelist body: unknown fields are a 400, and
  `status`/`clientId`/`quotationVersionId`/`amount`/`serviceCatalogId` are named
  refusals, never silent ignores. `Idempotency-Key` header or body key.
  201 on record, 200 on exact replay, 409 on key/payload conflict or an
  already-triaged case, 400 on an invalid catalog/UOM anchor.
* `GET /api/v1/handyman/operations/unlisted-intake-cases/:intakeCaseId/triage-decisions`
  — append-only history (clarification round included), composite
  Operations/Care read authority.
* Existing reads now expose `triageDecisionId`, `triagedAt`, `triage`,
  `triageHistory`; the Operations queue filter accepts the widened status
  vocabulary, so `?status=TRIAGED_MANUAL_QUOTATION_READY` is PART 02's intake
  queue.
* Concurrency: per-case `pg_advisory_xact_lock` + `SELECT … FOR UPDATE`; two
  racing decisions yield exactly one 201 and one 409.

## 4. Explicit non-goals (enforced, not merely unimplemented)

* No `service_catalog` row is created by triage (regression-asserted).
* No price, amount or currency is stored by triage — the manual branch records
  a requirement only; there is no fictional price.
* No quotation, quotation version, execution scope, assignment, invoice or
  customer approval is created or bypassed. Approval stays
  `POST /handyman/quotation-versions/:id/decision`; `handyman_service_requests`
  still requires a real catalog anchor.

## 5. Remaining conversion contract — PART 02 (deliberately NOT shortcut here)

Converting a triaged case into a formal `handyman_service_requests` row cannot be
done in the current schema without inventing a fake catalog anchor. PART 02 must
supply, as its own additive migration (0488+):

1. `handyman_service_requests`: nullable `service_catalog_id` paired with a
   server-set `intake_source IN ('CATALOG','UNLISTED_TRIAGE')` and a unique
   `unlisted_intake_case_id` back-reference; a trigger law that
   `intake_source = 'UNLISTED_TRIAGE'` ⇒ `service_catalog_id IS NULL` AND
   `unlisted_intake_case_id IS NOT NULL` AND the referenced case is
   `TRIAGED_MANUAL_QUOTATION_READY` (or `TRIAGED_CATALOG_MATCHED` with its
   anchored `catalog_service_id` copied into the new request). The conversion
   anchor must be read from `handyman_unlisted_intake_triage_state` (the case
   table carries no triage column).
2. Same widening for `handyman_service_request_items.service_catalog_id`
   (0477) if a manual item is materialized, or an explicit decision that manual
   scope lives ONLY on quotation lines.
3. `handyman_unlisted_intake_triage_state.converted_request_id` (+
   `converted_at`), UNIQUE — one conversion per case, immutable, with the
   anchored `triage_decision_id` copied onto the new request as provenance.
4. Conversion authority: same Operations guard, Idempotency-Key + payload hash,
   and a hard refusal when the case is not in a convertible status
   (`PENDING_TRIAGE`, `AWAITING_INFORMATION`, `REJECTED_UNSUPPORTED`,
   `TRIAGED_CLIENT_CUSTOM_SERVICE` → 409 with a reason code; the Client-custom
   branch first needs a governed catalog entry via the existing catalog admin).
5. Quotation lane: the created request uses the EXISTING
   `POST /handyman/requests/:id/quotation` + `POST /handyman/quotation-versions/:id/lines`
   (one-time manual lines, LABOR/MATERIAL, server-computed totals, DP terms) and
   the EXISTING issue/decision surface; `handyman_service_quote_resolutions`
   should gain a `MANUAL` outcome row bound to each manual line so provenance is
   uniform with catalog-priced lines. No second quotation lifecycle.
6. Assignment eligibility unchanged: execution scope only from an APPROVED
   quotation version (`handyman_execution_scopes.approved_quotation_version_id`
   UNIQUE) plus the existing competency/permit/crew gates — triage never grants
   dispatch rights.

## 6. Verification

`tests/handyman-unlisted-intake-triage.test.ts` (9 focused cases: persistence +
audit, the five classifications, duplicate/re-triage and terminal refusal,
RBAC ×4, cross-Client/cross-Building denial + smuggling refusal, idempotent
replay/conflict + concurrency race, no-fake-catalog + no-price, DB laws +
rollback guard, catalog-intake regression, OpenAPI/schema binding).
Regressions: `tests/handyman-unlisted-intake.test.ts`,
`tests/handyman-internal-notes.test.ts`,
`tests/handyman-contract-freeze-03-openapi.test.ts` (surface pin 338 → 340,
annotated-permission pin 223 → 224), and `npm run typecheck`.

---

## 7. PART 02 status (migration 0488 — what §5 promised, and what is left)

IMPLEMENTED in 0488 (`0488_handyman_unlisted_intake_formal_request_conversion`)
plus `POST /api/v1/handyman/operations/unlisted-intake-cases/:intakeCaseId/service-request`:

* `handyman_service_requests.intake_source IN ('CATALOG','UNLISTED_TRIAGE')`;
  `service_catalog_id`/`service_variant_id` are nullable ONLY on the
  `UNLISTED_TRIAGE` lane (the CHECK refuses any value there — no fake catalog),
  `channel_attribution_id` is nullable ONLY on that lane and is preserved
  verbatim when the case carries a verified, still-unused attribution
  (consumed attribution → 409, never reused).
* `handyman_service_requests.unlisted_intake_case_id` UNIQUE +
  `handyman_unlisted_intake_triage_state.converted_request_id` UNIQUE: exactly
  one formal request per case, written once, immutable (manual-origin scope and
  provenance UPDATEs are refused; the status machine stays open).
* Complaint length stays 1..1000 for `CATALOG` rows and 1..2000 for the
  manual lane, so the customer statement is preserved without truncation and no
  catalog rule is relaxed. No column was added to the 0486 table, which keeps
  0486's reversible `down()`/`up()` valid; `0488.down()` fails closed while any
  conversion fact exists.
* Conversion is only from `TRIAGED_MANUAL_QUOTATION_READY` whose anchor decision
  is `ONE_TIME_MANUAL_QUOTATION_REQUIRED`, under the same Operations authority as
  triage (`tenant_company.manage` + active user + not-customer-facing +
  BE-02G exact Building), with advisory lock + case/state row locks +
  Idempotency-Key/payload hash (201, replay 200, 409 on any second conversion).
  Verified identity/scope is re-proved in the same transaction and a lapse fails
  closed (`..._CONVERSION_SCOPE_UNVERIFIED`, `TENANT_VERIFICATION_REQUIRED`).
* Readback: `convertedRequestId` / `convertedAt` on every authorized case read.

STILL OPEN for PART 03 (unchanged gates, so nothing is bypassed):

1. Quotation pricing for the manual lane: `POST /handyman/requests/:id/quotation`
   works because `handyman_quotations` only needs a request, but the
   `INSPECTION_FIRST` posture in `assertHandymanQuotationInspectionReady` is
   resolved from `service_catalog_id` and therefore cannot see a manual-origin
   request — PART 03 must resolve the inspection requirement from the triage
   decision instead, so a manual quotation cannot skip inspection.
2. One-time manual line semantics: `handyman_quotation_lines` has no catalog FK
   (nothing to fake) but also no `MANUAL`/one-time origin; `line_total` is
   already server-computed. PART 03 adds the origin marker + the one-quotation
   cap, plus an optional `MANUAL_REVIEW` row in
   `handyman_service_quote_resolutions` for price-provenance uniformity.
3. `handyman_service_request_items.service_catalog_id NOT NULL` (0477) is
   untouched: manual scope stays on quotation lines only.
4. Assignment/execution gates unchanged (`handyman_execution_scopes` still
   requires an APPROVED quotation version, UNIQUE per version).

## 8. PART 03A status (migration 0489 — manual quotation lines + inspection guard)

CLOSED by PART 03A, with no parallel quotation engine:

* §7.1 — `assertHandymanQuotationInspectionReady` no longer decides readiness
  from `service_catalog_id`/a commercial profile. A request whose
  `intake_source = 'UNLISTED_TRIAGE'` (a) must still be provably the converted
  request of a `TRIAGED_MANUAL_QUOTATION_READY` case anchored to its own
  `ONE_TIME_MANUAL_QUOTATION_REQUIRED` decision (same Client/Building), and (b)
  must carry exactly one `INSPECTED` inspection record in that same scope. No
  authoritative exemption ⇒ refused with `VALIDATION_ERROR` — the gate fails
  closed, it never silently bypasses. Because create, issue and the customer
  APPROVE all call this one function, all three money points are covered. The
  catalog lane (profile `pricing_mode`) is byte-for-byte unchanged.
* §7.2 — `handyman_quotation_lines.origin_kind` (`CATALOG` default |
  `MANUAL_ONE_TIME`) + CHECK + a BEFORE INSERT law (0489): a manual-origin
  version can ONLY hold `MANUAL_ONE_TIME` lines (a `CATALOG` claim asserts a
  catalog anchor that cannot exist), and `MANUAL_ONE_TIME` on the catalog lane
  requires an ALREADY-RECORDED governed `MANUAL_REVIEW` resolution. Part 03A
  therefore reuses `MANUAL_REVIEW` provenance and never writes a resolution or
  an amount of its own. The origin is derived server-side from the request lane
  (a caller-declared `originKind` is only a declaration); it is exposed in the
  management view, the `HANDYMAN_QUOTATION_LINE_ADDED` metadata and the DB, but
  deliberately NOT in `HandymanQuotationLineCustomerProjection`.
* Many manual lines per version are supported (LABOR + MATERIAL, mixed with
  catalog lines where the contract permits). The one-quotation-thread cap needed
  no new rule: `handyman_quotations.handyman_request_id` is already UNIQUE
  (0391), so the lane keeps one thread per request, not one line per request.
* DRAFT-only edits, server-derived `line_total`, one currency per version,
  issued-line immutability, Client/Building + assignment gates and the customer
  decision flow are unchanged. 0489 `down()` is refused while any
  `MANUAL_ONE_TIME` row exists (audited commercial fact).

STILL OPEN for PART 03B: revision DP recomputation for manual versions, and the
Scope Variation (ADD/REMOVE) companion over a manual-origin quotation.
