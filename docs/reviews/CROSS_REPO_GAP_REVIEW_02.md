# CROSS-REPOSITORY BUSINESS-CHAIN GAP REVIEW 02

## 1. Executive Summary

**Audit date:** 2026-08-18

**Decision:** **HOLD BE-28**

**Backend baseline:** `2810f1d83675caefc269a5852a9998ee9fc1fbc0` (`main`, merged PR #30 / BE-27)

**Audited implementation repository:** `budiirmawan/Asentra-Backend`

The Backend has broad operational foundations, but the requested end-to-end business authorities are not complete. Commercial procurement stops at purchase-order readiness rather than an actual commitment, does not ensure the selected vendor is the Work Order vendor, and has no distinct vendor invoice, invoice verification, or payment-readiness authority. Material quantity control is strong after stock entry, but demand-to-order-to-receipt line identity, remaining-quantity enforcement, valuation, and Work Order material cost are absent. Tenant electricity and water are traceable, while parking and service-charge assessment are not dedicated authorities and settlement is a manually maintained cumulative snapshot rather than a payment/allocation authority.

Operational correction is split between Finding and BE-21 Incident/Corrective Action lifecycles even though Finding/Workflow must be reused. External Permit-to-Work is substantial, but is not bound to source assignment, Vendor Work, compliance blocking, verification, or BAST. BE-22 declares one authoritative BAST yet has no BAST transition API; sign-off does not change BAST status; legacy Vendor BAST transitions independently; and compatibility synchronization suppresses failures.

BE-27 configuration administration, lifecycle, isolation, audit, effective reads, and OpenAPI are substantially implemented in Backend. End-to-end readiness is still unproven: `/auth/me` and `docs/api/mobile-contract.md` do not expose effective configuration/workspaces, no configuration-change notification delivery was found, and the Web/Mobile repositories were unavailable. Most legacy business-chain routes are absent from the incremental OpenAPI contract.

| Classification | Count |
|---|---:|
| `READY` | 15 |
| `PARTIAL` | 46 |
| `MISSING` | 20 |
| `FUTURE_WAVE` | 1 |
| `CR_REQUIRED` | 26 |
| **Total capabilities** | **108** |

A `READY` row means the audited capability itself has an authoritative implementation and adequate local evidence. Repository columns remain independent: a Backend-ready row can still show an OpenAPI or consumer evidence gap. No cross-repository release should treat `READY` as proof of a Web or Mobile implementation when those repositories were not available.

## 2. Scope, Baselines, and Evidence Availability

| Artifact | Latest evidenced baseline | Audit status | Consequence |
|---|---|---|---|
| Asentra Backend | Commit `2810f1d83675caefc269a5852a9998ee9fc1fbc0`; merged PR #30 / BE-27 | Verified locally and against remote `main` | Implementation, migrations, routes, tests, and governance could be traced. |
| OpenAPI | `docs/api/openapi.yaml` at the same Backend commit | Verified locally | Strong BE-24–BE-27 incremental coverage; most legacy business-chain routes are omitted. |
| Asentra Frontend Web | No local checkout or visible applicable GitHub repository | Not evidenced | UI/API consumption, action rendering, stable-ID use, and configuration behavior cannot be certified. |
| Asentra Mobile | No local checkout or visible applicable GitHub repository | Not evidenced | Flutter contract use, offline/context behavior, available actions, and effective configuration cannot be certified. |
| Graha Mampang business requirements/baseline | No dedicated document or issue found in accessible evidence | Missing | Business acceptance rules, priorities, tolerances, and deferrals cannot be reconciled to an approved baseline. |
| Prior governance | BE-24, BE-25, BE-26, BE-27 governance; API checkpoint and CR-BE-API-01 governance | Verified | Useful technical intent, but not a substitute for implementation traces or a Graha Mampang business baseline. |

The audit did not infer completeness from route names, model names, screens, PR titles, or roadmap labels. It traced services, types, migrations, route mounting, tests, and contract paths. This review does not implement fixes, change APIs, create migrations, regenerate OpenAPI, start BE-28, or propose Full Accounts Payable, General Ledger, tax, payroll, or full ERP scope.

## 3. Method, Status Rules, and Audit Limitations

### Classification

- `READY`: one authoritative capability is implemented with enforceable state/context rules and representative evidence.
- `PARTIAL`: a useful implementation exists, but a required rule, reference, read contract, or contract surface is incomplete.
- `MISSING`: no authoritative implementation was found for the requested capability.
- `FUTURE_WAVE`: explicitly deferrable from the minimum pre-BE-28 control boundary.
- `CR_REQUIRED`: the current design has an authority conflict, cross-chain/cross-repository binding gap, or release-blocking contract gap that should be resolved through a targeted change request rather than an incidental patch.

### Repository status codes

- `V`: verified implementation/contract in the audited repository.
- `P`: partial implementation/contract.
- `M`: missing implementation/contract.
- `NE`: not evidenced because the repository/baseline was unavailable.
- `NA`: not applicable to that consumer for the narrowly stated capability.

### Priority and ownership

- `P0`: blocks BE-28 entry or prevents safe end-to-end authority/integration.
- `P1`: required for complete operational control but may follow the P0 authority boundary.
- `P2`: useful extension that does not block the minimum controlled chain.
- Owners are accountable roles, not inferred individuals: Product/Business, Backend, API Governance, Web, Mobile, Finance Operations, Procurement, Engineering Operations, HSE/Operations, and Architecture.

### Limitations

1. Web and Mobile statuses are `NE`, not assumptions that code is absent.
2. No dedicated Graha Mampang acceptance baseline was available; the review therefore cannot certify local business-rule fit.
3. OpenAPI was audited as the checked-in contract. Route existence in Backend does not count as a published contract.
4. This was an evidence audit, not a production-data reconciliation or UI acceptance test.

## 4. Master Capability Matrix

**Gap references** resolve to the detailed register in section 13. A priority on an otherwise `READY` Backend capability can reflect its independent OpenAPI/consumer gap.

| ID | Chain | Capability | Backend | OpenAPI | Web | Mobile | Classification | Priority | Owner | Gap ref |
|---|---|---|:---:|:---:|:---:|:---:|---|:---:|---|---|
| C-01 | Commercial | PR/SR/MR request records and scoped reads | V | M | NE | NE | `PARTIAL` | P0 | Backend / API Governance | API-01 |
| C-02 | Commercial | Procurement approval records and decisions | V | M | NE | NE | `PARTIAL` | P0 | Procurement / API Governance | API-01 |
| C-03 | Commercial | Vendor eligibility/capability foundations | V | M | NE | NE | `PARTIAL` | P1 | Procurement / API Governance | API-01 |
| C-04 | Commercial | Vendor selection/review | V | M | NE | NE | `PARTIAL` | P0 | Procurement / API Governance | API-01 |
| C-05 | Commercial | Purchase-order readiness | V | M | NE | NE | `PARTIAL` | P0 | Procurement / API Governance | API-01 |
| C-06 | Commercial | Actual Purchase Order commitment and lines | M | M | NE | NE | `MISSING` | P0 | Procurement / Backend | COM-01 |
| C-07 | Commercial | SPK / service-order commitment | M | M | NE | NE | `MISSING` | P0 | Procurement / Backend | COM-01 |
| C-08 | Commercial | Enforced request-selection-commitment-WO binding | P | M | NE | NE | `CR_REQUIRED` | P0 | Procurement / Backend | COM-01, TRACE-01 |
| C-09 | Commercial | Vendor assignment to Work Order | V | M | NE | NE | `PARTIAL` | P0 | Backend / API Governance | COM-01, API-01 |
| C-10 | Commercial | Vendor Work execution lifecycle | V | M | NE | NE | `PARTIAL` | P0 | Engineering Operations / API Governance | API-01 |
| C-11 | Commercial | Vendor execution evidence | V | M | NE | NE | `PARTIAL` | P1 | Engineering Operations / API Governance | API-01 |
| C-12 | Commercial | Vendor completion report | V | M | NE | NE | `PARTIAL` | P0 | Engineering Operations / API Governance | API-01 |
| C-13 | Commercial | Vendor service report | V | M | NE | NE | `PARTIAL` | P1 | Engineering Operations / API Governance | API-01 |
| C-14 | Commercial | Verification and rework | V | M | NE | NE | `PARTIAL` | P0 | Engineering Operations / API Governance | API-01 |
| C-15 | Commercial | Authoritative BAST lifecycle | P | M | NE | NE | `CR_REQUIRED` | P0 | Backend / Engineering Operations | BAST-01 |
| C-16 | Commercial | Acceptance sign-off governed by BAST state | P | M | NE | NE | `CR_REQUIRED` | P0 | Backend / Engineering Operations | BAST-01 |
| C-17 | Commercial | Vendor/service cost record | V | M | NE | NE | `PARTIAL` | P1 | Finance Operations / API Governance | API-01 |
| C-18 | Commercial | Distinct vendor invoice | M | M | NE | NE | `MISSING` | P0 | Finance Operations / Backend | COM-02 |
| C-19 | Commercial | Vendor invoice verification | M | M | NE | NE | `MISSING` | P0 | Finance Operations / Backend | COM-02 |
| C-20 | Commercial | Payment readiness and status | M | M | NE | NE | `MISSING` | P0 | Finance Operations / Backend | COM-02 |
| C-21 | Commercial | Commercial closure gate | M | M | NE | NE | `CR_REQUIRED` | P0 | Procurement / Finance Operations | COM-02, BAST-01 |
| C-22 | Commercial | Stable end-to-end commercial read projection | M | M | NE | NE | `CR_REQUIRED` | P0 | Backend / API Governance | TRACE-01, API-01 |
| M-01 | Material | Material Request authority | V | M | NE | NE | `PARTIAL` | P0 | Engineering Operations / API Governance | API-01 |
| M-02 | Material | MR-to-procurement ordered-line binding | M | M | NE | NE | `CR_REQUIRED` | P0 | Procurement / Backend | MAT-01, TRACE-01 |
| M-03 | Material | Material purchase commitment/ordered lines | M | M | NE | NE | `MISSING` | P0 | Procurement / Backend | MAT-01 |
| M-04 | Material | Receiving against ordered lines and remaining quantity | P | M | NE | NE | `CR_REQUIRED` | P0 | Warehouse / Backend | MAT-01 |
| M-05 | Material | Atomic stock-in/stock-out movement authority | V | M | NE | NE | `PARTIAL` | P0 | Warehouse / API Governance | API-01 |
| M-06 | Material | Authoritative stock balance | V | M | NE | NE | `PARTIAL` | P0 | Warehouse / API Governance | API-01 |
| M-07 | Material | Transfer and adjustment transactions | V | M | NE | NE | `PARTIAL` | P1 | Warehouse / API Governance | API-01 |
| M-08 | Material | Work Order issue/usage quantity | V | M | NE | NE | `PARTIAL` | P0 | Warehouse / API Governance | API-01 |
| M-09 | Material | Inventory valuation and WO material cost | M | M | NE | NE | `MISSING` | P1 | Finance Operations / Backend | MAT-02 |
| M-10 | Material | Stable material fulfilment/cost read projection | M | M | NE | NE | `CR_REQUIRED` | P1 | Backend / API Governance | TRACE-01, API-01 |
| R-01 | Tenant revenue | Electricity reading-calculation-bill chain | V | M | NE | NE | `PARTIAL` | P0 | Utility Operations / API Governance | API-01 |
| R-02 | Tenant revenue | Water reading-calculation-bill chain | V | M | NE | NE | `PARTIAL` | P0 | Utility Operations / API Governance | API-01 |
| R-03 | Tenant revenue | Utility Bill-to-Invoice stable source/snapshot | V | M | NE | NE | `PARTIAL` | P0 | Finance Operations / API Governance | API-01 |
| R-04 | Tenant revenue | Dedicated parking charge lifecycle | M | M | NE | NE | `MISSING` | P0 | Product / Finance Operations | REV-01 |
| R-05 | Tenant revenue | Service-charge readiness/effective period | V | M | NE | NE | `PARTIAL` | P0 | Finance Operations / API Governance | API-01 |
| R-06 | Tenant revenue | Service-charge calculation and allocation | M | M | NE | NE | `MISSING` | P0 | Product / Finance Operations | REV-01 |
| R-07 | Tenant revenue | Other charge through generic Tenant Charge | V | M | NE | NE | `PARTIAL` | P1 | Finance Operations / API Governance | API-01 |
| R-08 | Tenant revenue | Charge-to-Invoice composition/finalization | V | M | NE | NE | `PARTIAL` | P0 | Finance Operations / API Governance | API-01 |
| R-09 | Tenant revenue | Invoice source exclusivity and amount snapshot | V | M | NE | NE | `PARTIAL` | P0 | Finance Operations / API Governance | API-01 |
| R-10 | Tenant revenue | Cumulative invoice payment-status snapshot | P | M | NE | NE | `PARTIAL` | P0 | Finance Operations / Backend | REV-02, API-01 |
| R-11 | Tenant revenue | Authoritative payment transaction | M | M | NE | NE | `MISSING` | P0 | Finance Operations / Backend | REV-02 |
| R-12 | Tenant revenue | Payment allocation across invoice(s) | M | M | NE | NE | `MISSING` | P0 | Finance Operations / Backend | REV-02 |
| R-13 | Tenant revenue | Receipt issue/void with settlement reversal | P | M | NE | NE | `PARTIAL` | P0 | Finance Operations / Backend | REV-02, API-01 |
| R-14 | Tenant revenue | Authoritative outstanding balance | P | M | NE | NE | `CR_REQUIRED` | P0 | Finance Operations / Backend | REV-02 |
| R-15 | Tenant revenue | Aging buckets/as-of aging read | M | M | NE | NE | `MISSING` | P1 | Finance Operations / Backend | REV-03 |
| R-16 | Tenant revenue | Invoice/charge dispute lifecycle | M | M | NE | NE | `MISSING` | P1 | Finance Operations / Backend | REV-03 |
| R-17 | Tenant revenue | Credit/debit adjustment and write-off control | M | M | NE | NE | `MISSING` | P1 | Finance Operations / Backend | REV-03 |
| R-18 | Tenant revenue | Basic financial reporting | V | M | NE | NE | `PARTIAL` | P1 | Finance Operations / API Governance | REV-03, API-01 |
| R-19 | Tenant revenue | Bank-statement reconciliation automation | M | M | NE | NE | `FUTURE_WAVE` | P2 | Finance Operations / Product | REV-04 |
| R-20 | Tenant revenue | Stable revenue subledger/read contract and OpenAPI | M | M | NE | NE | `CR_REQUIRED` | P0 | Backend / API Governance | TRACE-01, API-01, REV-02 |
| O-01 | Operational correction | Incident/defect/finding intake | V | P | NE | NE | `PARTIAL` | P0 | Engineering Operations / API Governance | OPS-01, API-01 |
| O-02 | Operational correction | Reusable Finding/Workflow state authority | V | P | NE | NE | `PARTIAL` | P0 | Engineering Operations / API Governance | OPS-01, API-01 |
| O-03 | Operational correction | Finding escalation to Incident visibility | P | M | NE | NE | `PARTIAL` | P0 | Engineering Operations / Backend | OPS-01, API-01 |
| O-04 | Operational correction | Immediate action | V | M | NE | NE | `PARTIAL` | P1 | Engineering Operations / API Governance | API-01 |
| O-05 | Operational correction | Investigation readiness metadata | V | M | NE | NE | `PARTIAL` | P0 | Engineering Operations / API Governance | OPS-01, API-01 |
| O-06 | Operational correction | Persisted investigation and root cause | M | M | NE | NE | `MISSING` | P0 | Engineering Operations / Backend | OPS-01 |
| O-07 | Operational correction | Finding-governed corrective-action lifecycle | P | M | NE | NE | `CR_REQUIRED` | P0 | Engineering Operations / Backend | OPS-01 |
| O-08 | Operational correction | Responsibility and due date | V | M | NE | NE | `PARTIAL` | P0 | Engineering Operations / API Governance | API-01 |
| O-09 | Operational correction | Corrective Action-to-Work Order binding | M | M | NE | NE | `MISSING` | P0 | Engineering Operations / Backend | OPS-01, TRACE-01 |
| O-10 | Operational correction | Corrective Action evidence binding | M | M | NE | NE | `MISSING` | P0 | Engineering Operations / Backend | OPS-01, TRACE-01 |
| O-11 | Operational correction | Verification and rework | V | M | NE | NE | `PARTIAL` | P0 | Engineering Operations / API Governance | OPS-01, API-01 |
| O-12 | Operational correction | Unified audit/timeline | P | M | NE | NE | `CR_REQUIRED` | P0 | Backend / Engineering Operations | OPS-01, TRACE-01 |
| O-13 | Operational correction | One closure authority | P | M | NE | NE | `CR_REQUIRED` | P0 | Backend / Engineering Operations | OPS-01 |
| O-14 | Operational correction | Stable read and available-actions OpenAPI | P | P | NE | NE | `CR_REQUIRED` | P0 | Backend / API Governance | API-01, API-02, OPS-01 |
| E-01 | External work | Tenant contractor context | V | M | NE | NE | `PARTIAL` | P0 | HSE/Operations / API Governance | API-01 |
| E-02 | External work | Vendor contractor context | V | M | NE | NE | `PARTIAL` | P0 | HSE/Operations / API Governance | API-01 |
| E-03 | External work | Vendor compliance/document/license registry | V | M | NE | NE | `PARTIAL` | P0 | Procurement / HSE / API Governance | EXT-01, API-01 |
| E-04 | External work | Effective compliance validity and hard blocking | P | M | NE | NE | `CR_REQUIRED` | P0 | Procurement / HSE / Backend | EXT-01 |
| E-05 | External work | Source request/assignment-to-Permit stable binding | M | M | NE | NE | `MISSING` | P0 | HSE/Operations / Backend | EXT-01, TRACE-01 |
| E-06 | External work | Permit application | V | M | NE | NE | `PARTIAL` | P0 | HSE/Operations / API Governance | API-01 |
| E-07 | External work | Permit approval/rejection | V | M | NE | NE | `PARTIAL` | P0 | HSE/Operations / API Governance | API-01 |
| E-08 | External work | Permit validity window | V | M | NE | NE | `PARTIAL` | P0 | HSE/Operations / API Governance | API-01 |
| E-09 | External work | Worker authorization | V | M | NE | NE | `PARTIAL` | P0 | HSE/Operations / API Governance | API-01 |
| E-10 | External work | Equipment declaration/control | V | M | NE | NE | `PARTIAL` | P1 | HSE/Operations / API Governance | API-01 |
| E-11 | External work | Safety/evidence readiness | V | M | NE | NE | `PARTIAL` | P0 | HSE/Operations / API Governance | API-01 |
| E-12 | External work | Permit work start/close execution | V | M | NE | NE | `PARTIAL` | P0 | HSE/Operations / API Governance | EXT-02, API-01 |
| E-13 | External work | Vendor Work-to-authoritative Permit binding | P | M | NE | NE | `CR_REQUIRED` | P0 | Backend / HSE/Operations | EXT-01, TRACE-01 |
| E-14 | External work | External-work verification/rework | M | M | NE | NE | `MISSING` | P0 | HSE/Operations / Backend | EXT-02 |
| E-15 | External work | Permit/assignment-to-BAST acceptance binding | M | M | NE | NE | `CR_REQUIRED` | P0 | HSE/Operations / Backend | EXT-02, BAST-01 |
| E-16 | External work | Stable external-work read/closure contract | M | M | NE | NE | `CR_REQUIRED` | P0 | Backend / API Governance | TRACE-01, API-01, EXT-02 |
| Q-01 | Configuration | Client/building scoped configuration values | V | V | NE | NE | `READY` | — | Backend | — |
| Q-02 | Configuration | Module and feature entitlement configuration | V | V | NE | NE | `READY` | — | Backend | — |
| Q-03 | Configuration | Navigation and workspace registries | V | V | NE | NE | `READY` | — | Backend | — |
| Q-04 | Configuration | Dashboards and widgets | V | V | NE | NE | `READY` | — | Backend | — |
| Q-05 | Configuration | Form and checklist administration | V | V | NE | NE | `READY` | — | Backend | — |
| Q-06 | Configuration | Operational settings | V | V | NE | NE | `READY` | — | Backend | — |
| Q-07 | Configuration | Organization presentation, CMS, and branding | V | V | NE | NE | `READY` | — | Backend | — |
| Q-08 | Configuration | Immutable version snapshots | V | V | NE | NE | `READY` | — | Backend | — |
| Q-09 | Configuration | Validate-publish-activate lifecycle | V | V | NE | NE | `READY` | — | Backend | — |
| Q-10 | Configuration | Effective preview across all configured domains | P | P | NE | NE | `PARTIAL` | P1 | Backend / API Governance | CFG-01 |
| Q-11 | Configuration | Client/building effective scoped reads | V | V | NE | NE | `READY` | — | Backend | — |
| Q-12 | Configuration | Tenant isolation and permission enforcement | V | V | NE | NE | `READY` | — | Backend | — |
| Q-13 | Configuration | Append-only configuration audit | V | V | NE | NE | `READY` | — | Backend | — |
| Q-14 | Configuration | Backend-authoritative lifecycle available actions | P | P | NE | NE | `PARTIAL` | P1 | Backend / API Governance | API-02 |
| Q-15 | Configuration | Selected effective context via `/auth/me`/mobile contract | M | M | NE | NE | `CR_REQUIRED` | P0 | Backend / Mobile / API Governance | CFG-01 |
| Q-16 | Configuration | Web Configuration Studio and runtime consumption | NA | V | NE | NA | `CR_REQUIRED` | P0 | Web | GOV-02, CFG-02 |
| Q-17 | Configuration | Mobile effective configuration consumption | NA | V | NA | NE | `CR_REQUIRED` | P0 | Mobile | GOV-03, CFG-02 |
| Q-18 | Configuration | Configuration-change notification delivery | P | P | NE | NE | `CR_REQUIRED` | P1 | Backend / Web / Mobile | CFG-03 |
| Q-19 | Configuration | BE-27 OpenAPI administration/effective contracts | V | V | NE | NE | `READY` | — | API Governance | — |
| X-01 | Governance | Approved Graha Mampang business baseline | M | NA | NE | NE | `MISSING` | P0 | Product / Business | GOV-01 |
| X-02 | Governance | Backend baseline and executable evidence | V | V | NA | NA | `READY` | — | Backend / Architecture | — |
| X-03 | Cross-chain | Full implemented-route OpenAPI coverage | P | P | NE | NE | `CR_REQUIRED` | P0 | API Governance / Backend | API-01 |
| X-04 | Cross-chain | Web implementation/baseline evidence | NA | V | NE | NA | `CR_REQUIRED` | P0 | Web / Architecture | GOV-02 |
| X-05 | Cross-chain | Mobile implementation/baseline evidence | NA | V | NA | NE | `CR_REQUIRED` | P0 | Mobile / Architecture | GOV-03 |
| X-06 | Cross-chain | Stable IDs and read projections across authorities | P | M | NE | NE | `CR_REQUIRED` | P0 | Backend / API Governance | TRACE-01 |
| X-07 | Cross-chain | Backend client/building scope and RBAC foundation | V | V | NE | NE | `READY` | — | Backend | — |

## 5. Commercial Procurement Chain

### Proven foundations

- Purchase Request, Material Request, and Service Request records; procurement approval; vendor eligibility/capability; vendor selection review; and purchase-order readiness are implemented.
- A Work Order can have a procurement binding to a PR, MR, SR, and receiving reference. Vendor assignment, Vendor Work, work evidence, completion/service reports, verification/rework, BAST/document records, and vendor service costs also exist.
- These modules provide reusable identities and events; a replacement mega-model is neither necessary nor recommended.

### Authority and binding failures

1. Purchase-order readiness is a declaration of readiness, not an actual PO. No authoritative PO header/lines, commercial terms, remaining commitment, or SPK/service order was found.
2. `vendor-assignments` validates active Vendor/Building/Client context independently of vendor selection, PO readiness, and the Work Order procurement binding. It does not prove that the selected/committed vendor became the assigned vendor.
3. The Work Order procurement binding permits only one binding and does not form an enforced request → selected vendor → commitment → assigned Work Order chain.
4. Vendor Service Cost is an operational cost record, not a vendor invoice. Distinct vendor invoice, verification, payment readiness/status, and commercial closure authorities are absent. The requested minimum is controlled vendor settlement visibility, not Full Accounts Payable.
5. BE-22 BAST is P0-inconsistent: `bast_documents.acceptance_status` is created as `DRAFT`, but no transition API exists. Acceptance Sign-Off can record multiple decisions without a BAST state gate or BAST update. Legacy Vendor BAST has separate transition authority, and its compatibility synchronization is best-effort with suppressed errors.

**Conclusion:** extensive foundations, but no enforceable commercial commitment-to-settlement chain. `COM-01`, `COM-02`, and `BAST-01` must be resolved before BE-28.

## 6. Material and Operational Cost Chain

### Proven foundations

- Material Request captures scoped demand.
- Material receiving validates PO-readiness for its PR/SR source and writes an authoritative inventory stock-in movement.
- Inventory movements, balances, transfers, adjustments, and Work Order material usage provide atomic quantity control with non-negative balance checks.

### Missing fulfilment and cost authority

1. Material Request is not the ordered-line authority and is not stably related to PR/SR ordered lines.
2. Receiving targets a PR or SR readiness record, not a Material Request/PO line. It cannot enforce ordered-versus-received remaining quantity or reliably prevent over-receipt at line level.
3. Work Order material usage records quantity and resulting balances only. There is no unit-cost layer, valuation snapshot, cost-lot rule, or authoritative material-cost total for the Work Order.
4. Vendor Service Cost is separate and must not be used as a proxy for inventory consumption value.

**Conclusion:** quantity inventory is reusable and strong; `MAT-01` should add narrow line references and quantity controls, while `MAT-02` adds valuation snapshots/read output without creating a general accounting system.

## 7. Tenant Revenue Chain

### Source-by-source result

| Revenue source | Charge authority | Invoice trace | Settlement/outstanding | Result |
|---|---|---|---|---|
| Electricity | Finalized utility calculation and `UTILITY_BILL` | Stable Utility Bill line with amount snapshot | Shared manual payment-status snapshot | `PARTIAL` |
| Water | Finalized utility calculation and `UTILITY_BILL` | Stable Utility Bill line with amount snapshot | Shared manual payment-status snapshot | `PARTIAL` |
| Parking | No dedicated parking billing lifecycle | Only possible as a generic Tenant Charge | Shared manual payment-status snapshot | `MISSING` |
| Service charge | Readiness/effective-period record; no assessment calculation/allocation | Optional generic Tenant Charge binding | Shared manual payment-status snapshot | `MISSING` |
| Other charge | Generic Tenant Charge with free-form charge type | Stable Tenant Charge line with amount snapshot | Shared manual payment-status snapshot | `PARTIAL` |

### Settlement findings

- Tenant Invoice accepts only `TENANT_CHARGE` and `UTILITY_BILL` line types. The amount snapshot and source exclusivity are useful foundations.
- `invoice_payment_status` is one mutable cumulative record per finalized invoice. It records `paidAmount`, `outstandingAmount`, and a reference supplied by the caller; it is not a payment transaction ledger or allocation authority.
- Receipt issue checks the cumulative paid amount, but receipt voiding does not reverse or recompute settlement. Outstanding is therefore not independently authoritative.
- No payment-to-one/many-invoice allocation, as-of aging buckets, dispute lifecycle, controlled credit/debit adjustment, write-off, or reconciliation trail was found.
- Basic financial reporting aggregates the lightweight records, but inherits their authority limits. General Ledger, tax, payroll, and full ERP are outside this review.

**Conclusion:** electricity/water billing is traceable, but `REV-01` and `REV-02` are P0 for the required revenue chain. `REV-03` is P1. Automated bank-statement reconciliation is the sole `FUTURE_WAVE`/P2 item.

## 8. Operational Correction Chain

### Proven foundations

- Finding has reusable workflow transitions, history, and available-action endpoints.
- BE-21 adds Incidents, immediate actions, investigation readiness, Corrective Actions, responsibility/due date, verification/rework, incident closure, and operational events.

### Fragmented authority

1. Finding escalation creates an Incident specialization that references a Finding, but Finding and Incident states remain separate. Corrective Action and Incident closure are governed by the BE-21 lifecycle rather than the Finding workflow authority.
2. Investigation readiness is metadata. No persisted investigation result/root-cause authority was found.
3. Corrective Action does not have a stable Work Order binding or evidence binding.
4. Corrective Action verification can govern Incident closure, but it does not govern Finding closure. This creates two plausible closure truths.
5. Operational events exist, but there is no one incident/finding/action/work/evidence timeline/read model. OpenAPI documents only the narrow Finding state/available-actions slice, not the full correction chain.

**Required direction:** reuse Finding/Workflow as the state authority. Preserve reusable BE-21 action, responsibility, verification, and event records as subordinate records/projections; do not add a third lifecycle and do not replace everything with one giant model.

## 9. External Work Control Chain

### Proven foundations

- BE-20 Permit-to-Work supports tenant and vendor contractor contexts, application, approval/rejection, validity, safety requirements, workers, equipment, evidence readiness, start, and close.
- Tenant contractor eligibility checks active tenancy and assignment dates. Vendor contractor eligibility checks active Vendor/Building/Client context.
- Vendor Work, evidence, verification/rework, and shared documents/BAST are independently reusable.

### Missing controls

1. Vendor license/compliance documents are not resolved as an effective validity result and do not hard-block Permit approval/start.
2. Permit has no stable source request, Tenant assignment, Vendor assignment, Work Order, or Vendor Work reference.
3. Legacy `work-permit-readiness` is Vendor-Work-bound metadata (`permitReference`, status, window), explicitly not the BE-20 Permit authority. It is not linked to Permit Application/Permit/Validity IDs.
4. Permit Work can close after its own execution rules without an external-work verification/rework gate or BAST acceptance.
5. BE-22 BAST requires a Work Order and has no Permit/assignment binding. Tenant external work without such a Work Order cannot form the requested permit-to-acceptance chain.

**Conclusion:** consolidate references, not domain models. `EXT-01` should bind assignment/compliance/Permit; `EXT-02` should bind execution evidence, verification, BAST, and closure.

## 10. Configuration and Integration Chain

### Backend and OpenAPI result

BE-27 implements and documents Client/Building configuration values, modules/features, navigation/workspaces, dashboards/widgets, forms/checklists, operational settings, organization presentation, CMS, branding, immutable versions, validation, publish/activate, preview contexts, effective reads, audit, permissions, and client/building isolation. Representative tests exist for each domain. These are `READY` Backend/OpenAPI foundations.

### Remaining integration gaps

1. Effective reads are split by configuration domain. `/auth/me` does not return selected effective configuration/workspaces, and `docs/api/mobile-contract.md` does not define their consumption.
2. Effective preview is not compositionally equivalent across all configured domains: the preview service has specialized effective projection for configuration values, navigation, and workspaces; other version source types expose snapshots without the same effective projection.
3. Lifecycle transition endpoints are guarded, but no uniform backend-authoritative `availableActions` projection is exposed for configuration consumers.
4. Configuration audit records lifecycle operational events. No binding from those activation events to notification delivery/subscriptions was found, so consumers cannot depend on a configuration-change notification/invalidation signal.
5. The Web and Mobile consumer implementations cannot be evidenced. Governance documents assigning work to those repositories do not prove consumption.

**Conclusion:** preserve BE-27 foundations. `CFG-01` and `CFG-02` close the selected-context/consumer boundary; `CFG-03` is a P1 activation notification/invalidation seam.

## 11. Cross-Chain Stable References and Read Contracts

The problem is not a lack of IDs; it is that existing IDs are not always connected or enforced at the authority boundary.

| Trace | Existing stable references | Missing/enforcement gap | Result |
|---|---|---|---|
| Request → selection → commitment → WO/vendor | PR/MR/SR IDs, selection/readiness IDs, WO procurement binding, Vendor Assignment | No actual PO/SPK identity; assigned Vendor need not be selected/ready Vendor | Broken at commitment/assignment |
| Vendor Work → evidence → completion → verification/rework | Vendor Work IDs are reused across execution modules | BAST state/legacy authority conflict; no vendor invoice/payment/closure | Broken at acceptance/settlement |
| MR → order line → receiving → stock → WO usage → cost | MR, receiving, movement, balance, WO usage IDs | No ordered-line/remaining quantity; no valuation snapshot/cost read | Broken at fulfilment and cost |
| Utility/charge → invoice → payment/allocation → receipt/outstanding | Utility Bill/Tenant Charge source IDs and snapshots; invoice/payment-status/receipt IDs | No payment transaction/allocation; void does not reverse settlement | Broken at settlement |
| Finding/Incident → investigation → action → WO/evidence → verification → closure | Finding escalation and BE-21 action/responsibility/verification IDs | Parallel state authorities; root cause, WO, evidence, unified closure/read absent | Broken after escalation |
| Assignment → Permit → workers/equipment/evidence → verification → BAST | Contractor contexts and full Permit identities; separate Vendor Work/readiness/BAST IDs | No authoritative bindings between the chains | Broken at source, verification, acceptance |
| Selected context → effective configuration → Web/Mobile → notification | Per-domain effective APIs and configuration audit events | No selected-context composition/mobile contract, consumer evidence, or notification binding | Broken at consumer/invalidation boundary |

`TRACE-01` should provide narrow, purpose-built read projections using the existing authority IDs. It must not create one giant domain model, duplicate lifecycle state, or become an alternate write authority.

## 12. OpenAPI and Consumer Contract Completeness

`docs/api/openapi.yaml` is incremental rather than a complete declaration of the mounted Backend surface. It strongly covers management/mobile/notification/configuration work introduced in later waves, including 87 configuration-related path entries identified in the audit. It does not document the bulk of the audited legacy business routes, including Purchase/Service/Material Requests, procurement approvals and selection/readiness, Vendor Work and reports, receiving/inventory, tenant billing/settlement, BE-21 correction, and BE-20 Permit-to-Work. Finding state and available-actions are a narrow exception; they do not constitute the full Finding/correction contract.

Contract consequences:

- Web/Mobile cannot safely generate clients or validate payload/state semantics for most business chains from the checked-in OpenAPI.
- Existing Backend tests prove local behavior but do not replace a stable cross-repository contract.
- Many modules return IDs but lack a chain-level read showing source, current authority state, blocking reason, and allowed next actions.
- Backend-authoritative `availableActions` is uneven. Finding and Permit Work have stronger action projections; many legacy Work Order, Vendor Work, Corrective Action, settlement, and configuration lifecycle consumers must infer actions.
- `docs/api/mobile-contract.md` covers BE-25 mobile foundations but omits BE-27 effective configuration/workspaces.

`API-01` should add only the audited business contracts and validation coverage; it must not regenerate or redesign the entire specification. `API-02` should standardize stable read/action output only where a workflow consumer needs it.

## 13. Prioritized Gap Register

Every non-`READY` matrix row maps to at least one entry below. “Affected repositories” names the required ownership surface; Web/Mobile availability remains an evidence issue, not an assumption about implementation.

| Gap | Priority | Affected repositories | Reusable foundation | Missing contract/binding | Business impact | Owner | Matrix rows |
|---|:---:|---|---|---|---|---|---|
| GOV-01 | P0 | Business baseline / Backend / Web / Mobile | Existing BE governance and review docs | Approved Graha Mampang processes, acceptance rules, tolerances, priorities, and deferrals | No objective site-specific acceptance or release sign-off | Product / Business | X-01 |
| GOV-02 | P0 | Asentra Frontend Web | BE-27 OpenAPI and Web responsibility in governance | Accessible baseline plus implementation evidence for business actions/config consumption | End-to-end Web readiness cannot be certified | Web / Architecture | Q-16, X-04 |
| GOV-03 | P0 | Asentra Mobile | BE-25 mobile contract and BE-27 OpenAPI | Accessible Flutter baseline plus implementation evidence | End-to-end Mobile readiness cannot be certified | Mobile / Architecture | Q-17, X-05 |
| COM-01 | P0 | Backend / OpenAPI / Web / Mobile | Requests, approvals, vendor selection, PO readiness, procurement binding, Vendor Assignment, WO | Actual PO/SPK lines and enforced selected-vendor/commitment/WO assignment references | Unapproved/uncommitted or wrong vendor can execute work | Procurement / Backend | C-06–C-09 |
| COM-02 | P0 | Backend / OpenAPI / Web | Vendor Work, reports, verification, BAST, Vendor Service Cost | Distinct vendor invoice, verification, payment readiness/status, commercial closure gate | No controlled commitment-to-settlement closure or payable visibility | Finance Operations / Procurement | C-18–C-21 |
| BAST-01 | P0 | Backend / OpenAPI / Web / Mobile | Shared Documents, Work Completion, BE-22 BAST, Acceptance Sign-Off, legacy Vendor BAST binding | One transactional BAST state authority, state-gated sign-off, reliable legacy projection | Conflicting acceptance truth; premature or invisible closure | Backend / Engineering Operations | C-15, C-16, C-21, E-15 |
| MAT-01 | P0 | Backend / OpenAPI / Web / Mobile | MR, PR/SR readiness, receiving, stock movements | Stable demand/order/receipt line IDs, ordered/remaining quantity, reversal rules | Over-receipt, demand mismatch, and untraceable material fulfilment | Procurement / Warehouse | M-02–M-04 |
| MAT-02 | P1 | Backend / OpenAPI / Web | Inventory movements/balances, WO usage, Vendor Service Cost | Unit-cost/valuation snapshot and WO material-cost read | Operational cost excludes consumed material value | Finance Operations / Warehouse | M-09 |
| REV-01 | P0 | Backend / OpenAPI / Web / Mobile | Utility billing, Tenant Charge, Service Charge readiness, Invoice | Dedicated parking source; service-charge calculation/allocation and source identity | Incomplete and manually interpreted tenant billing | Product / Finance Operations | R-04, R-06 |
| REV-02 | P0 | Backend / OpenAPI / Web / Mobile | Finalized Invoice, payment-status snapshot, Receipt | Payment transactions, allocation, reversal, derived settlement/outstanding | Paid/outstanding can diverge from receipts; no allocation audit | Finance Operations / Backend | R-10–R-14, R-20 |
| REV-03 | P1 | Backend / OpenAPI / Web | Invoice, due date, settlement foundation, financial summary | As-of aging, dispute, adjustments/write-off controls and corrected reporting | Collection and exception management are unreliable/incomplete | Finance Operations / Backend | R-15–R-18 |
| REV-04 | P2 | Backend / Integration / Web | Future payment transaction/allocation foundation | Bank-statement import/matching/reconciliation automation | Manual bank reconciliation remains | Finance Operations / Product | R-19 |
| OPS-01 | P0 | Backend / OpenAPI / Web / Mobile | Finding Workflow/history/actions; BE-21 Incident, immediate action, responsibility, verification, events | Finding-governed correction, persisted investigation/root cause, WO/evidence links, one closure/read | Two lifecycle truths and incomplete corrective trace/audit | Engineering Operations / Backend | O-01–O-07, O-09–O-14 |
| EXT-01 | P0 | Backend / OpenAPI / Web / Mobile | Tenant/Vendor contractor context, vendor compliance docs, BE-20 Permit, Vendor Assignment/Work | Effective compliance blocker and source/assignment/Vendor Work-to-Permit IDs | Ineligible or unassigned external work may be permitted | HSE/Operations / Procurement | E-03–E-05, E-13 |
| EXT-02 | P0 | Backend / OpenAPI / Web / Mobile | Permit Work/evidence, vendor verification/rework, BAST | External-work verification/rework and BAST-gated Permit/assignment closure | Work can close without quality acceptance | HSE/Operations / Backend | E-12, E-14–E-16 |
| CFG-01 | P0 | Backend / OpenAPI / Mobile | BE-27 effective per-domain reads, versions, preview | Selected-context composition in `/auth/me`/mobile contract; equivalent effective preview | Consumers cannot consistently resolve active configuration | Backend / Mobile / API Governance | Q-10, Q-15 |
| CFG-02 | P0 | Asentra Frontend Web / Asentra Mobile | BE-27 OpenAPI, navigation/workspace/dashboard/form/checklist configuration | Verified admin/runtime consumer implementation, context switch/cache invalidation behavior | Backend configuration cannot be certified end-to-end | Web / Mobile | Q-16, Q-17 |
| CFG-03 | P1 | Backend / Web / Mobile | Configuration audit events; BE-26 templates/subscriptions/in-app delivery | Activation-event notification/invalidation binding and consumer contract | Consumers may retain stale configuration | Backend / Web / Mobile | Q-18 |
| API-01 | P0 | Backend OpenAPI / Web / Mobile | Mounted routes, request validators, tests, existing incremental OpenAPI | Paths/schemas/errors/examples for audited legacy business capabilities | Cross-repository clients lack a stable generated/verifiable contract | API Governance / Backend | C-01–C-05, C-09–C-14, C-17, C-22; M-01, M-05–M-08, M-10; R-01–R-03, R-05, R-07–R-10, R-13, R-18, R-20; O-01–O-05, O-08, O-11, O-14; E-01–E-03, E-06–E-12, E-16; X-03 |
| API-02 | P1 | Backend / OpenAPI / Web / Mobile | Finding/Permit Work actions; RBAC and lifecycle services | Uniform stable read plus backend-derived available actions for interactive workflows | Consumers infer transitions and may expose invalid actions | API Governance / Backend | O-14, Q-14 |
| TRACE-01 | P0 | Backend / OpenAPI / Web / Mobile | Existing stable IDs, operational events, management read-model patterns | Narrow chain read projections and enforced references at authority boundaries | Users cannot prove one end-to-end case or identify its blockers | Backend / API Governance | C-08, C-22, M-02, M-10, R-20, O-09, O-10, O-12, E-05, E-13, E-16, X-06 |

### P0 blockers

1. `GOV-01` — no approved Graha Mampang business baseline.
2. `GOV-02`, `GOV-03` — Web and Mobile baselines/implementations unavailable for evidence.
3. `COM-01`, `COM-02` — no authoritative commercial commitment, vendor settlement, or closure chain.
4. `BAST-01` — conflicting/incomplete acceptance state authority.
5. `MAT-01` — no ordered-line/remaining-quantity receiving control.
6. `REV-01`, `REV-02` — missing parking/service-charge authority and payment/allocation/outstanding authority.
7. `OPS-01` — operational correction does not reuse one Finding/Workflow authority end to end.
8. `EXT-01`, `EXT-02` — Permit is not bound to compliance, assignment, Vendor Work, verification, or BAST closure.
9. `CFG-01`, `CFG-02` — selected effective context and consumer consumption are not end-to-end proven.
10. `API-01`, `TRACE-01` — legacy OpenAPI and stable chain-read contracts are incomplete.

### P1 gaps

- `MAT-02` — inventory valuation and Work Order material cost.
- `REV-03` — aging, disputes, controlled adjustments/write-offs, and reporting correction.
- `CFG-03` — configuration activation notification/cache invalidation.
- `API-02` — consistent backend-authoritative available actions.

### P2 / future wave

- `REV-04` — automated bank-statement reconciliation. This deferral does not defer the P0 requirement for payment transactions, allocations, receipt reversal, and authoritative outstanding.

## 14. Reusable Foundations and Targeted CR Proposals

### Reusable foundations

| Foundation | Reuse direction |
|---|---|
| Requests, procurement approval, vendor selection/readiness | Add commitment and enforced references; do not replace request engines. |
| Work Order procurement binding, Vendor Assignment, Vendor Work | Connect selected/committed vendor and source IDs at existing boundaries. |
| Vendor reports, verification/rework, Work Completion, Documents | Reuse as execution/quality evidence under one BAST authority. |
| Inventory movements/balances and WO usage | Preserve quantity authority; add ordered-line references and valuation snapshots. |
| Utility calculation/Bill, Tenant Charge, Invoice snapshots | Preserve billing sources; add missing source types and settlement allocation authority. |
| Finding Workflow/history/available actions | Make it the operational correction state authority; attach BE-21 records beneath it. |
| BE-20 Permit and contractor contexts | Preserve PTW lifecycle; bind assignment/compliance/Vendor Work/verification/BAST. |
| Operational events and management read-model patterns | Build narrow chain projections and configuration notifications without new write authorities. |
| BE-27 versions/effective reads/audit/RBAC/OpenAPI | Compose selected context and implement consumers; do not rebuild Configuration Studio Backend. |
| Existing incremental OpenAPI | Extend audited paths/schemas in bounded parts; do not regenerate the entire specification. |

### Targeted CR proposals

Only the requested proposal fields are provided.

| Proposed name | Problem | Repository | Dependency | Small PART breakdown |
|---|---|---|---|---|
| **CR-BE-COM-02 — Commercial Commitment, Vendor Settlement and Closure** | Readiness and execution exist without actual PO/SPK, selected-vendor enforcement, distinct vendor invoice, verification, payment readiness/status, or closure. | Asentra Backend + OpenAPI | Approved Graha baseline; current request/selection/readiness/WO/Vendor Work foundations; BAST CR | **PART 01:** PO/SPK header/line commitments and request/selection references. **PART 02:** enforce committed Vendor/WO/receiving references. **PART 03:** vendor invoice, verification, payment readiness/status, closure read. |
| **CR-BE-BAST-01 — BAST Lifecycle Authority Consolidation** | BE-22 BAST cannot transition while sign-off and legacy Vendor BAST create competing acceptance truths. | Asentra Backend + OpenAPI | BE-22 Document/BAST/Sign-Off; BE-15 Vendor BAST binding | **PART 01:** authoritative BAST transitions and guards. **PART 02:** transactional state-gated sign-off. **PART 03:** legacy compatibility as a reliable projection with one read authority. |
| **CR-BE-MAT-01 — Controlled Material Fulfilment and Work-Order Cost** | Material demand, procurement, receipt, inventory quantity, and WO usage lack line continuity, remaining quantity, and valuation. | Asentra Backend + OpenAPI | Commercial commitment line IDs; existing MR/receiving/inventory/WO usage | **PART 01:** MR-demand/commitment line references. **PART 02:** receiving remaining-quantity and reversal control. **PART 03:** valuation snapshots and WO material-cost read. |
| **CR-BE-REV-01 — Tenant Receivables Control** | Parking/service-charge sources and payment/allocation/outstanding authority are absent; receipt void does not reverse settlement. | Asentra Backend + OpenAPI | Approved source rules; Tenant Charge/Utility Bill/Invoice/Receipt foundations | **PART 01:** parking and service-charge assessment/source contracts. **PART 02:** payment transactions, allocations, reversals, derived outstanding/receipts. **PART 03:** aging, disputes, adjustments/write-offs, corrected reporting. |
| **CR-BE-OPS-01 — Finding-Centric Operational Correction** | Finding and BE-21 Incident/Corrective Action lifecycles are parallel; root cause, WO/evidence links, and unified closure/read are missing. | Asentra Backend + OpenAPI | Existing Finding Workflow/history/actions; BE-21 action/responsibility/verification/events | **PART 01:** Finding-bound investigation/root cause. **PART 02:** subordinate action responsibility, WO, and evidence bindings. **PART 03:** Finding-governed verification/rework/closure, timeline, available actions. |
| **CR-BE-EXT-01 — External Work Assignment-to-Acceptance Control** | PTW is not bound to compliance, source assignment, Vendor Work, verification, or BAST; legacy readiness is separate metadata. | Asentra Backend + OpenAPI | BE-20 Permit; contractor contexts; Vendor Work; BE-22 after BAST CR | **PART 01:** effective compliance resolver and assignment/source bindings. **PART 02:** replace legacy readiness truth with authoritative Permit IDs. **PART 03:** execution evidence, verification/rework, BAST-gated closure. |
| **CR-CROSS-CFG-01 — Effective Configuration Consumer Integration** | Backend configuration is strong but selected-context composition, Web/Mobile consumption, and activation notification/invalidation are unproven/incomplete. | Asentra Backend + Asentra Frontend Web + Asentra Mobile + OpenAPI | BE-27 effective APIs/lifecycle/audit; BE-25 mobile contract; BE-26 notification foundation; repository access | **PART 01:** selected effective context and equivalent preview/action contract. **PART 02:** Web admin/runtime consumption. **PART 03:** Mobile consumption plus activation notification/cache invalidation. |
| **CR-BE-API-02 — Business-Chain Contract and Trace Completion** | Most implemented legacy routes and end-to-end stable read/action contracts are absent from OpenAPI. | Asentra Backend OpenAPI | Domain CR authorities stabilized first; existing validators/tests/read-model pattern | **PART 01:** commercial/material paths and chain reads. **PART 02:** tenant revenue/correction/external-work paths and actions. **PART 03:** contract validation, reference tests, and mobile-contract alignment. |

## 15. BE-28 Recommendation and Roadmap

### Recommendation: **HOLD**

BE-28 must not start as an implementation wave while the P0 authority and evidence gates remain open. Starting it now would build on ambiguous commitment, acceptance, settlement, correction, permit, and consumer contracts.

### Entry sequence

1. **Baseline gate:** Product/Business publishes and approves the Graha Mampang business baseline; Web and Mobile baselines become accessible.
2. **Authority gate:** approve and deliver the bounded commercial, BAST, material-line, tenant-receivable, Finding-centric correction, and external-work CRs. These changes must reuse existing authorities and stable IDs.
3. **Contract gate:** stabilize those authorities, then complete bounded OpenAPI paths, chain reads, blocking reasons, and available actions through CR-BE-API-02.
4. **Consumer gate:** evidence Web/Mobile contract consumption, context isolation, valid actions, selected effective configuration, and activation invalidation.
5. **Audit gate:** rerun this matrix against Backend/OpenAPI/Web/Mobile and the approved Graha baseline. Require zero open P0 gaps and explicit acceptance of any P1/P2 deferrals.
6. **BE-28 decision:** change HOLD to GO only after all five gates pass. No BE-28 scope or implementation is started by this review.
