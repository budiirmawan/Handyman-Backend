# CR-HM-02 — SERVICE CATALOGUE & REQUEST INTAKE — START GOVERNANCE

**Status:** START GOVERNANCE (mapping only — no runtime code)
**Repo:** Handyman-Backend
**Base HEAD:** `b88bea1166bbaf7fff5f2b658a50fb5a4721c3fd` (CR-HM-01 certified COMPLETE)
**Frozen inputs:** `HANDYMAN_CR_CODING_ROADMAP_v1.0.md` (CR-HM-02 §, §Matrix rows 3/6/14),
`CR-HM-00_BACKEND_CAPABILITY_MAP.md` (FROZEN classify: EXTEND rows —
Tenant Service Request, Service Catalog, Evidence, Price Catalog,
Inventory/Material), `CR-HM-01_START_GOVERNANCE.md`, `CR-HM-01_FINAL_VALIDATION.md`.

Frozen CR-HM-02 scope (roadmap): Handyman Service Catalogue;
service/variant/common-material reference exposure; Handyman Service
Request; photo/video/evidence intake seam. Primary authority:
Handyman-Backend. Roadmap row 14: full evidence lifecycle authority closes
in CR-HM-10 — CR-HM-02 delivers the evidence INTAKE seam only, as a bounded
interface. Dependencies: CR-HM-01 (satisfied).

---

## 1. Seam inventory & decisions

### A. Catalogue

