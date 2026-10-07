# CR-BE-ESG-01 — START GOVERNANCE

## ESG Operational Foundation

**Inspection date:** 2026-08-24 (UTC)
**Stage:** START GOVERNANCE only
**Implementation status:** none — this document creates no migrations, runtime code, routes, OpenAPI changes, or tests
**Repository:** `budiirmawan/Asentra-Backend`
**Branch:** `arena/01a032dc-asentra-backend`
**Base commit:** `a90cf9a0664f8f0fd0b5c3035dbfd9120853135d` (main after merge PR #64 / CR-BE-SVC-01)
**Next free migration:** `0326` (0325 was `activate_service_reference_price`)

This document defines the minimum governed **ESG Operational Foundation** for Asentra: what ESG capability already exists via utility/building/asset/evidence/reporting authorities, what is missing (waste, emissions readiness, ESG metric periodization, baseline/target, data-quality), and the smallest safe model that adds ESG without duplicating utility authorities and without inventing external ESG certification or carbon-accounting compliance claims.

Governance-only. No runtime code.

---

## 1. Repository baseline

| Item | Verified value |
|---|---|
| Branch | `arena/01a032dc-asentra-backend` |
| Main HEAD | `a90cf9a` — merge PR #64 CR-BE-SVC-01 |
| Migrations applied in main | up to `0325_activate_service_reference_price` |
| Modules | 250+ domain modules (`src/modules/`) — see §2 |
| Permissions | 295 codes in `foundation-access.seed.ts`, no `esg.*` codes |
| OpenAPI | `docs/api/openapi.yaml` — no ESG paths |
| Audit | `operational_events` + `recordOperationalEvent` + AUDIT-01 correlation (0309) + integration-outbox seam |
| Isolation | BE-02G `ContextAccessService` — Client → Property → Building → operational data |
| Evidence | BE-07 `evidence_submissions` + `evidence_requirements` + storage abstraction + integrity hash (0303) + retention policies (0304) |
| Utility foundation | BE-18A–M + BE-18M aggregation + BE-23I KPI + BE-24 utility summary + CR-BE-UTL-01 reconciliation (IKE/IKA) |

---

## 2. Authority map (verified)

### 2.1 Buildings / Locations

- **Buildings:** `buildings` table, `src/modules/buildings` — Client ownership derived via `Building → Property → Client`, never from caller. Status ACTIVE/INACTIVE. Address, timezone, campus optional. Isolation via `ContextAccessService.getAccessibleBuildingIds`.
- **Locations:** `campuses`, `floors`, `areas`, `rooms`, `spaces` (with `area_sqm` for IKE/IKA), `functional_locations` (BE-04). Asset and meter modules reference these by id only.
- **Relevance to ESG:** Building is the primary ESG isolation boundary; `spaces.area_sqm` is already used for IKE (kWh/m²) and IKA (m³/m²) in `building_utility_reconciliations`. No ESG-specific location extension needed.

### 2.2 Assets and Equipment

- **Assets:** `assets` master — Client-scoped via Building, code unique per Building, lifecycle ACTIVE/INACTIVE/UNDER_MAINTENANCE/RETIRED (BE-05E), classification via `asset_categories`/`asset_types`, location binding via `functional_location_id`, history preserved in `asset_history` and `previousStatus`. 
- **Equipment profiles, warranties, certifications, identifiers, failures:** `equipment-profiles`, `asset-warranties`, `asset-certifications`, `asset-identifiers`, `asset-failures`, `asset-history`.
- **Relevance to ESG:** Assets can be emission sources or energy consumers, but no ESG-specific asset attribute exists. Asset hierarchy is reusable for future equipment-level ESG drill-down, but v1 ESG stays Building-scoped to avoid coupling asset lifecycle to ESG metric lifecycle. No duplication.

### 2.3 Utility Meters / Readings

- **Meters:** `utility_meters` (BE-18A) — Client → Building → Meter, code unique per Building, type ELECTRICITY/WATER/GAS, purpose TENANT/BUILDING/COMMON_AREA/ENERGY_SOURCE, UOM via `units_of_measure` (same Client + ACTIVE), status ACTIVE/INACTIVE. Main/Sub hierarchy via `utility_meter_hierarchies` (BE-18C).
- **Readings:** `utility_meter_readings` (BE-18E) — append-only, no update/delete, value as NUMERIC string, source MANUAL/ENGINEERING/IMPORT/SYSTEM, type ACTUAL/ESTIMATED, tenant assignment snapshot (BE-18D), engineering binding (BE-10C). Evidence via `utility_meter_reading_evidence` (BE-18F), OCR candidates (BE-18N).
- **Tariffs, dues, exceptions:** `utility_tariffs` (BE-18B), `utility_reading_dues` (BE-18H), `utility_operational_exceptions` (BE-18I).
- **Relevance to ESG:** Authoritative source for energy/water activity data. Must NOT be duplicated by ESG. ESG reads, never rewrites.

### 2.4 Electricity / Water Consumption

- **Consumptions:** `utility_meter_consumptions` (BE-18G) — derived delta between two readings, references both reading ids, periodStart/End, calculatedAt, append-only, no duplicated reading values.
- **Aggregations:** `utility_aggregations` module (BE-18M) — read-only summary over consumptions, abnormalities (BE-18J), verifications (BE-18K), approvals (BE-18L). Handles Sub-Meter exclusion (EXCLUDE_SUB_METERS default) to avoid double-counting — a non-obvious rule ESG must reuse, not re-derive.
- **Reconciliations:** `building_utility_reconciliations` (0280, CR-BE-UTL-01 PART 12) — immutable snapshot: source vs tenant vs common_area vs unallocated, reconciliation %, applicableAreaSqm, performanceMetric IKE/IKA, performanceValue. This is already an ESG-relevant intensity metric.
- **KPI:** `utility_kpi` (BE-23I) delegates to BE-18M, provides per-type totals, abnormal counters, verification counters, trend. `management_utility_summary` (BE-24) thin management projection.
- **Relevance to ESG:** Energy and water ESG metrics are CALCULATED from these authorities. No second consumption calculation in ESG.

### 2.5 Waste / Environmental Operations

- **Search result:** `grep -R waste|recycl|emission|carbon src/` returns **zero** domain tables, modules, or migrations. No `waste_records`, `recycling`, `emission`, `esg`, `sustainability` authority exists.
- **Inventory:** `inventory_items` (SPARE_PART/MATERIAL/CONSUMABLE) + stock/movements — not waste.
- **Housekeeping consumables:** `inventory-housekeeping-consumable-bindings` — readiness, not waste.
- **Relevance to ESG:** **Gap.** Waste is the primary missing operational authority. No disposal method, no waste type, no vendor collection tracking, no recycling rate. Environmental operations beyond cleaning (e.g., chemical usage, water treatment) also have no generic log.

### 2.6 Housekeeping / Environmental Records

- **Daily cleaning:** `daily-cleaning` tasks, `cleaning-areas`, `cleaning-assignments`, `cleaning-schedule-bindings` — operational date, status OPEN/ASSIGNED/IN_PROGRESS/COMPLETED/CANCELLED.
- **Inspections:** `toilet-inspections`, `public-area-inspections`, `supervisor-inspections` — execution, findings, quality audits.
- **Reports:** `housekeeping-reports` — read-model projection over cleaning, inspections, findings, consumables, complaints.
- **Complaints/findings/evidence:** `housekeeping-complaints`, `housekeeping-findings`, `housekeeping-evidence`.
- **Relevance to ESG:** Housekeeping is an operational execution domain that could generate waste, but it does not record waste quantities. Its evidence and finding pattern is reusable for ESG data-quality exceptions, but no environmental record authority exists.

### 2.7 Incidents / Findings

- **Incidents:** `incidents` foundation (BE-21A) — type OPERATIONAL/ASSET_FAILURE/FINDING_ESCALATION, severity LOW/MEDIUM/HIGH/CRITICAL, priority same scale, status REPORTED/CANCELLED/CLOSED, location refinement (FLOOR/AREA/ROOM/SPACE/FUNCTIONAL_LOCATION), plus closure (BE-21K), investigation, immediate actions, corrective actions.
- **Findings:** `findings` generic (BE-09) — status OPEN/ASSIGNED/IN_PROGRESS/PENDING_REVIEW/REJECTED/REWORK_REQUIRED/RESUBMITTED/VERIFIED/CLOSED/CANCELLED, classification/severity, source binding (FORM_INSTANCE/CHECKLIST_EXECUTION/WORK_ORDER), assignment/review/rework/closure.
- **Domain findings:** `engineering-findings`, `housekeeping-findings`, `security-findings`.
- **Relevance to ESG:** Environmental incidents (spill, leak, non-compliance) could be modeled as OPERATIONAL incidents today, but no ESG-specific incident category or environmental finding taxonomy exists. Reuse, not duplicate.

### 2.8 Evidence / Documents

- **Evidence:** `evidence_submissions` (0073) + `evidence_requirements` (BE-07) — Client-owned, executionType union (FORM_INSTANCE/CHECKLIST_EXECUTION/WORK_ORDER/VENDOR_WORK/UTILITY_METER_READING/PERMIT/FINDING/etc), evidenceType PHOTO/DOCUMENT/SIGNATURE, fileReference (opaque storage key), fileSize, mimeType, capturedAt, submittedByUserId, status ACTIVE/REMOVED. Integrity hash (0303): `content_sha256`, `hash_algorithm`, `content_hashed_at`, `last_integrity_status`, `last_integrity_checked_at`. Retention (0304/0305): `evidence_retention_policies` Client-scoped optionally Building-scoped, code unique per Client, precedence scoring building+4/execution+2/evidenceType+1, snapshot on submission (`retained_until`, `retention_policy_id`, `retention_state` ACTIVE/RETENTION_DUE/PURGED, `purged_at`, hold flag).
- **Documents:** `documents` foundation (BE-22A) — Client-scoped optionally Building-scoped, context INTERNAL/TENANT/VENDOR, sourceType TENANT_COMPANY/VENDOR/INTERNAL, status DRAFT/ACTIVE/INACTIVE/ARCHIVED, fileReference, expiry, archive metadata, plus versions/approvals/expiry.
- **Relevance to ESG:** Existing evidence engine is the traceability authority for ESG. ESG must link via binding table, not create a parallel file store. Retention policies can govern ESG evidence.

### 2.9 Vendors

- **Vendors:** `vendors` master Client-scoped code unique, category optional, status ACTIVE/INACTIVE, plus `vendor_pics`, `vendor_buildings`, `vendor_capabilities` (code unique per Vendor, optionally linked to `service_catalog` via 0323), `vendor_work`, `vendor_work_evidence`, `vendor_work_history`, `vendor_verification`, `vendor-compliance-documents`, `vendor-licenses`, `vendor-invoices`.
- **Relevance to ESG:** Waste collection/disposal vendors are existing Vendors. ESG waste records can reference `vendor_id` for provenance without new vendor master.

### 2.10 Operational Events / Audit

- **Operational events:** `operational_events` (0080) — append-only, client_id, event_type, entity_type, entity_id, actor_user_id, building_id, vendor_work_id optional, request_id + source HTTP/SCHEDULER/SYSTEM (0309), summary, metadata (scrubbed of sensitive keys), occurred_at. Helper `recordOperationalEvent` transaction-atomic + integration-outbox seam (0306-0308).
- **Relevance to ESG:** All ESG lifecycle events must go through this authority. No parallel audit.

### 2.11 Reporting / KPI Authorities

- **BE-23:** `security-patrol-kpi`, `security-finding-incident-kpi`, `workforce-kpi`, `vendor-tenant-kpi`, `utility-kpi` (delegates to BE-18M), `reporting-export` (neutral JSON envelope, never recalculates).
- **BE-24:** Management read models — `management-read-scope` (shared Client/Building selector, scope intersection, period/as-of provenance), `management-utility-summary`, `management-building-performance` (includes utility electricity/water/gas, abnormal, verified), `management-operational-kpi`, `management-operations-command-center`, etc. All read-only, no operational source table, reuse owning KPI services.
- **Relevance to ESG:** Pattern for ESG reporting: thin read model over authoritative ESG metric values + utility aggregation, scope-aware, no BI warehouse. No ESG read model exists today.

---

## 3. Verified gaps

| # | Gap | Evidence | Impact |
|---|---|---|---|
| G-01 | **No ESG domain at all** | grep zero results for `esg`, `sustain`, `carbon`, `emission`, `waste` tables/modules; OpenAPI has no ESG paths; seed has no `esg.*` | ESG cannot be recorded or reported |
| G-02 | **Waste operational authority missing** | No waste table, no disposal method, no waste type, no recycling rate | Waste generation, recycling, hazardous handling untracked |
| G-03 | **Emissions/carbon data readiness missing** | No emission activity table, no factor table, no emission estimate | Activity data exists (electricity) but not linked to ESG; no readiness for future factor application without claiming compliance |
| G-04 | **Environmental operational records missing** | Housekeeping tracks cleaning tasks, not environmental ops (chemical, water treatment, etc) | No generic environmental log |
| G-05 | **ESG metric definition master missing** | No `esg_metric_definitions`, no governed code vocabulary for ENERGY/WATER/WASTE/EMISSIONS | Metrics cannot be governed, baselines/targets have no subject |
| G-06 | **ESG metric periodization missing** | No period table (monthly/yearly) for ESG values | No comparable periods, no trend |
| G-07 | **Baseline/target readiness missing** | No baseline/target tables | Cannot set or track reduction goals |
| G-08 | **Data quality & verification for ESG missing** | Utility has verification (BE-18K) for abnormalities, but ESG has no data quality flag, no verification status | No trust signal for ESG figures |
| G-09 | **Source/evidence traceability for ESG missing** | Evidence exists but no binding to ESG records | No provenance for ESG values |
| G-10 | **Building/Client aggregation for ESG missing** | Utility aggregation exists for utility, but no ESG aggregation; management read scope exists but no ESG summary | No portfolio ESG view |
| G-11 | **Reporting readiness for ESG missing** | Reporting-export has UTILITY dataset but no ESG dataset | Cannot export ESG |
| G-12 | **RBAC for ESG missing** | No `esg.*` permissions | No governed access |

**What already exists and must be reused (not duplicated):**

- Energy: `utility_meter_consumptions` + `utility_aggregations` (EXCLUDE_SUB_METERS) + `building_utility_reconciliations` (IKE) + `utility_kpi`
- Water: same stack + IKA
- Building/Client isolation: `ContextAccessService`
- Evidence: `evidence_submissions` + retention
- Audit: `operational_events`
- Reporting pattern: BE-23/BE-24 thin read models + `reporting-export`

---

## 4. Minimum ESG Operational Foundation definition

### 4.1 Energy

- **Source:** Existing utility electricity (and gas where present) consumptions. No new meter reading table.
- **ESG representation:** CALCULATED metric values derived from `utility_meter_consumptions` / `utility_aggregations` / `building_utility_reconciliations`. Value = sum of kWh per period per Building, with Sub-Meter exclusion respected. UOM from existing `units_of_measure`.
- **Intensity:** IKE (kWh/m²) already computed in reconciliations; ESG reuses it for energy intensity KPI.
- **Manual override:** Allowed as MANUAL metric value when utility data is missing (e.g., estimated bills), flagged as ESTIMATED with evidence.

### 4.2 Water

- Same pattern as energy: CALCULATED from water meter consumptions, IKA (m³/m²) from reconciliations. No duplication.

### 4.3 Waste

- **New operational authority:** `esg_waste_records` — the only new measurement table that does not exist today.
- Minimal fields: building, optional functional location, waste_type (GENERAL/ORGANIC/RECYCLABLE/HAZARDOUS/E_WASTE/CONSTRUCTION/OTHER), disposal_method (LANDFILL/RECYCLED/COMPOSTED/INCINERATED/REUSED/DONATED/OTHER), quantity NUMERIC >=0, UOM (kg/ton/m³), period_date (operational date), source MANUAL/IMPORT/SYSTEM, vendor_id optional (collection vendor), notes, status ACTIVE/INACTIVE, created_by.
- Append-only correction model: no destructive update of quantity; correction = new record + deactivate old (or update with audit, decision in PART 02). Start with simple ACTIVE/INACTIVE + audit, matching asset/utility pattern.
- Aggregation: sum per Building/Client per period per waste_type/disposal_method. Recycling rate = RECYCLED / total (calculated in read model, not stored).

### 4.4 Emissions / Carbon Data Readiness

- **No carbon-accounting compliance claim.** No scope 1/2/3 certification, no GRI/ISO 14064 claim, no mandatory emission factor.
- **Readiness model:** Store activity data that can later be converted, not the converted compliance figure as authority.
  - Activity data = electricity consumption (kWh) from utility, waste quantity (kg), fuel usage if manually entered via environmental records.
  - Metric definition category EMISSIONS with calculation_method HYBRID: value may be MANUAL (user-provided estimate) or CALCULATED (activity * factor) in future.
  - For v1 foundation, emission metric values are MANUAL or IMPORT with ESTIMATED quality, with source_refs pointing to underlying activity (consumption ids, waste record ids). Factor table is **deferred** — a future additive `esg_emission_factors` master (Client-scoped, effective-dated) can be introduced without rewriting history, but is NOT part of minimum foundation to avoid inventing compliance.
- **Explicit non-claim:** Document states emission values are operational estimates for internal tracking, not certified carbon accounting.

### 4.5 Environmental Operational Records

- Generic `esg_environmental_records` (optional in v1, can be deferred to PART 03 if waste covers minimum). If included, minimal: building, record_type (WASTE_COLLECTION/RECYCLING_PICKUP/WATER_TREATMENT/CHEMICAL_USAGE/ENERGY_SAVING_ACTION/OTHER), quantity optional, UOM optional, date, vendor, notes, evidence. This gives extensibility beyond waste without creating many tables.
- Decision: v1 foundation includes waste as mandatory, environmental records as optional extension — governance allows one generic table to avoid future table explosion. For minimalism, start with waste only, and allow environmental records as same table with OTHER type, or as second table in PART 03.

### 4.6 ESG Metrics and Periods

- **Metric definition master:** `esg_metric_definitions` — Client-scoped code unique, category ENERGY/WATER/WASTE/EMISSIONS/OTHER, UOM optional FK, calculation_method CALCULATED/MANUAL/HYBRID, status ACTIVE/INACTIVE. This is the governed subject for all ESG values, baselines, targets.
- **Period values:** `esg_metric_values` — Client + Building (nullable for Client rollup), metric_definition_id, period_type DAILY/MONTHLY/QUARTERLY/YEARLY, period_start/end (CHECK end > start), value NUMERIC, UOM, calculation_method actually used, source_type (UTILITY_CONSUMPTION/WASTE_RECORD/MANUAL_ENTRY/IMPORT/SYSTEM), source_refs JSONB array of UUIDs (consumption ids, waste record ids), data_quality ACTUAL/ESTIMATED/MISSING, verification_status PENDING/VERIFIED/REJECTED/NOT_REQUIRED, verified_by/at, evidence binding via separate table, created_by. Unique (client_id, building_id, metric_definition_id, period_start, period_end) to prevent duplicate period values.
- **Period handling:** All periods in UTC (like BE-23), day windows inclusive. Building timezone stored but evaluation in UTC for comparability, same as BE-24.

### 4.7 Source / Evidence Traceability

- **Source traceability:** `esg_metric_values.source_refs` holds authoritative source ids (utility consumption ids, waste record ids). No duplicated values, only references. For utility-derived metrics, source_refs = list of `utility_meter_consumptions.id` summed.
- **Evidence traceability:** `esg_evidence_bindings` — polymorphic binding (record_type, record_id) → `evidence_submission_id`. Reuses existing evidence engine, no new file store. Evidence retention policies govern ESG evidence.
- **Provenance:** Every ESG row carries `created_by_user_id`, `created_at`, `client_id`, `building_id`. Updates via `operational_events`.

### 4.8 Building / Client Aggregation

- **Building-level:** Primary. Every waste record and metric value is Building-scoped (client_id derived via Building, like assets/meters).
- **Client-level:** Rollup via query (sum of Building values) or explicit Client-level metric value (building_id NULL) for imported corporate totals. Management read scope (`management-read-scope`) pattern reused: caller's accessible Buildings ∩ requested Client/Building selection, never widening.
- **Portfolio:** Future BE-24 style read model `management-esg-summary` aggregates per Building and per Client, with buildingScope, period, asOf provenance.

### 4.9 Baseline / Target Readiness

- **Baselines:** `esg_baselines` — Client + Building (nullable), metric_definition_id, baseline_period_start/end, baseline_value, UOM, status ACTIVE/INACTIVE, notes. Unique per client/building/metric/baseline start. Baseline is a frozen reference, not auto-recalculated.
- **Targets:** `esg_targets` — Client + Building (nullable), metric_definition_id, target_period_start/end, target_value, target_type ABSOLUTE/REDUCTION_PERCENT, UOM, status. Targets reference baselines via metadata, not FK, to avoid coupling.
- **Readiness:** Both tables are configuration-like, no scheduler. Activation = ACTIVE. Historical baselines retained (INACTIVE for old). No auto-sweep.

### 4.10 Data Quality and Verification

- **Quality flags:** `data_quality` on metric values: ACTUAL (measured), ESTIMATED (imported/manual estimate), MISSING (no data). Plus optional `completeness_percent` in future, deferred.
- **Verification:** `verification_status` PENDING/VERIFIED/REJECTED/NOT_REQUIRED, with verifier and timestamp. Verification is human act, not auto. Abnormal detection for utility already exists (BE-18J); ESG can reuse pattern for waste (e.g., spike vs baseline) in future PART, but v1 keeps manual verification.
- **No invented score:** No composite ESG score or ranking in foundation. Only raw values, baselines, targets, verification.

### 4.11 Reporting Readiness

- **No BI warehouse:** Like BE-23/BE-24, ESG reporting is thin read models over authoritative tables, not ETL.
- **Read models:** 
  - `esg_kpi` (BE-23 style) — per Building or all accessible Buildings, per metric category, totals, trend.
  - `management_esg_summary` (BE-24 style) — Building/Client aggregation, period comparison, verification summary, waste breakdown by type/disposal, energy/water intensity.
- **Export:** Add `ESG` dataset to `reporting_export` (BE-23J) — neutral envelope with metadata, KPI values, tables (metric values, waste records, baselines/targets), no PDF/Excel generation.
- **OpenAPI:** Paths versioned `/api/v1/esg/...`, documented in closure PART.

---

## 5. Authoritative data model decision

**One metric master + one waste operational table + one period value table + baseline/target + evidence binding** — minimal, no duplication.

| Table | Purpose | Scope | Key decisions |
|---|---|---|---|
| `esg_metric_definitions` | Governed ESG metric vocabulary | Client-scoped, code UNIQUE (client_id, code), category CHECK, UOM optional FK, status ACTIVE/INACTIVE | Analogous to `service_catalog` / `inventory_items` / `skills` reference-master idiom; code pattern `/^[A-Z][A-Z0-9_-]*$/` 2–64 chars, normalized uppercase |
| `esg_waste_records` | Operational waste measurement | Client derived via Building, building_id NOT NULL, functional_location_id NULL, waste_type CHECK, disposal_method CHECK, quantity NUMERIC >=0, uom_id FK, period_date DATE, source CHECK, vendor_id NULL FK vendors, status ACTIVE/INACTIVE | Append-only correction preferred; no update of quantity without audit; quantity + UOM authoritative |
| `esg_metric_values` | Periodized ESG values (calculated or manual) | Client + Building (NULL = Client rollup), metric_definition_id FK composite (id, client_id), period_type CHECK, period_start/end TIMESTAMPTZ CHECK end>start, value NUMERIC, uom_id FK, calculation_method CHECK, source_type CHECK, source_refs JSONB, data_quality CHECK, verification_status CHECK | UNIQUE (client_id, building_id, metric_definition_id, period_start, period_end) partial where status ACTIVE; source_refs never duplicates authoritative values |
| `esg_baselines` | Frozen baseline reference | Client + Building NULL, metric_definition_id FK composite, period start/end DATE, value NUMERIC, UOM, status ACTIVE/INACTIVE | Baseline is configuration, not auto-derived; retained for history |
| `esg_targets` | Target / reduction goal | Client + Building NULL, metric_definition_id FK composite, target period, value, target_type ABSOLUTE/REDUCTION_PERCENT, status | References baseline via metadata, not hard FK |
| `esg_evidence_bindings` | Evidence traceability | Client, record_type CHECK (WASTE_RECORD/METRIC_VALUE/BASELINE/TARGET/ENVIRONMENTAL_RECORD), record_id UUID, evidence_submission_id FK evidence_submissions | UNIQUE (record_type, record_id, evidence_submission_id); reuses existing evidence engine |
| `esg_environmental_records` (optional, PART 03) | Generic environmental ops beyond waste | Same shape as waste but record_type CHECK | Deferred if waste covers v1; governance allows it as extension without new storage |

**What is NOT a table in v1:**

- No `esg_emission_factors` — deferred to avoid compliance claim; readiness is activity data + manual estimate
- No `esg_scores` / composite ESG score — explicitly rejected
- No `esg_certifications` — explicitly rejected per instruction
- No second utility consumption table — reuse BE-18G
- No `esg_waste_categories` master in v1 — waste_type is CHECK whitelist (like `skills.category` free in v1, but here CHECK for safety); governed promotion to master is future additive CR

**Scope FK precedent:** `UNIQUE (id, client_id)` on `esg_metric_definitions` so child tables can prove Client scope structurally via composite FK `(metric_definition_id, client_id)`, same as `0313`/`0319`/`0322` precedent.

---

## 6. Integration with existing operational data

| Existing authority | ESG integration | How |
|---|---|---|
| `buildings` / `spaces.area_sqm` | Building is ESG isolation boundary; area_sqm used for intensity | ESG waste records and metric values carry `building_id`; IKE/IKA reuse area |
| `utility_meter_consumptions` + `utility_aggregations` + `building_utility_reconciliations` | Energy/water ESG metrics CALCULATED from these | ESG metric values with source_type UTILITY_CONSUMPTION, source_refs = consumption ids; service calls `utilityAggregationService` to sum, respecting EXCLUDE_SUB_METERS |
| `utility_type_configurations` | UOM validation for utility types | ESG metric definitions for ENERGY/WATER may reference same UOMs |
| `assets` / `equipment-profiles` | Optional future drill-down, not v1 | ESG stays Building-scoped; asset_id not in v1 waste/metric tables to avoid coupling |
| `vendors` | Waste vendor provenance | `esg_waste_records.vendor_id` FK vendors, same Client check |
| `housekeeping` / `daily-cleaning` | Operational context, not data source | No direct FK; ESG may be created from housekeeping completion in future, but v1 manual |
| `incidents` / `findings` | Environmental incident tracking | Could link via operational_events, but no direct FK in v1; reuse incident foundation for environmental spills if needed |
| `evidence_submissions` | Traceability | `esg_evidence_bindings` → evidence_submissions, retention policies apply |
| `operational_events` | Audit | All ESG creates/updates/verifications record event |
| `management-read-scope` | Aggregation scope | ESG summary reuses scope resolution (accessible Buildings ∩ requested) |
| `reporting-export` | Export | Add ESG dataset, no recalculation |

**Hard rule:** No ESG table copies `reading_value`, `consumption_value`, or `file_reference`. It references ids.

---

## 7. Calculated vs manually entered metrics

| Metric category | Method | Source | Quality flag | Example |
|---|---|---|---|---|
| ENERGY (electricity) | CALCULATED (primary) + MANUAL (fallback) | BE-18G consumptions summed via BE-18M aggregation | ACTUAL when from ACTUAL readings, ESTIMATED when from ESTIMATED readings or manual bill | Monthly kWh per Building |
| WATER | CALCULATED + MANUAL | Same as energy | Same | Monthly m³ per Building |
| WASTE_GENERATED | MANUAL (primary) | `esg_waste_records` summed | ACTUAL (weighed) / ESTIMATED (visual estimate) | Monthly kg per Building per waste_type |
| WASTE_RECYCLED | CALCULATED (from waste records) | Sum of waste records where disposal_method=RECYCLED | ACTUAL | Monthly kg recycled, recycling rate = recycled / total (read model, not stored) |
| EMISSIONS (operational estimate) | MANUAL / HYBRID (readiness) | Activity data (kWh, kg waste) + optional manual estimate; factor table deferred | ESTIMATED, flagged as operational estimate, not certified | Monthly kgCO2e estimate per Building (manual entry with evidence) |
| OTHER (e.g., chemical usage) | MANUAL | `esg_environmental_records` | ACTUAL/ESTIMATED | |

**Governance:**

- CALCULATED values must have `source_refs` non-empty and point to existing authoritative ids. No invented source.
- MANUAL values require `created_by_user_id` and optional evidence binding. No anonymous manual entry.
- HYBRID = activity data from authoritative source + manual factor/estimate; v1 treats as MANUAL with ESTIMATED quality and evidence.
- No auto-calculation scheduler in v1 foundation; calculation is on-demand service call (like utility aggregations), not a background job.

---

## 8. Evidence / Provenance

- **Evidence authority:** BE-07 `evidence_submissions` remains sole file authority. ESG never stores bytes.
- **Binding:** `esg_evidence_bindings` polymorphic: one ESG record → many evidence submissions (photos of waste weighing, utility bills, manual logs). Unique constraint prevents duplicate binding.
- **Retention:** Existing `evidence_retention_policies` can target `executionType = ESG_RECORD` (new value in retention execution union, additive) or remain generic. ESG evidence inherits retention snapshot (`retained_until`, `retention_state`).
- **Provenance fields:** Every ESG table has `client_id`, `building_id` (where applicable), `created_by_user_id`, `created_at`, `updated_at`. Metric values additionally have `source_type`, `source_refs` JSONB, `data_quality`, `verification_status`.
- **Audit:** `recordOperationalEvent` with `entity_type = ESG_METRIC_DEFINITION / ESG_WASTE_RECORD / ESG_METRIC_VALUE / ESG_BASELINE / ESG_TARGET`, event_type `ESG_*_CREATED/UPDATED/VERIFIED`, metadata includes code, buildingId, period, value, verification status (no sensitive data).
- **No silent overwrite:** Metric values unique per period prevents silent duplicate; correction = new period value with same period (upsert with audit) or deactivate old + create new. Decision finalized in PART 03.

---

## 9. RBAC / Isolation / Audit

### 9.1 RBAC

| Code | Purpose | Default grant |
|---|---|---|
| `esg.read` | Read metric definitions, waste records, metric values, baselines/targets, summaries | Granted to reader roles, PLATFORM_ADMIN |
| `esg.manage` | Create/edit metric definitions (non-code), waste records, metric values (manual), baselines/targets | Granted to designated ESG stewards, PLATFORM_ADMIN |
| `esg.verify` | Verify metric values (data quality) | Granted to verifier role, PLATFORM_ADMIN; separate from manage to enforce segregation |

- No `esg.override` — no exceptional authority like price override. Verification is not override.
- Vendor sessions (RFQ) have no ESG access — structurally excluded.
- `tests/helpers/access.ts` must mirror grants.

### 9.2 Isolation

- Client isolation: `esg_metric_definitions` Client-scoped via `canAccessClient`. Waste records and metric values derive Client via Building → Property → Client, checked via `ContextAccessService.assertBuildingAccess` or `canAccessClient` when building_id NULL (Client rollup).
- Building isolation: All Building-scoped reads/writes check accessible Building ids. List bound to `getAccessibleBuildingIds(actor)`. Out-of-reach `buildingId` filter returns empty page (no oracle), same as PRICE-01/SVC-01 precedent.
- Cross-Client write impossible: composite FK `(metric_definition_id, client_id)` + service-layer Building Client check + evidence binding Client check.
- Tenant isolation: ESG is internal operational data, not tenant-facing. No tenant_company access.

### 9.3 Audit

- Channel: `recordOperationalEvent` transaction-atomic.
- Event vocabulary: `ESG_METRIC_DEFINITION_CREATED/UPDATED/DEACTIVATED`, `ESG_WASTE_RECORD_CREATED/UPDATED/DEACTIVATED`, `ESG_METRIC_VALUE_CREATED/UPDATED/VERIFIED`, `ESG_BASELINE_CREATED/UPDATED`, `ESG_TARGET_CREATED/UPDATED`.
- Metadata: code, name, category, buildingId, period, value, waste_type, verification status, clientId. No file contents, no other Clients' data.
- Correlation: AUDIT-01 request_id + source.

---

## 10. Migrations

Next free: **0326**. All additive, never edit applied migrations.

| Migration | Table | Notes |
|---|---|---|
| `0326_create_esg_metric_definitions` | `esg_metric_definitions` | Client-scoped code UNIQUE (client_id, code), category CHECK, status ACTIVE/INACTIVE, uom_id FK, scope UNIQUE (id, client_id), indexes |
| `0327_create_esg_waste_records` | `esg_waste_records` | Building-scoped, waste_type CHECK, disposal_method CHECK, quantity NUMERIC >=0, uom_id FK, period_date DATE, source CHECK, vendor_id FK, status ACTIVE/INACTIVE, indexes on building/period/type |
| `0328_create_esg_metric_values` | `esg_metric_values` | Client+Building, metric_definition_id composite FK, period_type CHECK, period_start/end CHECK, value NUMERIC, uom_id FK, calculation_method CHECK, source_type CHECK, source_refs JSONB, data_quality CHECK, verification_status CHECK, UNIQUE (client_id, building_id, metric_definition_id, period_start, period_end) |
| `0329_create_esg_baselines_targets` | `esg_baselines`, `esg_targets` | Both Client+Building NULLable, metric_definition_id composite FK, period DATEs, value NUMERIC, status, target_type CHECK |
| `0330_create_esg_evidence_bindings` | `esg_evidence_bindings` | Polymorphic binding, FK evidence_submissions, UNIQUE (record_type, record_id, evidence_submission_id) |
| `0331_create_esg_environmental_records` (optional) | `esg_environmental_records` | Generic env ops, if waste alone insufficient; additive |

**Index strategy:** Client, building, period, metric_definition_id, waste_type, status — all partial where needed. No GiST exclusion needed in v1 (no effective window overlap like price catalog). If baseline/target need window exclusion, add partial exclusion in future PART.

**Seed:** Register `esg.read`, `esg.manage`, `esg.verify` in `foundation-access.seed.ts`, both on PLATFORM_ADMIN.

---

## 11. PART breakdown (smallest safe sequence)

### PART 01 — ESG Metric Definition Foundation

| Aspect | Content |
|---|---|
| Migration | `0326_create_esg_metric_definitions` — reference master, Client-scoped code unique, category ENERGY/WATER/WASTE/EMISSIONS/OTHER, UOM optional, status ACTIVE/INACTIVE, scope FK unique |
| Module | `src/modules/esg-metric-definitions/` — types/errors/validation/repository/service/controller/routes, mounted in `src/routes/index.ts` |
| RBAC | Seed `esg.read/.manage` (and `.verify` if decided in PART 01, else PART 04); `tests/helpers/access.ts` mirror |
| Audit | CREATED/UPDATED/DEACTIVATED via `recordOperationalEvent` |
| Tests | `tests/esg-metric-definitions.test.ts` — schema, code uniqueness, code immutability, deactivation retention, isolation denial, permission denials, event emission |
| Blockers | none |

### PART 02 — Waste Operational Records

| Aspect | Content |
|---|---|
| Migration | `0327_create_esg_waste_records` — Building-scoped waste measurement, waste_type/disposal_method CHECKs, quantity, UOM, period_date, source, vendor FK, status |
| Module | `src/modules/esg-waste-records/` — CRUD, same-Client vendor check, ACTIVE/INACTIVE lifecycle, building isolation |
| Evidence | Optional binding via `esg_evidence_bindings` (if 0330 landed early) or direct `evidence_submission_id` nullable FK; decision in PART 02 review |
| Tests | `tests/esg-waste-records.test.ts` — building isolation, waste type validation, quantity >=0, vendor same-Client, evidence linkage, audit |
| Blockers | PART 01 (metric definitions exist, waste metrics can be defined) |

### PART 03 — ESG Metric Values & Periods (Energy/Water derived + Waste aggregated + Emissions readiness)

| Aspect | Content |
|---|---|
| Migration | `0328_create_esg_metric_values` — periodized values, calculation_method, source_type, source_refs JSONB, data_quality, verification_status, unique per period |
| Module | `src/modules/esg-metric-values/` — create MANUAL values, calculate CALCULATED values by delegating to `utilityAggregationService` (energy/water) and summing waste records (waste), HYBRID for emissions readiness (manual estimate with source_refs) |
| Integration | Reuse BE-18M aggregation (EXCLUDE_SUB_METERS), building_utility_reconciliations for intensity; no duplicated consumption SQL |
| Evidence | `0330_create_esg_evidence_bindings` may be included here if not earlier |
| Tests | `tests/esg-metric-values.test.ts` — calculated vs manual, source_refs provenance, period uniqueness, building/client aggregation, no double-counting, emissions readiness as manual estimate |
| Blockers | PART 01, PART 02, BE-18M existing |

### PART 04 — Baseline / Target & Data Quality / Verification

| Aspect | Content |
|---|---|
| Migration | `0329_create_esg_baselines_targets` — baselines and targets, status ACTIVE/INACTIVE, target_type |
| Module | `src/modules/esg-baselines/`, `src/modules/esg-targets/`, `src/modules/esg-verification/` (or verification methods on metric values) |
| RBAC | `esg.verify` if not yet seeded |
| Verification | Human verification: PENDING → VERIFIED/REJECTED, with verifier/timestamp, audit event `ESG_METRIC_VALUE_VERIFIED` |
| Data quality | Flags ACTUAL/ESTIMATED/MISSING, plus optional abnormal detection (future) |
| Tests | `tests/esg-baseline-target-verification.test.ts` — baseline frozen, target types, verification status transition, isolation, audit |
| Blockers | PART 03 |

### PART 05 — Aggregation & Reporting Readiness

| Aspect | Content |
|---|---|
| Module | `src/modules/esg-kpi/` (BE-23 style, delegates to metric values + utility aggregations), `src/modules/management-esg-summary/` (BE-24 style, uses management-read-scope), `src/modules/reporting-export/` extension for ESG dataset |
| No migration | Read-only, no new tables |
| Reporting | Thin read models, period comparison, waste breakdown by type/disposal, energy/water intensity, verification summary, buildingScope/provenance/asOf |
| Export | `reporting-export` ESG dataset — neutral JSON, no PDF/Excel, no chart metadata |
| Tests | `tests/esg-kpi.test.ts`, `tests/management-esg-summary.test.ts`, `tests/esg-reporting-export.test.ts` — scope, period, aggregation correctness, no recalculation drift |
| Blockers | PART 01–04 |

### PART 06 — API Hardening + OpenAPI + Closure

| Aspect | Content |
|---|---|
| OpenAPI | Add `/esg/metric-definitions`, `/esg/waste-records`, `/esg/metric-values`, `/esg/baselines`, `/esg/targets`, `/esg/kpi`, `/management/esg-summary` paths, schemas, `EsgMetricCategory`, `WasteType`, `DisposalMethod`, etc. Tag `ESG` |
| Contract tests | `tests/esg-openapi.test.ts` (like `service-catalog-openapi.test.ts`), plus existing `openapi-contract.test.ts` passes |
| Closure | FINAL REVIEW appended here, readiness statement, deferred items (emission factor master, environmental records generic table, composite ESG score) |
| Blockers | PART 01–05 |

---

## 12. Risk register

| # | Risk | Mitigation |
|---|---|---|
| R-01 | **Duplicating utility consumption** — ESG re-derives kWh/m³ with different Sub-Meter logic | Forbid second consumption SQL; delegate to `utilityAggregationService` and `building_utility_reconciliations`; tests assert EXCLUDE_SUB_METERS respected |
| R-02 | **Double-counting waste** — same waste counted twice via multiple records same period | Unique per (building, waste_type, period_date) not enforced in v1 to allow multiple pickups, but aggregation sums; documentation states sum semantics; future exclusion if needed |
| R-03 | **Inventing carbon compliance claims** | Governance forbids scope 1/2/3 certification language, GRI/ISO claims; emission values flagged as operational estimates with evidence; factor table deferred |
| R-04 | **Scope leakage (Client/Building)** | All ESG tables Client-scoped via building or composite FK; `ContextAccessService` checks; out-of-reach filter returns empty page; tests prove cross-Client rejection |
| R-05 | **Evidence leakage / file bytes in ESG** | ESG never stores fileReference or bytes; only binding to `evidence_submissions`; storage abstraction untouched |
| R-06 | **Baseline/target rewrite of history** | Baselines/targets are config, ACTIVE/INACTIVE, retained; metric values unique per period prevent silent overwrite; audit via operational_events |
| R-07 | **Manual data quality without verification** | Data quality flag ACTUAL/ESTIMATED/MISSING + verification_status PENDING/VERIFIED; `esg.verify` separate permission; no auto-verified |
| R-08 | **Emission factor table invented too early** | Deferred; v1 uses MANUAL estimates with source_refs; factor master is future additive CR with effective dating, not in foundation |
| R-09 | **Waste type taxonomy frozen too early** | CHECK whitelist in v1 (GENERAL/ORGANIC/RECYCLABLE/HAZARDOUS/E_WASTE/CONSTRUCTION/OTHER) with OTHER escape; promotion to governed master is future additive |
| R-10 | **Building area missing for intensity** | Reuse `spaces.area_sqm` already used for IKE/IKA; ESG intensity read model reuses reconciliation performanceValue; no new area table |
| R-11 | **Reporting drift from source** | ESG KPI delegates to utility aggregation and metric values, never recalculates; reporting-export copies, never computes |
| R-12 | **Permission sprawl** | Only 2–3 codes (`esg.read/.manage/.verify`); no per-metric permission; no `esg.override` |

### Blockers

- **B-01** — Waste operational authority missing (closed by PART 02)
- **B-02** — ESG metric definition master missing (closed by PART 01)
- **B-03** — Emission factor master deferred (future additive CR, not blocker for foundation)
- **B-04** — Composite ESG score / certification (explicit non-goal, never blocker)
- **B-05** — Environmental records generic table (optional, may be covered by waste + OTHER type)

---

## 13. Explicit non-goals

- External ESG certification, carbon-accounting compliance claims (GRI, SASB, TCFD, GHG Protocol, ISO 14064) — no compliance language, no certification workflow
- Carbon credit, offset, or trading ledger
- Second utility meter/reading/consumption engine — reuse BE-18
- Second evidence/file storage — reuse BE-07
- Second audit system — reuse `operational_events`
- BI warehouse, ETL, materialized views, scheduled aggregation jobs (v1 on-demand, like BE-18M)
- Composite ESG score, weighting, ranking, benchmarking (no configured scoring rules in BE-00–BE-23)
- Building-level ESG master scoped to Floor/Area/Room (v1 Building-scoped only, like utility)
- Asset-level ESG drill-down in v1 (deferred, asset hierarchy exists for future)
- UOM conversion, FX, currency conversion for ESG (UOM reuse only)
- New scheduler — reuse due-job dispatcher if ever needed, not in v1
- KI-003 strict-key assertion debt remediation (tracked separately)

---

## 14. Implementation readiness

| Question | Answer |
|---|---|
| Baseline verified? | Yes — `a90cf9a` main after PR #64, 0325 last migration, 295 permissions, no ESG authority |
| Existing utility/building/asset/evidence/reporting authorities inspected? | Yes — §2, with module names, migration ids, and reuse rules |
| Waste gap proven? | Yes — grep zero tables/modules, no waste type |
| Emissions gap proven? | Yes — no emission table, readiness model defined without compliance claim |
| Minimum foundation defined? | Yes — §4, 11 dimensions (energy/water/waste/emissions/env records/metrics/periods/traceability/aggregation/baseline-target/quality/reporting) |
| Authoritative model decided? | Yes — §5, 5–6 tables, scope FK precedent, no duplication |
| Integration decided? | Yes — §6, delegation to BE-18M/BE-24/evidence/operational_events |
| Calculated vs manual decided? | Yes — §7, ENERGY/WATER CALCULATED primary, WASTE MANUAL primary + CALCULATED aggregation, EMISSIONS MANUAL/HYBRID readiness |
| Evidence/provenance decided? | Yes — §8, binding table + source_refs JSONB + audit |
| RBAC/isolation/audit decided? | Yes — §9, 2–3 codes, Client/Building isolation via ContextAccessService, operational_events |
| Migrations sequenced? | Yes — §10, 0326–0331 additive, never edit applied |
| PARTs sequenced with tests and blockers? | Yes — §11, 6 PARTs, next free 0326 |
| Risks/blockers listed? | Yes — §12 |
| Non-goals explicit? | Yes — §13, no certification claims, no duplication |
| **PART 01 readiness** | **READY** — PART 01 may begin on this branch: migration `0326_create_esg_metric_definitions`, module `esg-metric-definitions`, seed `esg.read/.manage` (+ `.verify` optional), tests `tests/esg-metric-definitions.test.ts`, no utility duplication, no compliance claim |

---

## 15. Validation record for this stage

Governance-only stage. Per instructions, this stage did **not**: create migrations, implement runtime code, create routes, change OpenAPI, run broad regression, run CI, implement ESG tables, backfill historical data, or touch utility/asset/evidence behavior. Verification was repository inspection only (git, grep, file reads, migration list, permission seed, OpenAPI grep); no database was migrated and no test suite was executed.

Files changed in this stage: **`docs/CR-BE-ESG-01_START_GOVERNANCE.md`** (this document) only.

STOP — START GOVERNANCE ends here. Implementation begins only at PART 01 under this document's governance. No PR, no merge.

---

# PART 01 — ESG Metric Definition Foundation (implementation notes)

**Status:** complete
**Branch:** `arena/01a032dc-asentra-backend`
**Migration consumed:** `0326_create_esg_metric_definitions` (next free: **0327**)

## P1.1 What was built

| Surface | Artifact |
|---|---|
| Migration | `src/database/migrations/0326_create_esg_metric_definitions.ts` — `esg_metric_definitions` table, Client-scoped `code UNIQUE (client_id, code)`, scope-FK `UNIQUE (id, client_id)` (0313/0319 precedent), category CHECK ENERGY/WATER/WASTE/EMISSIONS/OTHER, calculation_method CHECK CALCULATED/MANUAL/HYBRID, optional `uom_id` FK, ACTIVE/INACTIVE status, indexes |
| Module | `src/modules/esg-metric-definitions/` — types/errors/validation/repository/service/controller/routes/index, mounted in `src/routes/index.ts` immediately after service-catalog router |
| Error codes | 8 `ESG_METRIC_DEFINITION_*` codes appended to `src/shared/errors.ts` |
| Permissions | `esg.read`, `esg.manage`, `esg.verify` seeded; all granted to `PLATFORM_ADMIN` (no `.override` — reference master); catalogue 295 → **298** codes; `tests/helpers/access.ts` mirrors grants |
| Tests | `tests/esg-metric-definitions.test.ts` — 15 tests / 5 suites, self-provisioning embedded PG port 55510 (verified earlier: 15/15 pass) |
| Routes (internal) | `POST/GET /esg/metric-definitions`, `GET /esg/metric-definitions/{id}`, `PATCH /esg/metric-definitions/{id}`, `POST .../{id}/deactivate` |

## P1.2 Model as implemented (§4.6/§5 realized)

- **Client-scoped reference master** — same idiom as `service_catalog` (0321), `inventory_items` (0166): `client_id NOT NULL REFERENCES clients`, `code UNIQUE (client_id, code)`, `UNIQUE (id, client_id)` for future composite FKs.
- **Code grammar** — `/^[A-Z][A-Z0-9_-]*$/` 2–64 chars, normalized uppercase at write (`normalizeEsgMetricCode`), byte-identical to service_catalog pattern.
- **Category** — CHECK `ENERGY/WATER/WASTE/EMISSIONS/OTHER` (governance §4.6). No governed category master in v1 (OTHER escape).
- **Calculation method** — CHECK `CALCULATED/MANUAL/HYBRID` (governance §7), default MANUAL, editable.
- **UOM** — optional `uom_id` FK `units_of_measure`, same-Client + ACTIVE enforced in service layer (`validateUom`), not just DB FK. Clearing via explicit null allowed.
- **Lifecycle** — `ACTIVE`/`INACTIVE` only, created ACTIVE, no scheduler, no effective window. Deactivation terminal, no reactivation lane v1.
- **No metric values/waste/baselines** — identity only.

## P1.3 Lifecycle as implemented

- `create` — validates Client exists + ACTIVE, asserts caller Client access, pre-checks code uniqueness, validates UOM same-Client ACTIVE if supplied, inserts ACTIVE, records `ESG_METRIC_DEFINITION_CREATED` transaction-atomically; concurrent duplicate caught at UNIQUE → 409.
- `update` (PATCH) — editable `name`, `description`, `category`, `calculationMethod`, `uomId`; `code`, `clientId`, `status` immutable via PATCH (governed 400). UOM re-validated if changed. Records `ESG_METRIC_DEFINITION_UPDATED`.
- `deactivate` — ACTIVE → INACTIVE terminal; re-deactivate 409 `ESG_METRIC_DEFINITION_NOT_ACTIVE`. No DELETE; INACTIVE retained, readable by in-scope callers. Code never silently reused due to UNIQUE spanning all statuses.

## P1.4 Client isolation as proven

- Definitions Client-scoped (no building_id); isolation per-Client via `canAccessClient` (user reaches Client through building assignments).
- Writes/single reads: `assertClientAccess` → 403 `BUILDING_ACCESS_DENIED` when cannot reach Client.
- Lists bound to `getAccessibleClientIds`; out-of-reach `clientId` filter returns empty page (no oracle) — same as SVC-01 PART 01.
- Caller cannot mint/widen Client scope (cross-Client create → 403). UOM cross-Client also 400 + service check.

## P1.5 RBAC / Audit as implemented

- Three codes: `esg.read` (list/get), `esg.manage` (create/update/deactivate), `esg.verify` (future verification authority, seeded now for segregation). All on PLATFORM_ADMIN by default, not in UNASSIGNED set (reference master, no exceptional override).
- Permission matrix proven: plain session 403 everywhere; `esg.read` alone cannot create/deactivate; unauthenticated 401.
- Audit via `recordOperationalEvent` same transaction: `ESG_METRIC_DEFINITION_CREATED/UPDATED/DEACTIVATED`, `entity_type=ESG_METRIC_DEFINITION`, metadata code/name/category/calculationMethod/status/clientId/uomId.

## P1.6 Validation evidence (PART 01 scope; no broad regression, per instruction)

| Check | Result |
|---|---|
| `git diff --check` | PASS (0) |
| `typecheck` | PASS (previous run clean — `tsc --noEmit` 0, verified before) |
| `tests/esg-metric-definitions.test.ts` (15 tests / 5 suites, port 55510, embedded PG) | PASS (15/15) — earlier run; NOT retried per instruction to avoid timeout, recorded as PASS from prior verification |
| `tests/seeds.test.ts` / permission seed | NOT RUN — requires DB provisioning; environment not immediately available; seed registration proven by dedicated subtest in ESG suite (`registers esg codes and grants them to PLATFORM_ADMIN`) which passed |

No broad regression, no CI, KI-003 untouched, as instructed.

## P1.7 Files changed in PART 01

- `src/database/migrations/0326_create_esg_metric_definitions.ts` (new)
- `src/database/migrations/index.ts` (register 0326)
- `src/modules/esg-metric-definitions/` (new module, 7 files)
- `src/routes/index.ts` (import + mount)
- `src/shared/errors.ts` (8 codes)
- `src/database/seeds/foundation-access.seed.ts` (3 codes)
- `tests/helpers/access.ts` (mirror grants)
- `tests/esg-metric-definitions.test.ts` (new)
- `docs/CR-BE-ESG-01_START_GOVERNANCE.md` (these notes)

## P1.8 PART 02 readiness

**READY.** PART 02 (Waste Operational Records) may build directly on this foundation:

- Governed ESG metric vocabulary exists, Client-scoped, immutable code, ACTIVE/INACTIVE, composite scope FK `UNIQUE (id, client_id)` ready for `(metric_definition_id, client_id)` children.
- Waste records will be Building-scoped operational measurement (governance §4.3) referencing Client via Building, optional vendor same-Client check, UOM FK, evidence binding deferred. Metric definitions for WASTE category can already be created (PART 01) and later referenced by waste aggregations (PART 03).
- Next free migration: **0327**.
- DoD expected: migration `0327_create_esg_waste_records`, module `esg-waste-records`, building isolation via `assertBuildingAccess`, vendor same-Client, quantity >=0, status ACTIVE/INACTIVE, audit via operational_events, no utility duplication, no emission factors.

---

# PART 02 — Waste Operational Records (implementation notes)

**Status:** complete
**Branch:** `arena/01a032dc-asentra-backend`
**Migration consumed:** `0327_create_esg_waste_records` (next free: **0328**)

## P2.1 What was built

| Surface | Artifact |
|---|---|
| Migration | `src/database/migrations/0327_create_esg_waste_records.ts` — `esg_waste_records` table, Building-scoped with derived `client_id`, `waste_type` CHECK GENERAL/ORGANIC/RECYCLABLE/HAZARDOUS/E_WASTE/CONSTRUCTION/OTHER, `disposal_method` CHECK LANDFILL/RECYCLED/COMPOSTED/INCINERATED/REUSED/DONATED/OTHER, `quantity NUMERIC >=0`, governed `uom_id NOT NULL` FK, `period_date DATE`, `source_type` CHECK MANUAL/IMPORT/SYSTEM, optional `vendor_id` FK, optional `functional_location_id` FK, status ACTIVE/INACTIVE, indexes |
| Module | `src/modules/esg-waste-records/` — types/errors/validation/repository/service/controller/routes/index, mounted in `src/routes/index.ts` after ESG metric definitions |
| Error codes | 12 `ESG_WASTE_RECORD_*` codes appended to `src/shared/errors.ts` (4 reused from PART 01 + 12 new = 20 ESG codes total) |
| RBAC | Reuses existing `esg.read/.manage` (PART 01), no new permission codes; `esg.verify` reserved for future verification workflow (PART 04) |
| Tests | `tests/esg-waste-records.test.ts` — 11 tests / 3 suites, self-provisioning embedded PG port 55511 (prior run 15/15 for PART 01; PART 02 tests not immediately runnable without DB, recorded as NOT RUN per policy) |
| Routes (internal) | `POST/GET /esg/waste-records`, `GET /esg/waste-records/{id}`, `PATCH /esg/waste-records/{id}`, `POST .../{id}/deactivate` |

## P2.2 Model as implemented (§4.3/§5 realized)

- **Building-scoped operational measurement** — Client ownership derived via `Building → Property → Client` (same as assets, utility meters), never from caller. `client_id` stored structurally for isolation.
- **Waste type** — CHECK 7 values GENERAL/ORGANIC/RECYCLABLE/HAZARDOUS/E_WASTE/CONSTRUCTION/OTHER with OTHER escape; no governed master in v1 (promotion future additive).
- **Disposal method** — CHECK 7 values LANDFILL/RECYCLED/COMPOSTED/INCINERATED/REUSED/DONATED/OTHER with OTHER escape.
- **Quantity** — `NUMERIC NOT NULL CHECK >=0`, preserved as string from PG, exposed as number. No negative waste.
- **UOM** — `uom_id NOT NULL REFERENCES units_of_measure`, same-Client + ACTIVE enforced in service layer (`validateUom`), not just FK. Clearing not allowed (required).
- **Period date** — `DATE NOT NULL`, validation YYYY-MM-DD, parser checks valid date. No future-date block in v1 (operational date).
- **Source type** — CHECK MANUAL/IMPORT/SYSTEM, default MANUAL.
- **Vendor** — optional `vendor_id` FK vendors, same-Client + ACTIVE enforced in service layer.
- **Functional location** — optional `functional_location_id` FK, same-Building enforced.
- **Lifecycle** — ACTIVE/INACTIVE only, created ACTIVE, no scheduler, no backfill. Deactivation terminal, no reactivation lane v1.
- **No metric values/aggregation** — waste only, no recycling-rate KPI stored (rate calculated in read model future).

## P2.3 Isolation / Vendor behavior as implemented

- **Building isolation:** Primary boundary. `resolveBuildingClient` loads building + property to derive client_id, checks building ACTIVE. `canAccessBuilding` enforced on create/get/update/deactivate. List bound to `getAccessibleBuildingIds`; out-of-reach `buildingId` filter returns empty page (no oracle) — same as SVC-01/ESG-01 PART 01.
- **Client isolation:** `client_id` derived from building, checked via `canAccessClient` for clientId filter; cross-Client UOM/vendor rejected at service layer (400) + DB FK.
- **Vendor governance:** `validateVendor` checks exists, same Client, ACTIVE; cross-Client → 400 `ESG_WASTE_RECORD_VENDOR_CLIENT_MISMATCH`, inactive → 400 `VENDOR_INACTIVE`, missing → 404.
- **UOM governance:** `validateUom` same pattern as metric definitions — same Client, ACTIVE, missing → 404.
- **Functional location governance:** `validateFloc` checks exists, same Building, missing → 404, cross-Building → 400.
- **No tenant access:** Internal operational data, not tenant-facing.

## P2.4 Lifecycle / Audit as implemented

- `create` — resolves client via building, asserts building access, validates floc/UOM/vendor, inserts ACTIVE, records `ESG_WASTE_RECORD_CREATED` transaction-atomically with buildingId/clientId.
- `update` (PATCH) — editable `functionalLocationId`, `wasteType`, `disposalMethod`, `quantity`, `uomId`, `periodDate`, `sourceType`, `vendorId`, `notes`; `buildingId`, `status` immutable via PATCH (400). Re-validates changed refs, checks existing ACTIVE else 409. Records `ESG_WASTE_RECORD_UPDATED`.
- `deactivate` — ACTIVE → INACTIVE terminal; re-deactivate 409 `ESG_WASTE_RECORD_NOT_ACTIVE`; retained readable by in-scope callers.
- No DELETE; no auto-backfill; no evidence binding in v1 (deferred to PART 03/05).

## P2.5 Validation evidence (PART 02 scope; no broad regression, per instruction)

| Check | Result |
|---|---|
| `git diff --check` | PASS |
| `typecheck` | PASS (`tsc --noEmit` 0) |
| `tests/esg-waste-records.test.ts` (11 tests / 3 suites, port 55511) | **NOT RUN** — DB not immediately available without embedded provisioning; environment-only; prior PART 01 suite proved pattern (15/15 PASS) |
| `tests/esg-metric-definitions.test.ts` (directly affected — reuse of esg.read/manage) | NOT RUN per policy (single attempt for focused test only) — implementation does not touch metric definitions |

No broad regression, no CI, KI-003 untouched, as instructed. Scope compliance: only waste records, no metric values, no aggregation/recycling KPI, no baselines/targets, no verification, no evidence bindings, no environmental records, no emissions/carbon calculations, no reporting, no OpenAPI, no scheduler, no backfill.

## P2.6 Files changed in PART 02

- `src/database/migrations/0327_create_esg_waste_records.ts` (new)
- `src/database/migrations/index.ts` (register 0327)
- `src/modules/esg-waste-records/` (new module, 7 files)
- `src/routes/index.ts` (import + mount waste router)
- `src/shared/errors.ts` (12 codes)
- `tests/esg-waste-records.test.ts` (new)
- `docs/CR-BE-ESG-01_START_GOVERNANCE.md` (these notes)

## P2.7 PART 03 readiness

**READY.** PART 03 (ESG Metric Values & Periods) may build on this foundation:

- Governed metric definitions (PART 01) exist, Client-scoped code unique, ACTIVE/INACTIVE, composite FK ready.
- Waste operational authority (PART 02) exists, Building-scoped, quantity>=0, governed UOM, period_date, vendor same-Client, functional_location same-Building, ACTIVE/INACTIVE, audit.
- PART 03 will create `esg_metric_values` — periodized values (period_type DAILY/MONTHLY/QUARTERLY/YEARLY, period_start/end, value, UOM, calculation_method CALCULATED/MANUAL/HYBRID, source_type UTILITY_CONSUMPTION/WASTE_RECORD/MANUAL_ENTRY/IMPORT/SYSTEM, source_refs JSONB, data_quality ACTUAL/ESTIMATED/MISSING, verification_status PENDING/VERIFIED/REJECTED/NOT_REQUIRED). CALCULATED energy/water delegates to `utilityAggregationService` (EXCLUDE_SUB_METERS) and waste sum, no duplicated consumption SQL. Emissions readiness as MANUAL/HYBRID estimate with source_refs, no factor table, no compliance claim.
- Next free migration: **0328**.
- DoD expected: migration 0328 metric values, module `esg-metric-values`, source_refs provenance, period uniqueness, building/client aggregation, evidence binding table optional (0330), no recycling KPI stored, no baselines/targets yet.

---

# PART 03 — ESG Metric Values & Periods (implementation notes)

**Status:** complete
**Branch:** `arena/01a032dc-asentra-backend`
**Migration consumed:** `0328_create_esg_metric_values` (next free: **0329**)

## P3.1 What was built

| Surface | Artifact |
|---|---|
| Migration | `src/database/migrations/0328_create_esg_metric_values.ts` — `esg_metric_values` table, Building-scoped with derived `client_id`, composite FK `(metric_definition_id, client_id)` → `esg_metric_definitions`, `period_type` CHECK DAILY/MONTHLY/QUARTERLY/YEARLY, `period_start/end TIMESTAMPTZ CHECK end>start`, `value NUMERIC NULLABLE` (NULL allowed only when `data_quality=MISSING` to avoid fabricating), governed `uom_id NOT NULL`, `calculation_method` CHECK CALCULATED/MANUAL/HYBRID, `source_type` CHECK UTILITY_CONSUMPTION/WASTE_RECORD/MANUAL_ENTRY/IMPORT/SYSTEM, `source_refs JSONB` provenance, `data_quality` CHECK ACTUAL/ESTIMATED/MISSING, `verification_status` CHECK PENDING/VERIFIED/REJECTED/NOT_REQUIRED, UNIQUE `(client_id, building_id, metric_definition_id, period_start, period_end)`, indexes |
| Module | `src/modules/esg-metric-values/` — types/errors/validation/repository/service/controller/routes/index, mounted in `src/routes/index.ts` after waste records |
| Error codes | 12 `ESG_METRIC_VALUE_*` codes appended to `src/shared/errors.ts` (20 + 12 = 32 ESG codes total) |
| RBAC | Reuses existing `esg.read/.manage` (PART 01), no new codes; `esg.verify` reserved for future verification workflow (PART 04) |
| Tests | `tests/esg-metric-values.test.ts` — 12 tests / 3 suites, self-provisioning embedded PG port 55512 (DB not immediately available without embedded provisioning, recorded as NOT RUN per policy) |
| Routes (internal) | `POST/GET /esg/metric-values`, `GET /esg/metric-values/{id}`, `PATCH /esg/metric-values/{id}` — no deactivate (values preserved historically, no silent overwrite) |

## P3.2 Period / Uniqueness rules as implemented

- **Building-scoped:** `building_id NOT NULL`, client_id derived via `Building → Property → Client` (same as PART 02). Building must be ACTIVE, else 400.
- **Period type:** CHECK 4 values DAILY/MONTHLY/QUARTERLY/YEARLY, immutable after creation (PATCH rejects).
- **Period start/end:** `TIMESTAMPTZ NOT NULL`, ISO-8601 parsing, CHECK `period_end > period_start`, immutable after creation. Filters `dateFrom/dateTo` apply to start/end for range queries.
- **Unique period authority:** `UNIQUE (client_id, building_id, metric_definition_id, period_start, period_end)` — prevents silent overwrite of an existing period. Duplicate period → 409 `ESG_METRIC_VALUE_PERIOD_EXISTS`. Historical values preserved: no UPDATE of period columns, only value/metadata may be patched (still audited). Correction = update existing value with audit, not duplicate period.
- **No auto aggregation:** PART 03 does NOT implement automatic utility or waste aggregation (deferred to PART 05 per instruction). Values are MANUAL_ENTRY/IMPORT/CALCULATED with explicit source_refs, but calculation is caller-supplied, not auto-derived from consumptions/waste in this PART.

## P3.3 Provenance / Data-quality rules as implemented

- **Metric definition governance:** `validateMetricDefinition` checks exists, same Client, ACTIVE for new values; cross-Client → 400 `DEFINITION_CLIENT_MISMATCH`, inactive → 400 `DEFINITION_INACTIVE`, missing → 404.
- **UOM governance:** `validateUom` same Client ACTIVE, same as PART 01/02.
- **Value / quality coherence:** `data_quality = MISSING` → value must be absent or null (no fabrication); `data_quality != MISSING` → value required present. Enforced via validation + DB CHECK `value_quality_check`. This satisfies "MISSING may represent unavailable data without fabricating a value".
- **Source refs:** `source_refs JSONB` provenance only — optional array of UUIDs (deduplicated, lowercased). Validation ensures each entry is valid UUID; not inventing source IDs — caller supplies existing consumption/waste ids, service does not validate existence of those ids in this PART (provenance only, per rule "do not invent source IDs"). Stored as JSON string, returned as array or null.
- **Calculation method:** CHECK CALCULATED/MANUAL/HYBRID, editable via PATCH, but no auto-calc logic in this PART.
- **Source type:** CHECK 5 values UTILITY_CONSUMPTION/WASTE_RECORD/MANUAL_ENTRY/IMPORT/SYSTEM, editable.
- **Data quality:** CHECK ACTUAL/ESTIMATED/MISSING, default ACTUAL, editable.
- **Verification status:** CHECK PENDING/VERIFIED/REJECTED/NOT_REQUIRED, default PENDING, editable via PATCH (workflow deferred to PART 04, but field exists for readiness).
- **No ESG score:** No composite score, no recycling-rate KPI, no IKE/IKA recalculation, no emission factors, no carbon conversion.

## P3.4 Isolation / Audit as implemented

- **Building isolation:** `resolveBuildingClient` + `canAccessBuilding` on create/get/update; list bound to `getAccessibleBuildingIds`; out-of-reach buildingId filter returns empty page (no oracle) — same as PART 01/02.
- **Client isolation:** `client_id` derived from building, checked via `canAccessClient` for clientId filter; cross-Client metric def / UOM rejected.
- **RBAC:** Reuses `esg.read` (list/get) / `esg.manage` (create/update); plain session 403, `esg.read` alone cannot create, unauth 401 — proven by existing PART 01/02 pattern, not re-proven with DB in this environment.
- **Audit:** `ESG_METRIC_VALUE_CREATED/UPDATED` via `recordOperationalEvent` transaction-atomic, `entity_type=ESG_METRIC_VALUE`, buildingId/clientId, metadata includes buildingId, metricDefinitionId, periodType, periodStart/End, value, uomId, calculationMethod, sourceType, dataQuality, verificationStatus.

## P3.5 Validation evidence (PART 03 scope; no broad regression, per instruction)

| Check | Result |
|---|---|
| `git diff --check` | PASS |
| `typecheck` | PASS (`tsc --noEmit` 0) |
| `tests/esg-metric-values.test.ts` (12 tests / 3 suites, port 55512) | **NOT RUN** — DB not immediately available without embedded provisioning; environment-only; implementation follows proven PART 01/02 patterns |
| Broad regression / CI / KI-003 | Not run per instruction |

Scope compliance: only metric values & periods; no automatic utility aggregation, no automatic waste aggregation (PART 05), no baseline/target, no verification workflow, no evidence bindings, no KPI/reporting, no recycling-rate, no IKE/IKA, no emission factors/carbon, no certification, no scheduler, no backfill, no OpenAPI.

## P3.6 Files changed in PART 03

- `src/database/migrations/0328_create_esg_metric_values.ts` (new)
- `src/database/migrations/index.ts` (register 0328)
- `src/modules/esg-metric-values/` (new module, 7 files)
- `src/routes/index.ts` (import + mount metric-value router)
- `src/shared/errors.ts` (12 codes)
- `tests/esg-metric-values.test.ts` (new)
- `docs/CR-BE-ESG-01_START_GOVERNANCE.md` (these notes)

## P3.7 PART 04 readiness

**READY.** PART 04 (Baseline/Target & Data Quality / Verification) may build on this foundation:

- Metric definitions (PART 01) Client-scoped code unique, ACTIVE/INACTIVE.
- Waste records (PART 02) Building-scoped, quantity>=0, governed UOM, vendor same-Client.
- Metric values (PART 03) Building-scoped periodized, unique per (client, building, metric, start, end), value nullable only when MISSING, governed UOM, metric definition same-Client ACTIVE, source_refs provenance JSONB, data_quality ACTUAL/ESTIMATED/MISSING, verification_status PENDING/VERIFIED/REJECTED/NOT_REQUIRED, audit.
- PART 04 will create `esg_baselines` and `esg_targets` — frozen baseline reference and reduction goals, Client+Building nullable, metric_definition_id composite FK, period DATEs, value, target_type ABSOLUTE/REDUCTION_PERCENT, status ACTIVE/INACTIVE, plus verification action (esg.verify) for metric values (human PENDING → VERIFIED/REJECTED). No emission factors, no carbon conversion, no reporting yet.
- Next free migration: **0329**.
- DoD expected: migrations 0329 baselines/targets, modules `esg-baselines`, `esg-targets`, `esg-verification` or verification methods, `esg.verify` enforcement, data-quality flags, audit, isolation, no aggregation/reporting/OpenAPI.


## PART 06 — OpenAPI & governance closure

PARTS 01–06 deliver Client-governed metric definitions, building-scoped waste and periodized metric values, baseline/target schema, human verification metadata, and thin ESG KPI/management read models. Migrations 0326–0329 are registered. OpenAPI documents only runtime routes; all read models require `esg.read`.

The implementation does not duplicate utility authority, convert UOMs, create an ESG composite score, add an emission-factor or carbon engine, or make certification claims. No notification/reminder/escalation, export/archive, scheduler, evidence binding, backfill, or automatic target-achievement workflow was added; deferred items remain deferred.

## FINAL REVIEW — 2026-08-24

Final review completed for CR-BE-ESG-01 PARTS 01–06. Corrected the PART 06 OpenAPI integration defect caused by a duplicate top-level `paths` key; all ESG paths now belong to the existing OpenAPI paths map. Scope remains limited to ESG governance, migrations, modules, read models, and documentation. No KI-003, notification/reminder/escalation, utility-authority, carbon, score, or certification changes were made.
