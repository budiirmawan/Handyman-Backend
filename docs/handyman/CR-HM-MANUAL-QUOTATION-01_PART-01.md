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