| Concern | Existing seam | Decision | Notes |
|---|---|---|---|
| Service master | `src/modules/service-catalog` (migration `0321`): Client-scoped, `code/name/description/category`, ACTIVE/INACTIVE; REST `/service-catalog/entries` (staff RBAC); FM anchor `service_requests.serviceCatalogId` (`0322`) | REUSE + EXTEND | Reuse master as-is; Handyman catalogue exposure is a bounded read surface over ACTIVE entries. |
| Variants | none anywhere | **NEW** | Handyman-governed Service Variant as child of `service_catalog` entry (frozen chain: Service → Service Variant → Common Material Profile → …). No existing variant notion in repo. |
| Image/media | none on `service_catalog` or `inventory_items` | **NEW** | Bounded image reference on catalogue/variant/material reference exposure. No existing image field on either master; storage seam must be decided (blocker #1) without inventing new infra. |
| Reference price | `src/modules/price-catalog-entries` (`0319`) + `price-catalog-lookup.service.ts`: governed DRAFT→ACTIVE→INACTIVE, `sourceMode` MATERIAL/SERVICE, `serviceId`/`itemId` subjects, REFERENCE kind, currency, effective window | REUSE | Exposure = lookup/join at read time. **Reference Price != Quotation != Final Charge.** |
| Common-material association | none (no link Service/Material exists) | **NEW** | Bounded association: Variant → Material/SKU reference chain (see B). Read-only discovery; never inventory behavior. |

### B. Material reference

| Concern | Existing seam | Decision | Notes |
|---|---|---|---|
| Material/SKU source | `src/modules/inventory-items` (`0166`): Client-scoped `code/name/itemType(SPARE_PART/MATERIAL/CONSUMABLE)/category/uomId/description`, ACTIVE/INACTIVE, resolved UOM | REUSE | Master stays as-is; Handyman references bounded fields only. |
| Specification/compatibility | none | **NEW** | Bounded Handyman-facing fields on the material reference exposure — not on the inventory master itself. |
| Image support | none | **NEW** | Same image-seam decision as catalogue (blocker #1). |
| Reference price | `price-catalog-entries` MATERIAL + `itemId` + `uomId` (+lookup) | REUSE | Input/reference only. |
| Typical quantity | none | **NEW** | On the Handyman material profile (UOM grounded by item `uomId`). |
| Commonality | none | **NEW** | Governed Handyman classification on the profile. |
| Customer material option | none | **NEW** | Bounded exposure config (whether customer supplies/chooses material). |

**Boundary:** Common Material Profile is reference/discovery only — it is
NOT an inventory reservation, issue, movement, purchase, or usage; no writes
into `material-requests` / `inventory-*` / `purchase-*` flows.

### C. Request intake

| Concern | Existing seam | Decision | Notes |
|---|---|---|---|
| Lifecycle seam | `src/modules/tenant-service-requests` (`0148`): statuses OPEN/CANCELLED/CONVERTED; actions UPDATE/CANCEL/CREATE_WORK_REQUEST/CREATE_WORK_ORDER; staff-gated REST (`tenant_company.read/manage`) | EXTEND | Frozen map: extend for Handyman customer request lifecycle; **Handyman lifecycle/states remain distinct** and never absorb FM OPEN→CONVERTED conversion (`workRequestId`/`workOrderId` belong to FM flow). |
| Customer/building/unit context | record carries `clientId, tenantCompanyId, tenantPicId(required), buildingId, spaceId?, requestedAt` | REUSE pattern | Handyman intake context comes from the consumed CR-HM-01 exchange/attribution — identical field set, server-derived. |
| Service/variant selection | none on TSR (`requestType` is free-text FM type; catalog anchor exists only on FM `service_requests`) | **NEW** | Bounded `serviceCatalogId` + Handyman variant reference at intake. |
| Description | exists (`description`, `title`) | REUSE | — |
| Initial evidence linkage | none on TSR row | **NEW** | See D — intake evidence binding at request creation. |
| Channel-attribution binding | none; `intakeChannel` is legacy `IntakeChannel` vocabulary (PORTAL/MOBILE/PHONE/WHATSAPP/EMAIL/WALK_IN/FRONT_DESK/OTHER — **no BM_SUPER_APP**); CR-HM-01 established NEW origin-channel authority apart from IntakeChannel | **NEW** | Immutable `handyman_channel_attributions.id` bound server-side at creation, derived ONLY from the CR-HM-01 authority chain (consumed exchange → attribution). **Never accept caller-supplied BM/channel authority; never set IntakeChannel to imply it.** Roadmap: attribution authority delivered in CR-HM-01, its request-lifecycle binding exercised/verified here. |

**Boundaries:** Request intake != triage/inspection/diagnosis (CR-HM-03);
request creation != quotation (CR-HM-06); no FM workflow introduction;
FM/common-building excluded cases (frozen exclusion list in backend map)
remain refer/escalate only.

### D. Evidence

| Concern | Existing seam | Decision | Notes |
|---|---|---|---|
| Image/file evidence seam | `src/modules/evidence`: `evidence_requirements` + `evidence_submissions` (0072/0073) polymorphic parent `execution_type/execution_id`; `EVIDENCE_TYPES = PHOTO/DOCUMENT/SIGNATURE`; per-type MIME allowlists (jpeg/png/webp; svg; pdf); ≤50MB; server-side SHA-256 integrity (0303); retention/hold/purge (0304/0305); storage abstraction `evidence/storage`; file API `POST/GET /evidence/:id/file(/content)`; parent-admission convention (e.g. `UTILITY_METER_READING`, `DAILY_CLEANING`) | EXTEND | Admit a Handyman intake parent kind following the existing admission convention (application union + DB CHECK via migration); bind at request intake. |
| VIDEO support | **none** (zero video hits; MIME tables are image/pdf only) | **NEW** | Bounded VIDEO intake extension within the same evidence engine (MIME/size policy for freeze — blocker #2). |
| Intake-stage vocabulary | none for Handyman (engine is type-level: PHOTO/DOCUMENT/SIGNATURE) | **NEW (bounded)** | CR-HM-02 = INTAKE stage only. Full Handyman stage vocabulary (BEFORE/DURING/AFTER/QC/DEFECT/RECTIFICATION/MATERIAL/BAST/WARRANTY) and QC/verification behavior close in CR-HM-10 — out of scope here (frozen roadmap row 14). |

---

## 2. Contract dependencies

- **CR-HM-01 (satisfied):** immutable attribution + canonical handoff context
  are the sole provenance authority for BM-originated intake (frozen D1–D3
  and PART 05 API `/api/v1/handoff/*`).
- **CR-HM-10 (forward, bounded):** evidence lifecycle/QC/stage vocabulary —
  this CR must not pre-build it; intake seam is a bounded interface only.
- **CR-HM-03/06/09 (excluded):** triage/diagnosis, quotation/pricing
  execution, material lifecycle — not in CR-HM-02 scope.
- **OpenAPI:** catalogue/request/intake surfaces (PART 05) must document
  only the implemented contract; catalogue reference data carries the
  reference-vs-transaction boundary text.

## 3. Security / authority boundaries

- Channel Attribution is consumed as **authoritative provenance**; BM or
  channel identity is never caller-supplied, never inferred from
  `IntakeChannel`, and attribution is immutable after binding.
- Backend remains sole authorization authority; customer-context intake
  derives company/building/unit from the attribution/canonical context, not
  from request fields.
- Staff RBAC seams (`tenant_company.*`, `service_catalog.*`,
  `evidence.*` permissions) are unchanged; any customer-facing catalogue/
  intake read surface is bounded public shape only (no internal reference
  leakage: governed staff-only price/entry internals stay internal).
- Catalogue Reference Price != Quotation != Final Charge.
- Common Material Profile != inventory reservation/issue/movement/purchase.
- Request Intake != Triage/Diagnosis; Request Creation != Quotation.
- No FM workflows; excluded FM/common-building systems stay refer/escalate.
- No SaaS/BM financial entitlement anywhere in this CR.

## 4. Recommended implementation PARTs (5)

- **PART 01 — Handyman Service Catalogue foundation (runtime):** NEW
  Handyman-governed Service Variant child of `service_catalog`; bounded
  catalogue read model (ACTIVE services + variants); focused tests. Includes
  the decision freeze for blockers #1–#4 before coding.
- **PART 02 — Common Material reference exposure:** NEW bounded Common
  Material Profile chain (Variant → Material/SKU reference, spec/compatibility
  + image exposure, typical quantity, commonality, customer material option)
  + reference-price lookup integration (REUSE `price-catalog-lookup`) +
  bounded public DTOs; focused tests.
- **PART 03 — Handyman Service Request intake (runtime):** EXTEND
  `tenant-service-requests` with distinct Handyman lifecycle + service/variant
  selection + description + **server-authoritative immutable
  channel-attribution binding from CR-HM-01**; focused tests; no evidence yet.
- **PART 04 — Intake evidence seam:** Handyman intake evidence parent
  admission + INTAKE-stage binding at request creation + bounded VIDEO intake
  extension (PHOTO already supported); focused tests.
- **PART 05 — HTTP + OpenAPI exposure + final certification:** catalogue/
  variant/material-discovery + customer request-intake + evidence-intake
  surfaces (paths deferred to PART design per conventions, never invented
  here); OpenAPI parity; focused suites re-run; `CR-HM-02_FINAL_VALIDATION.md`.

## 5. Blockers / open decisions (freeze required before PART 01)

1. **Image/media storage seam for catalogue & material references** — no
   existing image field/storage on masters; candidate is reusing the
   evidence storage abstraction pattern. Decision needed: exact authority
   and storage seam; must not invent new infrastructure lightly and must
   not overload evidence submissions for non-evidence imagery without an
   explicit decision.
2. **VIDEO intake policy** — MIME allowlist, size limit (50MB current cap),
   retention/integrity application; extends the evidence engine bounds.
3. **Handyman request placement** — same module row set with distinct
   governed status vocabulary vs. sibling Handyman request entity under the
   `tenant-service-requests` module authority; frozen map mandates EXTEND
   with distinct lifecycle but does not pick the storage shape.
4. **Customer-facing catalogue intake auth surface** — catalogue reference
   exposure to a handoff-attributed customer (vs. staff RBAC read) and its
   bounded DTO; path/prefix decisions deferred to PART 05 conventions.

No STOP-level conflicts with frozen documents: every required piece is
classifiable REUSE/EXTEND/NEW per the frozen backend map.
