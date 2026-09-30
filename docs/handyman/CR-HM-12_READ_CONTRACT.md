# CR-HM-12 PART 05 — Published Pricing/Commercial Read Contract

Status: PUBLISHED (PART 05), EXTENDED (PART 06B — §5 below). Authority
law: FROZEN `CR-HM-12_START_GOVERNANCE.md` §4–§8, §10 row 05, Handoff;
prerequisite extension FROZEN `CR-HM-12_PART_06_BM_FEE_PREREQUISITE.md`
§4/§5, authorized by `CR-HM-14_PREREQUISITE_DECISION_BM_FEE.md` §2/§3/§5
and certified by `CR-HM-12_PART_06_FINAL_CERTIFICATION.md`.

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
| `readHandymanBmFeeConfigurationAt(clientId, asOf)` **(PART 06B, additive)** | Same exact-version `binding` + rule view, PLUS the version-bound numeric term and the explicit financial beneficiary (each `null` when unconfigured) with `unconfiguredSlots` and the composite authority flag — see §5 | CR-HM-14 |

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

## 5. PART 06B — BM fee prerequisite extension (PUBLISHED, additive)

Status: PUBLISHED (PART 06B). Authority law: FROZEN
`CR-HM-12_PART_06_BM_FEE_PREREQUISITE.md` §4/§5; certified by
`CR-HM-12_PART_06_FINAL_CERTIFICATION.md`.

**What is added.** Two version-bound prerequisite facts — the numeric
BM fee **term** (`PERCENTAGE_OF_BASIS`, canonical decimal rate) and the
explicit financial **beneficiary** (`CLIENT_ORGANIZATION` = the bound
version's own client) — persisted by migration 0415 (PART 06A) and
authored/read inside the existing CR-HM-12 boundary (PART 06B).
Authoring: `prepareHandymanBmFeeTerm`, `prepareHandymanBmFeeBeneficiary`
(DRAFT-window, append-only, exactly one per agreement version, single-use
idempotency key, replay returns the SAME fact); exact reads:
`getHandymanBmFeeTermForVersion`, `getHandymanBmFeeBeneficiaryForVersion`
(`null` when unconfigured).

**The published configuration read.**

```text
readHandymanBmFeeConfigurationAt(clientId, asOf)
  -> { binding, rule, term | null, beneficiary | null,
       unconfiguredSlots, authoritativeForEntitlement,
       factKind: 'CR_HM_12_BASIS_FACT', isFinalCharge: false }
```

- `binding` / `rule` are the **unchanged** PART 05 shapes;
  `readHandymanBmFeeRuleConsumptionAt` and its semantics
  (`authoritativeForEntitlement === (mode === 'DEFAULT')`) are
  byte-compatible and untouched.
- `term` = `{ termRowId, agreementVersionId, termKind, ratePercent,
  factKind }` with `ratePercent` a **canonical decimal string** (exactly
  4 decimals, e.g. `"2.5000"`) — never a float, never a currency, never
  an amount.
- `beneficiary` = `{ beneficiaryRowId, agreementVersionId,
  beneficiaryKind, beneficiaryReferenceId, factKind }` — an identity
  fact, never a payout/rail/bank instruction.
- `unconfiguredSlots` is the **sorted** subset of
  `HANDYMAN_PRICING_CONTRACT_BM_FEE_UNCONFIGURED_SLOTS`
  (`TERM`, `BENEFICIARY`); empty iff both are configured.
- `authoritativeForEntitlement` is the composite gate: `rule.mode ===
  'DEFAULT'` **AND** term present **AND** beneficiary present.

**Consumption law (frozen).**

1. **Version-exact.** The term and beneficiary are read for the exact
   version resolved through the PART 01 anchor (CR-HM-14 passes the
   ledger transaction's posted instant as `asOf`); "latest", silent
   defaults, and cross-version fallbacks are FORBIDDEN.
2. **Fail-closed, machine-readable.** A missing **rule** keeps the
   existing bounded `HANDYMAN_BM_FEE_RULE_NOT_EFFECTIVE` refusal. A
   missing **term** or **beneficiary** does NOT throw: the slot is
   published as explicit `null`, listed in `unconfiguredSlots`, and the
   configuration is non-authoritative. **`null` is never zero, never
   0 %, and never "use the reference model"** — CR-HM-14 must refuse a
   fee fact with a bounded error until the slot is configured.
3. **Nothing here is a value.** The read publishes a rate and a payee
   identity only — no fee amount, no computed figure, no entitlement or
   settlement state, no currency.
4. **Identity is never inferred.** The beneficiary is the bound
   version's own governed client, recorded explicitly; no channel
   attribution, vendor/PIC, workforce, client lookup, free text, or
   caller input can supply it (`CLIENT_MISMATCH` otherwise).
5. **Read-only / zero coupling.** The contract module still imports no
   database layer and holds zero SQL; the authoring DAL lives in
   `handyman-bm-fee-rules` exactly as PART 04's does. No ledger
   (CR-HM-13), SaaS/platform/entitlement, or FM module, table, column,
   import, or vocabulary is reachable; no HTTP/OpenAPI surface exists.

**Firewall verification (PART 06B law).** Enforced by
`tests/handyman-bm-fee-prerequisite-persistence.test.ts` (PART 06A:
columns, DRAFT window, append-only, cardinality, bounds, same-client
chain, FK footprint, executed `down`/`up`) and
`tests/handyman-bm-fee-prerequisite-configuration.test.ts` (PART 06B:
authoring law, exact reads, fail-closed slots, PART 05 byte
compatibility, no valuation / no ledger / no SaaS-FM / no HTTP scans).
