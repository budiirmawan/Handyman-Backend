# CR-HM-12 PART 05 — Published Pricing/Commercial Read Contract

Status: PUBLISHED (PART 05). Authority law: FROZEN
`CR-HM-12_START_GOVERNANCE.md` §4–§8, §10 row 05, Handoff.

## 1. What is published

Module: `src/modules/handyman-pricing-contract/` — a READ-ONLY
composition over the PART 01–04 surfaces. It owns no table, no
vocabulary, no mutation, no HTTP, and no database import: it is
structurally incapable of writing (not a second write path).

| Function | Purpose | Primary consumer |
| --- | --- | --- |
| `readHandymanPricingContractAt(clientId, asOf)` | Per-version bundle: exact ACTIVE agreement version + its frozen LABOR basis set, MATERIAL basis definition, BM fee rule (explicit `null` when a slot is undefined) | CR-HM-06, CR-HM-17 |
| `readHandymanLaborPricingEvaluationAt(clientId, asOf, mode, input)` | Pure rule application (PART 02 evaluator) anchored to the exact version; result is a basis fact | CR-HM-13 (charge preparation), CR-HM-17 previews |
| `readHandymanMaterialPricingCompositionAt(clientId, executionScopeId, asOf, actorUserId)` | PART 03 READ-ONLY scope composition (CR-HM-09 settled quantities × CR-HM-06 snapshot amounts), cross-checked against the caller's version anchor | CR-HM-13 |
| `readHandymanBmFeeRuleConsumptionAt(clientId, asOf)` | Fail-closed BM fee rule read with the DEFAULT/REFERENCE authority flag | CR-HM-14 |

## 2. Consumption rules (frozen)

1. **Exact version or nothing.** Every read resolves through the
   PART 01 anchor: fail-closed as-of or bounded error — never
   "latest", never a silent default (§4.5). Persist `binding`
   (clientId, agreementId, agreementVersionId, versionNumber,
   window) with any derived fact (B6).
2. **Reference ≠ final.** A `bmFeeRule` with
   `authoritativeForEntitlement: false` (mode `REFERENCE`) must
   never feed entitlement derivation; only `DEFAULT` rules are
   authoritative for CR-HM-14 (§7, matrix row 21).
3. **Nothing here is a charge.** Every figure carries
   `factKind: 'CR_HM_12_BASIS_FACT'` and `isFinalCharge: false`.
   Charge/ledger/payment authority remains CR-HM-13's; posting is
   never a CR-HM-12 output.
4. **Bases never merge.** LABOR and MATERIAL are separate fields;
   any combined total is CR-HM-13's own ledger composition (§6/B10).
5. **No SaaS computation.** The contract module imports no SaaS
   platform surface; no package/subscription/pricebook state can
   enter any published figure (§7, B8).
6. **Approved snapshots stay immutable.** CR-HM-06 may consume
   these reads for governed adjustments, but never reprice an
   approved quotation version in place (F5 firewall: publication is
   read-direction only).

## 3. What is deliberately NOT published here

- Fee VALUE / entitlement derivation (CR-HM-14), settlement,
  reconciliation.
- Charge posting, payments, refunds, ledger rows (CR-HM-13).
- Any write path, mutation verb, lifecycle call, or HTTP/OpenAPI
  surface — the module exports the read family only.
- Billable-time fabrication: `billableTimeBasis` is a rule field;
  time inputs arrive from CR-HM-08/CR-HM-04 governed data supplied
  by the caller to the evaluator.

## 4. Firewall verification (PART 05 law)

Enforced by `tests/handyman-pricing-contract.test.ts`: frozen
read-family export surface, zero DB capability (no `pg`/`knex`/
`src/database` import), reference≠final end-to-end, version-exact
supersession switching with historical immutability, fail-closed
postures, cross-scope binding guard, no-SaaS/no-HTTP source scans,
and byte-stable row counts under the full read battery (no second
write path).
