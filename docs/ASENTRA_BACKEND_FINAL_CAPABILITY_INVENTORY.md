# ASENTRA Backend Final Capability Inventory

## START GOVERNANCE

**Date:** 2026-08-25 UTC<br>
**Arena branch:** `arena/01a039c6-asentra-backend`<br>
**Scope of this commit:** review/documentation governance only. Full capability audit is intentionally not performed in this START GOVERNANCE step.

## Governance Guardrails

This inventory will be based on actual implementation evidence, with authority order:

1. `src/modules`
2. Runtime routes/services
3. Migrations
4. `docs/api/openapi.yaml`

OpenAPI absence will not be treated as evidence that a capability is absent. Runtime implementation must also be inspected during the later audit parts.

For this START GOVERNANCE step, no source code, OpenAPI definition, or migrations were modified, no dependencies were installed, no broad tests were run, and no pull request will be opened.

## Verification Snapshot

| Item | Verified Result |
| --- | --- |
| Current branch | `arena/01a039c6-asentra-backend` |
| Current HEAD | `3809109cf4313e9d7b74a57ff94fdc23ce2409f3` |
| Latest `origin/main` SHA after fetch | `3809109cf4313e9d7b74a57ff94fdc23ce2409f3` |
| Merge base with `origin/main` | `3809109cf4313e9d7b74a57ff94fdc23ce2409f3` |
| Main alignment | Current branch HEAD equals latest `origin/main` at governance start |
| Working tree before documentation change | Clean |
| OpenAPI location | `docs/api/openapi.yaml` present |
| OpenAPI file size at verification | 1,971,461 bytes |
| Highest numbered migration found | `src/database/migrations/0336_create_notification_push_deliveries.ts` |

## Status Taxonomy for Later Audit

The final inventory will use only the following status values:

- `IMPLEMENTED`
- `RUNTIME_OPENAPI_GAP`
- `PARTIAL`
- `FOUNDATION_ONLY`
- `INTERNAL_ONLY`
- `NOT_FOUND`

## Frozen Audit Part Plan

### PART 01 — Core Building & Operations

Planned audit coverage: implemented backend capabilities for core building/domain operations, including module evidence, runtime routes/services, supporting migrations, and OpenAPI coverage where present.

Status: **NOT ASSESSED IN START GOVERNANCE**

### PART 02 — Engineering, Utility, IKE/IKA & ESG

Planned audit coverage: implemented backend capabilities for engineering workflows, utility handling, IKE/IKA-related functionality, and ESG evidence across runtime implementation and persistence artifacts.

Status: **NOT ASSESSED IN START GOVERNANCE**

### PART 03 — Tenant, Vendor, Procurement & Finance

Planned audit coverage: implemented backend capabilities for tenant management, vendor lifecycle, procurement flows, commercial/finance surfaces, migrations, and OpenAPI/runtime alignment.

Status: **NOT ASSESSED IN START GOVERNANCE**

### PART 04 — Material, SLA, Notification & Document Control

Planned audit coverage: implemented backend capabilities for material/inventory-related control, SLA management, notification surfaces, and document control, including runtime-only capabilities and OpenAPI gaps.

Status: **NOT ASSESSED IN START GOVERNANCE**

### PART 05 — Integration, Audit, Currency, FX & Reporting

Planned audit coverage: implemented backend capabilities for integrations, audit/event evidence, currency and FX authority, reporting/archive flows, migrations, runtime services, and documented API exposure.

Status: **NOT ASSESSED IN START GOVERNANCE**

### PART 06 — Frontend/Mobile Handoff Matrix

Planned audit coverage: reconciliation-ready backend capability matrix for frontend web and mobile handoff, identifying implemented routes/services, runtime/OpenAPI gaps, partials, internal-only features, and not-found items.

Status: **NOT ASSESSED IN START GOVERNANCE**

## START GOVERNANCE Stop Point

This document records governance verification and freezes the six-part audit plan only. The full implementation audit is deferred to later PART execution.

---

## PART 01 — Core Building & Operations

**Baseline governance commit:** `574277646c8e45eeb539e97e2a0b9b62e06de768`<br>
**Review mode:** documentation-only audit. No `src`, OpenAPI, migration, CI, or dependency changes were made.<br>
**Evidence method:** inspected registered runtime routers in `src/routes/index.ts`, matching module route/controller/service/repository files under `src/modules`, supporting migrations under `src/database/migrations`, and path presence in `docs/api/openapi.yaml`. Migration names alone were not used to mark implementation.

### PART 01 Capability Findings

| # | Capability | Backend module evidence | Runtime route evidence | Service/read-model evidence | Permission evidence | Client/Building scope evidence | Migration evidence | OpenAPI presence | Status | Handoff classification |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Client / Company / Subscription context | `src/modules/clients`, `src/modules/subscriptions`; registered by `createClientRouter()` and `createSubscriptionRouter()` in `src/routes/index.ts`. | `/clients`, `/clients/:id`, `/subscriptions`, `/subscriptions/:id`, `/subscriptions/:id/effective`, `/clients/:clientId/subscriptions`. | `client.service.ts`, `client.repository.ts`, `subscription.service.ts`, `subscription.repository.ts`. | `client.read`, `client.manage`, `subscription.read`, `subscription.manage`. | Client identity is first-class; subscriptions carry `client_id` and expose client-scoped listing. | `0012_create_clients.ts`, `0013_create_subscriptions.ts`. | Client paths present (`/clients`, `/clients/{clientId}`); subscription CRUD/effective runtime paths are not present, only subscription entitlement paths were found. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED; MOBILE_OPTIONAL for effective context consumption. |
| 2 | Property / Building | `src/modules/properties`, `src/modules/buildings`, plus `building-configurations`; registered by `createPropertyRouter()`, `createBuildingRouter()`, `createBuildingConfigurationRouter()`. | `/properties`, `/properties/:id/status`, `/clients/:clientId/properties`, `/buildings`, `/buildings/:id/status`, `/properties/:propertyId/buildings`. | `property.service.ts`, `building.service.ts`, repositories and controllers. | `property.read/manage`, `building.read/manage`. | Properties are client-scoped; buildings hang off properties and are used as operational building scope. | `0017_create_properties.ts`, `0018_create_buildings.ts`, `0019_create_user_building_assignments.ts`. | Present (`/properties`, `/clients/{clientId}/properties`, `/buildings`, `/properties/{propertyId}/buildings`). | IMPLEMENTED | WEB_REQUIRED; MOBILE_REQUIRED as building scope source. |
| 3 | Campus | `src/modules/campuses`; registered by `createCampusRouter()`. | `/properties/:propertyId/campuses`, `/campuses/:id`, `/buildings/:buildingId/campus`. | `campus.service.ts`, `campus.repository.ts`. | `campus.read`, `campus.manage`. | Campus belongs under property; building-campus assignment route validates building/property relationship in service layer. | `0035_create_campuses.ts`, `0036_add_building_campus_reference.ts`. | No campus paths found in `docs/api/openapi.yaml`. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED; MOBILE_OPTIONAL. |
| 4 | Floor | `src/modules/floors`; registered by `createFloorRouter()`. | `/buildings/:buildingId/floors`, `/floors/:id`. | `floor.service.ts`, `floor.repository.ts`. | `floor.read`, `floor.manage`. | Floor records carry `building_id`; service resolves building before create/list/update. | `0034_create_floors.ts`. | Present (`/buildings/{buildingId}/floors`, `/floors/{floorId}`). | IMPLEMENTED | WEB_REQUIRED; MOBILE_REQUIRED for location context. |
| 5 | Area | `src/modules/areas`; registered by `createAreaRouter()`. | `/floors/:floorId/areas`, `/areas/:id`. | `area.service.ts`, `area.repository.ts`. | `area.read`, `area.manage`. | Area is floor-scoped and therefore building-scoped through floor hierarchy. | `0037_create_areas.ts`. | Present (`/floors/{floorId}/areas`, `/areas/{areaId}`). | IMPLEMENTED | WEB_REQUIRED; MOBILE_REQUIRED for location context. |
| 6 | Room | `src/modules/rooms`; registered by `createRoomRouter()`. | `/areas/:areaId/rooms`, `/rooms/:id`. | `room.service.ts`, `room.repository.ts`. | `room.read`, `room.manage`. | Room is area-scoped and inherits floor/building hierarchy. | `0038_create_rooms.ts`, `0039_create_room_types.ts`, `0040_add_room_type_reference.ts`. | Present (`/areas/{areaId}/rooms`, `/rooms/{roomId}`). | IMPLEMENTED | WEB_REQUIRED; MOBILE_REQUIRED for location context. |
| 7 | Space | `src/modules/spaces`; registered by `createSpaceRouter()`. | `/rooms/:roomId/spaces`, `/spaces/:id`. | `space.service.ts`, `space.repository.ts`. | `space.read`, `space.manage`. | Space is room-scoped and inherits building context through room/area/floor. | `0041_create_spaces.ts`. | Present (`/rooms/{roomId}/spaces`, `/spaces/{spaceId}`). | IMPLEMENTED | WEB_REQUIRED; MOBILE_REQUIRED for tenant/location context. |
| 8 | Functional Location | `src/modules/functional-locations`; registered by `createFunctionalLocationRouter()`. | `/buildings/:buildingId/functional-locations`, `/functional-locations/:id`. | `functional-location.service.ts`, `functional-location.repository.ts`. | `functional_location.read`, `functional_location.manage`. | Direct `building_id` scope; asset/engineering services validate functional location building match. | `0042_create_functional_locations.ts`. | Present (`/buildings/{buildingId}/functional-locations`, `/functional-locations/{functionalLocationId}`). | IMPLEMENTED | WEB_REQUIRED; MOBILE_REQUIRED for asset/work execution context. |
| 9 | Asset / Equipment | `src/modules/assets`, `src/modules/equipment-profiles`, plus asset category/type/warranty/certification/identifier/history modules; registered by related routers. | `/buildings/:buildingId/assets`, `/assets/:id`, `/assets/:id/location`, `/assets/:assetId/status`, `/assets/:assetId/equipment-profile`. | `asset.service.ts`, `equipment-profile.service.ts`, supporting repositories and asset status/location logic. | `asset.read/manage`, `equipment_profile.read/manage`. | Assets are building-scoped; equipment profile attaches to asset; service validates building/location compatibility. | `0043_create_assets.ts` through `0053_create_asset_history_events.ts`. | Present for asset and equipment profile paths. | IMPLEMENTED | WEB_REQUIRED; MOBILE_REQUIRED for work, inspection, PM. |
| 10 | Organization | `src/modules/organizations`; registered by `createOrganizationRouter()`. | `/organizations`, `/organizations/:id`. | `organization.service.ts`, `organization.repository.ts`. | `organization.read`, `organization.manage`. | Organization records carry `client_id`; service lists by client. | `0020_create_organizations.ts`. | No organization CRUD paths found in `docs/api/openapi.yaml`. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED; MOBILE_OPTIONAL. |
| 11 | Department / Team | `src/modules/departments`, `src/modules/teams`; registered by `createDepartmentRouter()` and `createTeamRouter()`. | `/departments`, `/departments/:id`, `/departments/:departmentId/teams`, `/teams/:id`. | `department.service.ts`, `team.service.ts`, repositories. | `department.read/manage`, `team.read/manage`. | Departments belong to organizations; teams belong to departments; client context is inherited through organization. | `0021_create_departments.ts`, `0022_create_teams.ts`. | Team task paths exist, but department/team master CRUD paths were not found. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED; MOBILE_OPTIONAL for assignment display. |
| 12 | Workforce / Position / Shift | `src/modules/workforce`, `src/modules/positions`, `src/modules/shifts`, plus workforce assignment/reporting modules; registered by corresponding routers. | `/organizations/:organizationId/workforce-profiles`, `/departments/:departmentId/workforce-profiles`, `/teams/:teamId/workforce-profiles`, `/organizations/:organizationId/positions`, `/buildings/:buildingId/shifts`. | `workforce.service.ts`, `position.service.ts`, `shift.service.ts`, repositories and workforce assignment services. | `workforce.read/manage`, `position.read/manage`, `shift.read/manage`. | Workforce and positions inherit organization/department/team client scope; shifts are building-scoped. | `0023_create_positions.ts` through `0030_create_workforce_building_assignments.ts`. | Workforce, position, and shift master paths were not found in OpenAPI. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED; MOBILE_REQUIRED for current shift/my team/task assignment. |
| 13 | Vendor master | `src/modules/vendors`, `vendor-categories`, `vendor-pics`, `vendor-buildings`, `vendor-capabilities`, `vendor-workforce`, `vendor-compliance-documents`, `vendor-licenses`; registered by vendor routers. | `/clients/:clientId/vendors`, `/vendors/:id`, and supporting vendor master subresources. | `vendor.service.ts`, `vendor.repository.ts` plus supporting vendor services. | `vendor.read`, `vendor.manage` and related vendor subresource permissions. | Vendor records carry `client_id`; vendor-building relationship supplies building association where needed. | `0054_create_vendors.ts` through `0062_create_vendor_licenses_certifications.ts`; later service identity extension in `0323_add_vendor_capability_service_identity.ts`. | Vendor finance/procurement paths exist, but vendor master CRUD paths were not found. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED; MOBILE_OPTIONAL. |
| 14 | Dynamic Forms | `src/modules/source-forms`, `form-templates`, `form-sections`, `form-template-versions`, `form-instances`, `form-conditions`, `form-administration`; registered by related routers. | `/clients/:clientId/source-forms`, `/source-forms/:id/templates`, `/form-templates/:id`, `/form-templates/:templateId/sections`, `/form-template-versions/:id/publish`, `/form-template-versions/:versionId/instances`, `/form-instances/:id/responses`. | `source-form.service.ts`, `form-template.service.ts`, `form-administration.service.ts`; form instance/version/condition routes contain direct runtime handlers. | `source_form.read/manage`, `form_template.read/manage`. | Source forms/templates/instances carry `client_id`; form administration validates accessible client and UOM ownership. | `0063_create_source_forms.ts` through `0068_create_form_conditions_repeatables.ts`. | Measurement patch path for form fields exists, but source-form/form-template/version/instance lifecycle paths were not found. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED; MOBILE_REQUIRED where forms drive field execution. |
| 15 | SOP / Checklist | Checklist implementation exists in `src/modules/checklist-templates`, `checklist-executions`, `checklist-administration`, and mobile checklist modules; no dedicated SOP/procedure module or runtime route was found by `sop`/procedure search. | Checklist runtime: `/clients/:clientId/checklist-templates`, `/checklist-templates/:id/items`, `/checklist-templates/:templateId/executions`, `/checklist-executions/:id/start`, `/checklist-executions/:id/responses`, `/mobile/checklist-executions/:id`. | `checklist-execution.service.ts`, `checklist-administration.service.ts`; direct checklist template route handlers. | `checklist.read`, `checklist.manage`. | Checklist templates/executions carry `client_id`; mobile checklist read model joins assignments/execution context. | `0069_create_checklist_templates.ts`, `0070_create_checklist_executions.ts`. | Checklist paths present; no SOP-specific OpenAPI/runtime evidence found. | PARTIAL | WEB_REQUIRED for checklist administration; MOBILE_REQUIRED for checklist execution; SOP gap for Web review. |
| 16 | Measurement / UOM | `src/modules/uoms`; registered by `createUomRouter()`. Measurement configuration also used by form/checklist/engineering/mobile read models. | `/clients/:clientId/uoms`, `/uoms/:id`, `/form-fields/:id/measurement`, `/checklist-items/:id/measurement`. | `uom.routes.ts` direct runtime handlers; `form-administration.service.ts`, engineering/log-sheet/mobile checklist services validate/read UOM measurement config. | `uom.read`, `uom.manage`. | Units carry `client_id`; runtime validates accessible client and same-client UOM ownership for form/checklist measurement config. | `0071_create_uom_measurements.ts`. | Present (`/clients/{clientId}/uoms`, `/uoms/{uomId}`, `/form-fields/{formFieldId}/measurement`, `/checklist-items/{checklistItemId}/measurement`). | IMPLEMENTED | WEB_REQUIRED; MOBILE_REQUIRED for measured checklist/log-sheet values. |
| 17 | Evidence | `src/modules/evidence`, `evidence-requirements`, `evidence-retention-policies`, plus mobile evidence route; registered by evidence routers. | `/evidence`, `/evidence/:id`, `/evidence/:evidenceId/file`, `/evidence/:evidenceId/file/content`, finding/rework/verification evidence routes, and mobile evidence route. | `evidence.service.ts`, `evidence-integrity-verification.service.ts`, storage provider files, evidence requirement/retention services. | `evidence.read`, `evidence.manage`, and `finding.review` for verification evidence. | Evidence submissions carry `client_id` and execution target; file route validates finding/work-order ownership and building/client context. | `0072_create_evidence_requirements.ts`, `0073_create_evidence_submissions.ts`, `0087_add_work_order_evidence_binding.ts`, `0096_add_finding_rework_cycles.ts`, later retention/integrity migrations. | Present for generic evidence, files, work-order evidence, finding evidence, retention, and requirements. | IMPLEMENTED | WEB_REQUIRED; MOBILE_REQUIRED. |
| 18 | Scheduler | `src/modules/schedules`, `tasks`, `task-assignments`, `task-execution`, `due-job-scheduler`, `due-job-dispatcher`; registered by schedule/recurrence/task routers. | `/schedules`, `/schedules/:id`, `/schedules/:scheduleId/recurrence`, `/schedules/:scheduleId/occurrences`, `/schedules/:scheduleId/generate-tasks`, `/tasks`, `/tasks/:id/start|complete|cancel`. | Schedule/recurrence/task routes include runtime handlers; `task-execution.service.ts`; due scheduler/dispatcher services. | `schedule.read/manage`, `task.read/manage`. | Schedule records carry `client_id` and optional `building_id`; runtime uses `contextAccessService` accessible client/building checks. | `0075_create_schedule_definitions.ts`, `0076_create_schedule_recurrence.ts`, `0077_create_tasks.ts`, `0078_create_task_assignments.ts`, `0079_extend_task_execution.ts`; utility schedule target extension in `0281_create_utility_reading_dues_ocr.ts`. | Task paths are present, but schedule/recurrence CRUD/preview paths were not found. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED; MOBILE_REQUIRED for generated assigned work. |
| 19 | Work Order | `src/modules/work-orders`, `work-order-assignments`, `work-order-actions`, `work-order-evidence`, `work-order-verification`, `work-order-history`; registered by work-order routers. | `/buildings/:buildingId/work-orders`, `/work-requests/:requestId/work-order`, `/work-orders/:id`, `/work-orders/team`, status/priority/context/completion/verification/close routes. | `work-order.service.ts`, assignment/action/evidence/verification/history services and repositories. | `work_order.read`, `work_order.manage`. | Work orders carry `client_id` and `building_id`; service validates building client, accessible buildings, asset/location building matches. | `0081_create_work_requests.ts` through `0089_add_work_order_verification.ts`. | Present for building work orders, team work orders, assignments, actions, context, completion, priority, evidence, verification, close. | IMPLEMENTED | WEB_REQUIRED; MOBILE_REQUIRED. |
| 20 | Preventive Maintenance | `src/modules/maintenance-bindings`; registered by `createMaintenanceBindingRouter()`. PM is implemented as asset maintenance binding linked to schedule/task/work-order, not as a separate `preventive-maintenance` module name. | `/assets/:assetId/maintenance-bindings`, `/buildings/:buildingId/engineering/maintenance-bindings`, `/engineering/maintenance-bindings/:id/schedule`, `/task`, `/work-order`. | `maintenance-binding.service.ts`, `maintenance-binding.repository.ts`; validates asset, schedule, task, work-order linkage. | `maintenance_binding.read`, `maintenance_binding.manage`. | Binding records carry `client_id` and `building_id`; service asserts asset/building access and validates linked schedule/task/work-order belong to same client/building. | `0107_create_maintenance_bindings.ts`, `0108_add_maintenance_task_binding.ts`. | Present for maintenance binding and schedule/task/work-order links. | IMPLEMENTED | WEB_REQUIRED; MOBILE_REQUIRED for PM-generated execution. |
| 21 | Inspection | `src/modules/inspection-bindings`, plus housekeeping inspection modules (`toilet-inspections`, `public-area-inspections`, `supervisor-inspections`) and engineering execution context. | `/assets/:assetId/inspection-bindings`, `/buildings/:buildingId/engineering/inspection-bindings`, `/engineering/inspection-bindings/:id/start`, `/engineering/inspection-executions/:id`, plus housekeeping inspection binding/start paths. | `inspection-binding.service.ts`, `inspection-binding.repository.ts`; housekeeping inspection services. | `inspection_binding.read`, `inspection_binding.manage`; housekeeping-specific permissions in respective modules. | Inspection bindings carry `client_id` and `building_id`; service asserts asset/building access and checklist/form/client compatibility. | `0098_create_inspection_bindings.ts`, `0099_add_inspection_execution_binding.ts`, `0113_create_toilet_inspection_bindings.ts`, `0114_create_public_area_inspection_bindings.ts`, `0115_create_supervisor_inspections.ts`. | Present for engineering and housekeeping inspection binding/execution paths. | IMPLEMENTED | WEB_REQUIRED; MOBILE_REQUIRED. |
| 22 | Findings / Verification / Rework | `src/modules/findings`, `finding-reviews`, `finding-rework`, `finding-closure`, `finding-history`, `finding-assignments`, classifications/severities, plus work-order verification. | `/buildings/:buildingId/findings`, `/findings/:id`, `/findings/:id/state`, `/findings/:id/source`, `/findings/:id/verification`, `/findings/:id/rework`, `/findings/:id/resubmit`, `/findings/:id/close`, `/findings/:id/history`, `/work-orders/:id/verification`. | `finding.service.ts`, `finding-action.service.ts`, `finding-state.service.ts`, `finding-review.service.ts`, `finding-rework.service.ts`, `finding-closure.service.ts`, `work-order-verification.service.ts`. | `finding.read`, `finding.manage`, `finding.review`, `finding.close`, `work_order.read/manage`. | Findings carry `client_id` and `building_id`; work-order verification and finding evidence flows validate ownership and target state. | `0090_create_findings.ts` through `0097_add_finding_closure.ts`; `0089_add_work_order_verification.ts`. | Present for findings, available actions/state/source, verification, rework, closure/history, evidence, and work-order verification. | IMPLEMENTED | WEB_REQUIRED; MOBILE_REQUIRED for field verification/rework. |

### PART 01 Summary Counts

| Metric | Count |
| --- | ---: |
| Capabilities audited | 22 |
| `IMPLEMENTED` | 13 |
| `RUNTIME_OPENAPI_GAP` | 8 |
| `PARTIAL` / `FOUNDATION_ONLY` | 1 |
| `INTERNAL_ONLY` | 0 |
| `NOT_FOUND` | 0 |

### Major Web Gaps to Review Later

- OpenAPI reconciliation for runtime-implemented master/admin surfaces: subscriptions, campuses, organizations, departments, teams, workforce profiles, positions, shifts, vendor master, dynamic forms, schedules/recurrences.
- SOP is not evidenced as a dedicated runtime capability; checklist is implemented. Web product reconciliation should decide whether SOP remains out of scope or needs a new backend capability.
- Dynamic form lifecycle has substantial runtime coverage but incomplete OpenAPI surface for source forms, templates, versions, conditions, and instances.

### Major Mobile Gaps to Review Later

- Mobile depends on building/location/asset/workforce/task/checklist/evidence/work-order/inspection/finding runtime capabilities, which are present, but several upstream admin surfaces are OpenAPI gaps and may affect generated client contracts.
- Scheduler recurrence and schedule CRUD are runtime-only OpenAPI gaps, while mobile task execution paths are documented.
- SOP-specific mobile behavior is not evidenced separately from checklist execution.

### PART 01 Validation

- Documentation-only change prepared for `docs/ASENTRA_BACKEND_FINAL_CAPABILITY_INVENTORY.md`.
- Source, OpenAPI, migrations, CI, and dependencies were not modified.
- Broad tests were not run.
- `git diff --check` passed.

### PART 02 Readiness

PART 01 evidence review is complete and ready for PART 02 — Engineering, Utility, IKE/IKA & ESG, subject to documentation validation and push of this PART 01 commit.

---

## PART 02 — Engineering, Utility, IKE/IKA & ESG

**Baseline:** `3379f97c582ed2f7adb07b30fa6381745c13e605`<br>
**Review mode:** documentation-only audit. No `src`, OpenAPI, migration, CI, or dependency changes were made.<br>
**Evidence method:** inspected registered runtime routers in `src/routes/index.ts`, matching route/controller/service/repository files under `src/modules`, supporting migrations under `src/database/migrations`, and textual path coverage in `docs/api/openapi.yaml`. Migration names alone were not used to mark runtime implementation.

### PART 02 Interpretation Guardrail

- **UTILITY DATA EXISTS** means the backend has meter, reading, consumption, tariff, calculation, billing, aggregation, or utility reporting records/routes.
- **IKE IMPLEMENTED** requires actual calculation authority, data source, route, service/read model, period/building scope, and permission evidence for electricity intensity. PART 02 found this in Building Utility Reconciliation, not merely in meter readings.
- **IKA IMPLEMENTED** requires actual calculation authority, data source, route, service/read model, period/building scope, and permission evidence for water intensity. PART 02 found this in Building Utility Reconciliation, not merely in meter readings.
- **ESG IMPLEMENTED** is not equivalent to utility data. ESG implementation is limited to the ESG-specific modules and read models listed below; utility readings/reconciliations do not automatically populate ESG or imply ESG calculations.

### PART 02 Capability Findings

| # | Capability | Backend module evidence | Runtime route evidence | Service/read-model evidence | Permission evidence | Scope evidence | Migration evidence | OpenAPI status | Implementation status | Web relevance | Mobile relevance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Engineering operations / technical command view | `engineering-daily-operations`, `engineering-overview`, `engineering-reports`, `engineering-findings`; registered in `src/routes/index.ts`. | `/buildings/:buildingId/engineering/daily-operations`, `/buildings/:buildingId/engineering/overview`, `/engineering/reports/*`, `/engineering/findings`. | `engineering-daily-operations.service.ts`, `engineering-overview.service.ts`, `engineering-report.service.ts`, `engineering-finding.service.ts`; overview composes daily operations, findings, work orders, handover data. | `engineering.read`, `engineering_overview.read`, `engineering_report.read`, `engineering_finding.read/manage`. | Building-scoped routes; services call building/context access checks and derive operational date/shift windows. | `0098`-`0109` engineering binding/finding migrations plus work-order/finding foundations from PART 01. | Present for daily operations, overview, engineering reports, engineering findings. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL; mobile consumes downstream task/checklist/work-order execution more than management overview. |
| 2 | Technical inspection execution | `inspection-bindings`; also housekeeping inspection modules are present. | `/assets/:assetId/inspection-bindings`, `/buildings/:buildingId/engineering/inspection-bindings`, `/engineering/inspection-bindings/:id/start`, `/engineering/inspection-executions/:id`. | `inspection-binding.service.ts`, `inspection-binding.repository.ts`; validates asset, checklist/template, functional location, and execution context. | `inspection_binding.read/manage`. | Asset/building scoped; service asserts building access and same-client/same-building compatibility. | `0098_create_inspection_bindings.ts`, `0099_add_inspection_execution_binding.ts`; housekeeping inspection migrations `0113`-`0115`. | Present for engineering and housekeeping inspection paths. | IMPLEMENTED | WEB_REQUIRED | MOBILE_REQUIRED for field inspection execution context. |
| 3 | Engineering meter-reading execution | `meter-reading-bindings`. | `/assets/:assetId/meter-reading-bindings`, `/buildings/:buildingId/engineering/meter-reading-bindings`, `/engineering/meter-reading-bindings/:id/start`, `/engineering/meter-reading-executions/:id/reading`, `/engineering/meter-reading-executions/:id`. | `meter-reading-binding.service.ts`, `meter-reading-binding.repository.ts`; comments state measurement execution remains governed by shared form/UOM semantics. | `meter_reading_binding.read/manage`. | Asset/building scoped; service validates asset building, functional location, UOM/range, and building access. | `0100_create_meter_reading_bindings.ts`, `0101_add_meter_reading_execution_binding.ts`. | Present for engineering meter-reading binding and execution paths. | IMPLEMENTED | WEB_REQUIRED | MOBILE_REQUIRED where meter reads are field tasks. |
| 4 | Utility meter master, type configuration, hierarchy, tenant assignment | `utility-meters`, `utility-type-configurations`, `utility-meter-hierarchies`, `utility-meter-tenants`. | `/buildings/:buildingId/utility-meters`, `/clients/:clientId/utility-meters`, `/utility/meters/:id`, `/clients/:clientId/utility-type-configurations`, `/utility/meters/:id/sub-meters`, `/utility/meters/:id/tenant-assignments`, tenant/space meter lookup routes. | `utility-meter.service.ts`, type configuration/hierarchy/tenant services and repositories. | Reuses `utility_meter.read/manage`. | Client/building/meter/tenant/space scoped; services validate building and client ownership. | `0184_create_utility_meters.ts`, `0185_create_utility_type_configurations.ts`, `0186_create_utility_meter_hierarchies.ts`, `0187_create_utility_meter_tenant_assignments.ts`. | Core meter path present; type-configuration, hierarchy, tenant-assignment paths were not found as OpenAPI paths. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL; mobile may need meter lookup for reading tasks. |
| 5 | Utility readings, evidence, consumption | `utility-meter-readings`, `utility-meter-reading-evidence`, `utility-meter-consumptions`. | `/utility/meters/:id/readings`, `/utility/meters/:id/readings/latest`, `/buildings/:buildingId/meter-readings`, `/utility/meter-readings/:id/evidence`, `/utility/meters/:id/consumptions`, `/buildings/:buildingId/meter-consumptions`. | Reading/evidence/consumption services and repositories; reading evidence validates evidence requirement/validation state; consumption is derived from readings. | `utility_meter.read/manage`. | Meter/building/tenant scoped; readings and consumptions carry client/building/meter context. | `0188_create_utility_meter_readings.ts`, `0189_add_meter_reading_evidence_binding.ts`, `0190_create_utility_meter_consumptions.ts`. | Main reading/evidence/consumption paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_REQUIRED for field readings and evidence capture. |
| 6 | Utility tariffs, calculation basis, calculations, billing handoff data | `utility-tariffs`, `utility-calculations`, `utility-bills`; tenant billing handoff support. | `/buildings/:buildingId/utility-tariffs`, `/clients/:clientId/utility-calculation-bases`, `/utility/consumptions/:id/calculations`, `/utility/calculations/:id/recalculate|finalize`, `/tenant-companies/:tenantCompanyId/utility-bills`, `/utility-bills/:id/invoice-ready`. | `utility-tariff.service.ts`, `utility-calculation.service.ts`, `utility-bill.service.ts`; calculation routes explicitly preserve immutable calculation history/finalization. | `utility_meter.read/manage` for tariffs/calculations; `utility_bill.read/manage` for bills. | Building, client, consumption, tenant company, and billing-period scoped. | `0191_create_utility_calculations.ts`, `0278_add_utility_tariffs.ts`, `0279_add_tenant_utility_billing_handoff.ts`, utility bill migrations in utility billing modules. | Tariff, utility calculation read/finalize, and utility bill paths present; calculation basis and consumption calculation history routes have OpenAPI gaps. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 7 | Utility operational exceptions, abnormal consumption, verification | `utility-operational-exceptions`, `utility-abnormal-consumptions`, `utility-verification`. | `/utility/exceptions`, `/utility/exceptions/:id/start-review|resolve|cancel`, `/clients/:clientId/utility-abnormality-rules`, `/utility/consumptions/:id/abnormality-evaluations`, `/utility/abnormal-consumptions/:id/verification/open`, `/utility/abnormal-consumptions/:id/verification`. | Exception/abnormal/verification services and repositories; verification targets abnormal consumption review/approval. | `utility_meter.read/manage`. | Client/building/meter/tenant/consumption scoped through source records and services. | `0192_create_utility_abnormal_consumptions.ts`, `0193_add_utility_verification.ts`, `0282_create_utility_operational_exceptions.ts`. | Exception paths present; abnormality/verification routes were not found as OpenAPI paths. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL; mobile may surface assigned follow-up work only. |
| 8 | Utility analytics, KPI, energy performance summaries | `utility-aggregations`, `utility-kpi`, `management-utility-summary`, `management-building-performance`. | `/utility/aggregations/summary`, `/utility/aggregations/consumption`, `/utility/aggregations/abnormal`, `/utility/aggregations/verification-approval`, `/utility/reports/kpi`, `/management/utility-summary`, `/buildings/:buildingId/utility-summary`, `/management/building-performance`. | `utility-aggregation.service.ts`, `utility-kpi.service.ts`, `management-utility-summary.service.ts`, `management-building-performance.service.ts`; KPI delegates to utility aggregation and exposes electricity/water/gas consumption/trends, not IKE/IKA authority except via reconciliation rows in management utility summary. | `utility_meter.read`, `utility_kpi.read`, `management_read_model.read`. | Query-scoped by client/building/meter/tenant; management scopes resolved through management read-scope service. | Aggregation/read model uses utility consumption/reconciliation tables; no separate analytics migration beyond underlying tables and report archives. | Management utility/building-performance paths present; utility aggregation and utility KPI paths were not found as OpenAPI paths. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 9 | IKE — electricity intensity | `building-utility-reconciliations`; management read models consume resulting snapshots. | `/buildings/:buildingId/utility-reconciliations` POST/GET and `/utility/reconciliations/:id`. | `building-utility-reconciliation.service.ts` and repository; calculation authority sets `performanceMetric: 'IKE'` for `utilityType === 'ELECTRICITY'` and returns `performanceUom: 'kWh/m²'`. | `utility_meter.manage` for calculation, `utility_meter.read` for reads. | Building + exact period scope (`periodStart`, `periodEnd`); source consumption from `utility_meter_consumptions` whose readings are ACTUAL; denominator from active `spaces.area_sqm` summed by building. | `0280_create_building_utility_reconciliations.ts`. | Present; OpenAPI summaries explicitly mention Building reconciliation and IKE/IKA snapshots. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL; primarily management/reporting. |
| 10 | IKA — water intensity | `building-utility-reconciliations`; management read models consume resulting snapshots. | `/buildings/:buildingId/utility-reconciliations` POST/GET and `/utility/reconciliations/:id`. | `building-utility-reconciliation.service.ts` and repository; calculation authority sets `performanceMetric: 'IKA'` for non-electricity supported utility type, with route validation restricting reconciliation utility type to electricity/water and returns `performanceUom: 'm³/m²'`. | `utility_meter.manage` for calculation, `utility_meter.read` for reads. | Building + exact period scope; source consumption from ACTUAL reading-derived utility consumptions; denominator from active `spaces.area_sqm`. | `0280_create_building_utility_reconciliations.ts`. | Present; OpenAPI summaries explicitly mention Building reconciliation and IKE/IKA snapshots. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL; primarily management/reporting. |
| 11 | Equipment / asset technical records | `equipment-profiles`, `asset-warranties`, `asset-certifications`, `asset-identifiers`, `asset-history`, `asset-failures`, `management-asset-registry-compliance`. | `/assets/:assetId/equipment-profile`, `/assets/:assetId/history`, `/assets/:assetId/warranties`, `/assets/:assetId/certifications`, `/assets/:assetId/status`, `/management/asset-registry-compliance`. | Asset/equipment profile services plus management asset registry compliance read model. | `equipment_profile.read/manage`, asset-related read/manage permissions, `management_read_model.read`. | Asset/building scoped; asset services validate building/location compatibility. | `0048_create_equipment_profiles.ts` through `0053_create_asset_history_events.ts`; asset-failure and management read model migrations where present. | Present for equipment profile, asset history/warranty/certification, and management compliance path. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL for asset detail; MOBILE_REQUIRED when attached to work execution. |
| 12 | Reliability / statutory-compliance read models | `management-asset-reliability-work`, `management-asset-registry-compliance`, asset warranty/certification modules. | `/management/asset-reliability-work`, `/management/asset-registry-compliance`, asset warranty/certification/history routes. | Management reliability/compliance services and repositories aggregate work, asset registry, warranties, certifications. | `management_read_model.read` plus asset-specific permissions for detail surfaces. | Management read-scope for accessible buildings; asset detail remains building scoped. | Uses asset/work-order/finding/warranty/certification foundations; no dedicated statutory authority module found beyond certifications/compliance read model. | Present. | PARTIAL | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 13 | ESG foundation / metric definitions | `esg-metric-definitions`; registered by `createEsgMetricDefinitionRouter()`. | `/esg/metric-definitions`, `/esg/metric-definitions/:id`, `/esg/metric-definitions/:id/deactivate`. | `esg-metric-definition.service.ts`, repository; metric categories include `ENERGY`, `WATER`, `WASTE`, `EMISSIONS` and additional ESG categories in type definitions. | `esg.read`, `esg.manage`. | Client-scoped; validates accessible client and same-client UOM. | `0326_create_esg_metric_definitions.ts`. | ESG paths are present textually in `docs/api/openapi.yaml`. | FOUNDATION_ONLY | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 14 | ESG environmental waste records | `esg-waste-records`; registered by `createEsgWasteRecordRouter()`. | `/esg/waste-records`, `/esg/waste-records/:id`, deactivate route. | `esg-waste-record.service.ts`, repository; stores waste type, quantity/UOM, source/vendor/functional location context. | `esg.read`, `esg.manage`. | Building-scoped; client ownership derived through building; validates FLOC building, UOM client, vendor client. | `0327_create_esg_waste_records.ts`. | ESG waste paths are present textually. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 15 | ESG environmental/social/governance metric values and periods | `esg-metric-values`; registered by `createEsgMetricValueRouter()`. | `/esg/metric-values`, `/esg/metric-values/:id`. | `esg-metric-value.service.ts`, repository; stores periodized values with `periodType`, `periodStart`, `periodEnd`, data quality, source type/ref, verification status field. It does **not** auto-calculate energy/water/waste/emissions/social/governance values. | `esg.read`, `esg.manage`. | Building-scoped with client derived through building; validates metric definition and UOM belong to same client. | `0328_create_esg_metric_values.ts`, verification shape extension in `0329_create_esg_baselines_targets_verification.ts`. | ESG metric value paths are present textually. | PARTIAL | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 16 | ESG baselines and targets | No `src/modules/esg-baselines` or `src/modules/esg-targets` runtime module found. | No baseline/target runtime route found. | No service/read model found for baseline/target lifecycle. | No permission use found beyond generic `esg.*` in other modules. | Tables are client/building/metric/period scoped by migration only. | `0329_create_esg_baselines_targets_verification.ts` creates `esg_baselines` and `esg_targets`. | No baseline/target OpenAPI paths found. | FOUNDATION_ONLY | WEB_REQUIRED later if target tracking is needed | MOBILE_OPTIONAL. |
| 17 | ESG evidence and verification workflow | Metric values have `verification_status`; generic evidence module exists separately, but no ESG evidence binding route/service and no ESG verification workflow route/service were found. | No ESG-specific evidence or verification route found. | `esg-read-models.service.ts` counts verification status; no workflow service to verify/reject ESG values and no evidence binding service. | No ESG-specific verification permission found; generic `esg.read/manage` only. | Metric verification status is building-scoped through metric values; evidence binding absent. | `0328` adds verification fields; `0329` adds verification shape constraint. | No ESG evidence/verification workflow OpenAPI paths found. | PARTIAL | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 18 | ESG reporting / read models | `esg-read-models`; registered by `createEsgReadModelsRouter()`. | `/esg/kpi`, `/management/esg-summary`. | `esg-read-models.service.ts` returns period/building summary over `esg_metric_values` and `esg_waste_records`, with provenance `source records; no UOM conversion or utility recalculation`. | `esg.read`. | Accessible building scope; date range filters. | Uses `0327` waste and `0328` metric values; no separate aggregation table. | ESG read-model paths are present textually. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 19 | Emissions / GHG / carbon calculation authority | ESG metric definition categories include emissions, and manual metric values can be stored against emissions definitions. No emission factor, GHG protocol, carbon conversion, or automated emissions calculation service/route was found; ESG metric value type comments explicitly exclude emission factors/carbon conversion. | No emissions calculation route found. | No carbon/GHG calculation service found. | Generic `esg.read/manage` only for definitions/values. | Manual metric values only; building/period scope if user records emissions as an ESG metric value. | `0326` definitions and `0328` values support manual categories/values. | No dedicated emissions/GHG/carbon OpenAPI path found. | PARTIAL | WEB_REQUIRED if carbon reporting is in scope | MOBILE_OPTIONAL. |

### Dedicated IKE / IKA / ESG Status

#### IKE

- **Status:** IMPLEMENTED.
- **Implementation:** Building Utility Reconciliation calculates electricity intensity when `utilityType` is `ELECTRICITY`.
- **Calculation authority:** `building-utility-reconciliation.repository.ts` inserts `performance_value` as `source_consumption / applicable_area_sqm`; `building-utility-reconciliation.service.ts` assigns `performanceMetric: 'IKE'` and `performanceUom: 'kWh/m²'`.
- **Data source:** `utility_meter_consumptions` joined to `utility_meters` and ACTUAL previous/current `utility_meter_readings`; denominator is sum of active `spaces.area_sqm` through room/area/floor/building hierarchy.
- **Service/read model:** `building-utility-reconciliation.service.ts`; read projection also appears in `management-utility-summary` reconciliation rows.
- **Route:** `/buildings/:buildingId/utility-reconciliations` and `/utility/reconciliations/:id`.
- **Permission:** `utility_meter.manage` to calculate; `utility_meter.read` to read.
- **Scope:** Building + exact period (`periodStart`, `periodEnd`).
- **OpenAPI coverage:** Present for utility reconciliation/IKE snapshot paths.

#### IKA

- **Status:** IMPLEMENTED.
- **Implementation:** Building Utility Reconciliation calculates water intensity when `utilityType` is `WATER`.
- **Calculation authority:** Same reconciliation repository formula `source_consumption / applicable_area_sqm`; service assigns `performanceMetric: 'IKA'` and `performanceUom: 'm³/m²'`.
- **Data source:** ACTUAL reading-derived water `utility_meter_consumptions`; denominator is active building space area (`spaces.area_sqm`).
- **Service/read model:** `building-utility-reconciliation.service.ts`; surfaced in management utility summary reconciliation rows.
- **Route:** `/buildings/:buildingId/utility-reconciliations` and `/utility/reconciliations/:id`.
- **Permission:** `utility_meter.manage` to calculate; `utility_meter.read` to read.
- **Scope:** Building + exact period (`periodStart`, `periodEnd`).
- **OpenAPI coverage:** Present for utility reconciliation/IKA snapshot paths.

#### ESG

- **Status:** PARTIAL overall.
- **Implemented scope:** Client-scoped ESG metric definitions; building-scoped waste records; building-scoped periodized ESG metric values; lightweight ESG KPI/management summary read models over source ESG records.
- **Foundation-only scope:** ESG baselines and targets have migration/table evidence but no runtime module/route/service found.
- **Not implemented as calculation authority:** automatic energy/water/waste aggregation into ESG, emission factors, GHG/carbon conversion, recycling rate, automatic IKE/IKA recalculation into ESG, ESG evidence binding, and ESG verification workflow routes/services.
- **Important distinction:** Utility meter/consumption/reconciliation data exists and IKE/IKA are implemented in utility reconciliation, but that does not mean ESG environmental metrics are automatically calculated or synchronized.

### PART 02 Summary Counts

| Metric | Count |
| --- | ---: |
| Capabilities audited | 19 |
| `IMPLEMENTED` | 8 |
| `RUNTIME_OPENAPI_GAP` | 5 |
| `PARTIAL` / `FOUNDATION_ONLY` | 6 |
| `NOT_FOUND` | 0 |

### Web Capabilities That Must Later Be Reconciled

- Utility master/configuration OpenAPI gaps: utility type configurations, hierarchy, tenant meter assignments.
- Utility calculation OpenAPI gaps: calculation bases, consumption calculation history, recalculation route coverage.
- Utility abnormality/verification OpenAPI gaps and utility aggregation/KPI path gaps.
- ESG product scope: baselines/targets runtime, ESG verification workflow, ESG evidence binding, carbon/GHG calculation authority, and whether ESG should ingest utility/IKE/IKA values automatically.
- Statutory/compliance semantics beyond asset certifications/read models are only partial and need product-level confirmation.

### Mobile Capabilities That Must Later Be Reconciled

- Engineering meter reading and inspection execution are mobile-relevant and documented, but mobile-specific screens should verify needed route coverage for utility meter lookup, reading evidence, and execution context.
- Utility exceptions/abnormality follow-up may be mobile-optional unless converted into work orders/tasks.
- IKE/IKA and ESG read models are primarily web/management reporting; mobile need is optional unless field teams must view sustainability KPIs.

### PART 02 Validation

- Documentation-only change prepared for `docs/ASENTRA_BACKEND_FINAL_CAPABILITY_INVENTORY.md`.
- Source, OpenAPI, migrations, CI, and dependencies were not modified.
- Broad tests were not run.
- `git diff --check` passed.

### PART 03 Readiness

PART 02 evidence review is complete and ready for PART 03 — Tenant, Vendor, Procurement & Finance, subject to documentation validation and push of this PART 02 commit.

---

## PART 03 — Tenant, Vendor, Procurement & Finance

**Baseline:** `1b22fe2490af4210430b87ed62defaad2f7adb07b30fa6381745c13e605`<br>
**Review mode:** documentation-only audit. No `src`, OpenAPI, migration, CI, or dependency changes were made.<br>
**Evidence method:** inspected registered runtime routers in `src/routes/index.ts`, matching module route/controller/service/repository files under `src/modules`, supporting migrations under `src/database/migrations`, and textual route presence in `docs/api/openapi.yaml`. Migration names alone were not used to mark runtime implementation.

### PART 03 Capability Findings

| # | Capability | Backend module evidence | Runtime route evidence | Service/read-model evidence | Permission evidence | Scope evidence | Migration evidence | OpenAPI status | Implementation status | Web relevance | Mobile relevance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Tenant company relationship, PIC, spaces, building context | `tenant-companies`, `tenant-pics`, `tenant-spaces`, `tenant-building-contexts`; registered by tenant routers. | `/clients/:clientId/tenant-companies`, `/tenant-companies/:tenantCompanyId/pics`, `/tenant-companies/:tenantCompanyId/spaces`, `/buildings/:buildingId/tenant-spaces`, tenant building-context routes. | Tenant company/PIC/space/building-context services and repositories. | `tenant_company.read/manage`. | Client, building, tenant company, and space scoped; tenant-space relationships bridge building locations. | `0144_create_tenant_companies.ts`, `0145_create_tenant_pics.ts`, `0146_create_tenant_space_relationships.ts`, `0147_create_tenant_building_contexts.ts`. | Runtime master/context paths were not found in OpenAPI except related downstream utility bill/approval paths. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 2 | Tenant service / facility requests | `tenant-service-requests`, `tenant-complaints`, `service-requests`; registered by tenant and service request routers. | `/tenant-companies/:tenantCompanyId/service-requests`, `/buildings/:buildingId/tenant-service-requests`, `/tenant-service-requests/:id/work-request`, `/tenant-service-requests/:id/work-order`, cancel/update/detail routes. | `tenant-service-request.service.ts`, complaint/service request services; can create work request/work order from tenant service request. | `tenant_company.read/manage`; service request/work order permissions on downstream modules where used. | Tenant company + building scoped; runtime exposes building list and tenant list. | `0148_create_tenant_service_requests.ts`, `0149_create_tenant_complaints.ts`, `0178_create_service_requests.ts`, `0322_add_service_request_catalog_anchor.ts`. | Tenant-service-request paths were not found in OpenAPI. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL; mobile relevance if field teams receive derived work orders. |
| 3 | Tenant utility requests and electricity/utility billing request flow | `tenant-utility-requests`, `utility-bills`, `utility-calculations`, `utility-meter-tenants`. | `/tenant-companies/:tenantCompanyId/utility-requests`, `/buildings/:buildingId/tenant-utility-requests`, `/tenant-utility-requests/:id/work-request`, `/tenant-utility-requests/:id/work-order`, `/tenant-companies/:tenantCompanyId/utility-bills`, `/utility-bills/:id/invoice-ready`. | Tenant utility request service; utility bill service; utility calculation service/readiness. | `tenant_company.read/manage`, `utility_bill.read/manage`, utility meter permissions for upstream calculation/meter data. | Tenant company, building, utility meter, and billing-period scoped. | `0150_create_tenant_utility_requests.ts`, `0187_create_utility_meter_tenant_assignments.ts`, `0194_add_utility_tenant_approval_binding.ts`, `0196_create_utility_bills.ts`, `0279_add_tenant_utility_billing_handoff.ts`. | Utility bill paths present; tenant utility request paths were not found. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 4 | Tenant charges, tenant invoices, invoice lifecycle | `tenant-charges`, `tenant-invoices`, `service-charge-readiness`. | `/tenant-charges` routes via tenant charge router, `/tenant-companies/:tenantCompanyId/invoices`, `/tenant-invoices`, `/tenant-invoices/:id/lines`, `/tenant-invoices/:id/finalize`, `/tenant-invoices/:id/cancel`. | `tenant-charge.service.ts`, `tenant-invoice.service.ts`, service-charge readiness service. | `tenant_charge.*` where present, `tenant_invoice.read/manage`. | Tenant company + building/client derived scope; invoices carry tenant and monetary context. | `0195_create_tenant_charges.ts`, `0197_create_service_charge_readiness.ts`, `0198_create_tenant_invoices.ts`. | Tenant invoice and charge paths were not found in OpenAPI. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 5 | Tenant invoice payment status and receipts | `invoice-payment-status`, `payment-receipts`; registered by corresponding routers. | `/tenant-invoices/:invoiceId/payment-status`, `/invoice-payment-statuses`, `/tenant-invoices/:invoiceId/receipts`, `/payment-receipts`, `/payment-receipts/:id/void`. | Invoice payment status and payment receipt services/repositories. | `invoice_payment_status.read/manage`, `payment_receipt.read/manage`. | Tenant invoice scoped; list/read surfaces preserve invoice/client/building linkage through source invoice. | `0199_create_invoice_payment_status.ts`, `0200_create_payment_receipts.ts`. | Payment status and receipt paths were not found in OpenAPI. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 6 | Parking | No parking module directory, route, service, or migration evidence found by repository-wide `parking` search. | None found. | None found. | None found. | None found. | None found. | None found. | NOT_FOUND | WEB_OPTIONAL if product requires parking | MOBILE_OPTIONAL. |
| 7 | Work permit and contractor context | `permits`, `permit-applications`, `permit-work-contexts`, `permit-approvals`, `permit-validities`, `permit-workers`, `permit-equipment`, `permit-evidence`, `permit-work-lifecycle`, `contractor-contexts`, `tenant-contractors`, `contractor-visitors`, `work-permit-readiness`. | `/permits`, `/permit-applications`, `/permit-applications/:id/submit`, `/permit-approvals/:id/approve|reject|request-rework`, `/permits/:permitId/work-start`, `/permits/:permitId/work-close`, `/contractor-contexts/resolve`, `/permit-readiness`. | Permit/contractor services and repositories; approval authority module exists for permit approvals. | `permit.read/manage/approve`; vendor permissions for work-permit readiness. | Client/building/tenant/vendor/contractor context derived through permit and contractor context records. | `0152_create_tenant_contractor_relationships.ts`, `0203_create_permits.ts` through `0209_create_permit_workers.ts`, later permit equipment/evidence migrations. | Permit and contractor route paths were not found in OpenAPI. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL; mobile may need permit work status if field execution includes contractors. |
| 8 | Vendor operational assignment and work | `vendor-assignments`, `vendor-work`, `vendor-workforce`, `vendor-buildings`, `vendor-capabilities`. | `/vendor-assignments/:assignmentId/work`, `/vendor-works`, `/vendor-works/:workId`, `/vendor-works/:workId/status`, plus vendor assignment/capability/building routes. | Vendor work/assignment services and repositories. | `vendor.read/manage`. | Vendor, client, building, assignment/work scoped. | `0155_create_vendor_assignments.ts`, `0156_create_vendor_works.ts`, `0058_create_vendor_building_relationships.ts`, `0059_create_vendor_capabilities.ts`, `0323_add_vendor_capability_service_identity.ts`. | Vendor operational work/assignment paths were not found in OpenAPI. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 9 | Vendor work report, evidence, verification, rework, history | `vendor-service-reports`, `vendor-completion-reports`, `vendor-work-evidence`, `vendor-verification`, `vendor-rework`, `vendor-work-history`. | `/vendor-service-reports`, `/vendor-service-reports/:reportId/finalize`, `/vendor-completion-reports`, `/vendor-completion-reports/:reportId/submit`, `/vendor-works/:id/verification`, `/vendor-works/:id/rework`, `/vendor-works/:id/resubmit`. | Vendor service report/completion/evidence/verification/rework/history services. | `vendor.read/manage`. | Vendor work + building/client scoped; evidence and verification attach to vendor work. | `0159_add_vendor_work_evidence_binding.ts`, `0160_create_vendor_completion_reports.ts`, `0161_create_vendor_service_reports.ts`, `0163_add_vendor_work_verification.ts`, `0164_create_vendor_rework_cycles.ts`, `0165_add_vendor_work_history.ts`. | Vendor service/completion/work verification routes were not found in OpenAPI. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 10 | Vendor service cost | `vendor-service-costs`; registered by `createVendorServiceCostRouter()`. | `/vendors/:vendorId/costs`, `/vendor-service-costs`, `/vendor-service-costs/:id/finalize`, `/vendor-service-costs/:id/cancel`. | `vendor-service-cost.service.ts`; route comment states no AP, tax, GL, purchase invoice, or payment. | `vendor_service_cost.read/manage`. | Vendor/client/building and service-cost scoped. | `0201_create_vendor_service_costs.ts`. | Vendor service cost paths were not found in OpenAPI. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 11 | BAST / completion / acceptance | `bast-documents`, `vendor-bast-bindings`, `acceptance-sign-offs`, `work-completion-documents`; canonical BAST foundation and commands exist. | `/vendor-basts`, `/vendor-basts/:bastId/submit`, `/vendor-basts/:bastId/accept`, `/vendor-basts/:bastId/reject`; BAST document routes and acceptance sign-off routes are also registered. | Vendor BAST binding service; BAST document services; acceptance sign-off service; BAST closure/readiness repository. | `vendor.read/manage`, `document.manage`, `bast.accept`, acceptance/document permissions. | Vendor work/work order/document scoped; building/client inherited from parent work and documents. | `0162_create_vendor_bast_bindings.ts`, `0259_establish_canonical_bast_foundation.ts`, `0260_add_canonical_bast_commands.ts`. | Vendor BAST paths present; broader acceptance/sign-off paths also exist in OpenAPI around document/BAST areas. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 12 | Procurement request / material-service demand | `purchase-requests`, `material-requests`, `service-requests`; registered by purchase/material/service request routers. | `/buildings/:buildingId/purchase-requests`, `/purchase-requests/:id`, `/purchase-requests/:id/cancel`; material/service request routes and links exist. | Purchase request/material request/service request services and repositories. | `purchase_request.read/manage`; material/service request permissions. | Building/client scoped; request lines/sources link to work/service/material context. | `0176_create_purchase_requests.ts`, `0177_create_material_requests.ts`, `0178_create_service_requests.ts`, material reservation/linkage migrations `0287`-`0290`. | Some downstream purchase request receivings/service-request paths exist; purchase-request CRUD paths were not found. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 13 | Procurement approval and PO readiness | `procurement-approvals`, `vendor-selection-readiness`, `purchase-order-readiness`. | `/procurement-approvals`, `/procurement-approvals/pending`, `/procurement-approvals/:id/approve|reject`, `/po-readiness`, `/buildings/:buildingId/po-readiness`, `/purchase-requests/:purchaseRequestId/po-readiness`, `/vendors/:vendorId/po-readiness`. | Procurement approval/readiness services and repositories; PO readiness route comments identify readiness authority. | Procurement approval permissions and `po_readiness.read/manage`. | Client/building/request/vendor scoped. | `0179_create_procurement_approval_bindings.ts`, `0180_create_vendor_selection_readiness.ts`, `0181_create_purchase_order_readiness.ts`. | PO readiness paths present; procurement approval routes less completely represented. | PARTIAL | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 14 | RFQ | `rfqs`; registered by `createRfqRouter()`. | `/rfqs`, `/rfqs/:id`, `/rfqs/:id/open`, `/rfqs/:id/close`, `/rfqs/:id/cancel`, `/rfqs/:id/lines`. | `rfq.service.ts`, `rfq.repository.ts`; RFQ lifecycle and line handling. | `rfq.read/manage`. | Client/building/request scoped through RFQ records. | `0313_create_rfqs.ts`. | RFQ paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 15 | Vendor quotation and RFQ vendor portal | `rfq-vendor-invitations`, `vendor-quotations`; registered by invitation/quotation routers. | `/rfqs/:rfqId/invitations`, `/rfq-vendor-invitations/:id/resend|revoke`, `/vendor-rfq-access/exchange`, `/vendor-rfq-access/invitations/:id/accept|decline|no-bid`, `/vendor-rfq-access/.../quotations`, quotation revision/line/attachment/submit routes, internal quotation reads. | Invitation token/session middleware and vendor quotation services/repositories. | Internal `rfq.read/manage`; vendor RFQ session middleware for external vendor session routes. | RFQ/invitation/vendor session scoped; internal reads client/building scoped. | `0314_create_rfq_vendor_invitations_and_sessions.ts`, `0315_create_vendor_quotations_and_revision_attachments.ts`. | Vendor RFQ access and quotation paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 16 | Multi-vendor comparison, recommendation, award | `rfq-comparisons`, `rfq-recommendations`; registered by comparison/recommendation routers. | `/rfqs/:rfqId/comparisons`, `/rfq-comparisons/:comparisonId/evaluations`, `/rfqs/:rfqId/recommendations`, `/rfq-recommendations/:recommendationId/award`, `/rfq-awards/:awardId`. | Comparison service resolves and freezes advisory reference prices; recommendation/award services. | `rfq.read/manage` and award-specific permission in recommendation router. | RFQ/client/building scoped; award derived from recommendation/comparison. | `0316_create_rfq_comparisons_and_evaluations.ts`, `0317_create_rfq_recommendations_approvals_awards.ts`, `0320_add_rfq_comparison_reference_price.ts`. | Comparison, evaluation, recommendation, and award paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 17 | Purchase order and RFQ-to-PO conversion | `purchase-orders`, `rfq-po-conversions`, `purchase-order-readiness`, `work-contracts`. | `/purchase-orders`, `/purchase-orders/:id/lines`, `/purchase-orders/:id/issue-readiness`, `/purchase-orders/:id/issue`, `/rfq-awards/:awardId/convert-to-po`, `/purchase-orders/:purchaseOrderId/rfq-provenance`. | Purchase order services; PO line services; RFQ PO conversion/provenance service; PO route comments state PO is commitment authority with PO readiness as precondition. | `purchase_order.read/manage`, RFQ award permission; price-deviation route also requires `price_catalog.read`. | Client/building/vendor/request/award scoped. | `0269_create_purchase_orders.ts`, `0270_create_purchase_order_lines.ts`, `0271_add_purchase_order_issuance.ts`, `0318_create_rfq_award_po_provenance.ts`, `0272_create_work_contracts.ts`. | Purchase order and RFQ provenance/conversion paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 18 | Procurement receipt / receiving | `receivings`, `work-order-procurement-bindings`. | `/receivings`, `/receivings/:id/finalize`, `/buildings/:buildingId/receivings`, `/purchase-requests/:purchaseRequestId/receivings`, `/service-requests/:serviceRequestId/receivings`, `/vendors/:vendorId/receivings`. | `receiving.service.ts`, repository; receiving finalization authority and procurement binding services. | `receiving.read/manage`. | Building, purchase request, service request, vendor scoped. | `0182_create_receivings.ts`, `0183_create_work_order_procurement_bindings.ts`, `0264_add_receiving_material_request_binding.ts`. | Receiving paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 19 | Vendor invoice, matching, payment/settlement | `vendor-invoices`; registered by `createVendorInvoiceRouter()`. | `/vendors/:vendorId/invoices`, `/vendor-invoices`, `/vendor-invoices/:id/finalize`, `/vendor-invoices/:id/verify`, `/vendor-invoices/:id/matching`, `/vendor-invoices/:id/payment`, `/vendor-invoices/:id/settlement-readiness`, `/vendor-invoices/:id/trace`. | `vendor-invoice.service.ts`, repository; integration seam calls operational commitment actualization for verified invoices. | `vendor_invoice.read/manage`. | Vendor/client/building/PO/receiving scoped through invoice linkage. | `0261_create_vendor_invoices.ts`, `0262_add_vendor_invoice_verification.ts`, `0263_add_vendor_invoice_payment_status.ts`, `0274_add_vendor_invoice_procurement_linkage.ts`. | Vendor invoice/payment/matching/trace paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 20 | Price catalog and price authority | `price-catalog-entries`; registered by `createPriceCatalogEntryRouter()`. | `/price-catalog/lookup`, `/price-catalog/entries`, `/price-catalog/entries/:id/activate|replace|correct|deactivate`; PO price deviation and RFQ comparison reference price consumers. | `price-catalog-entry.service.ts`, `price-catalog-lookup.service.ts`; service comments identify governed reference price authority and override correction. | `price_catalog.read/manage/override`; PO deviation requires both `purchase_order.read` and `price_catalog.read`. | Client/building/vendor/item/service/UOM/effective-window scoped per price catalog entry. | `0319_create_price_catalog_entries.ts`, `0320_add_rfq_comparison_reference_price.ts`, `0325_activate_service_reference_price.ts`. | Price catalog paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 21 | Operational budget master/foundation | `operational-finance`; registered by operational finance router. | `/buildings/:buildingId/operational-budgets`, `/operational-budgets`, `/operational-budgets/:id/activate|close|cancel`, categories and source-binding routes. | `operational-finance.service.ts`, source binding service, repository. | `operational_budget.read/manage`, `operational_budget.override` for overspend policy. | Building/client/period/currency/category scoped. | `0283_create_operational_budget_foundation.ts`, `0284_create_operational_budget_source_bindings.ts`, `0285_add_operational_budget_name.ts`, `0310_add_operational_budget_overspend_policy.ts`. | Operational budget paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 22 | Budget vs committed vs actual and variance | `operational-finance` commitment, material/vendor actualization seams, aggregation and variance services; management operational finance read models. | `/operational-budgets/:budgetId/commitments`, `/operational-budgets/:budgetId/commitments/from-purchase-order-line`, `/operational-commitments/:id/adjust|release|cancel`, `/operational-budgets/:budgetId/aggregation`, `/operational-budgets/:budgetId/variance`, `/operational-budget-variance`, `/operational-budgets/:budgetId/traceability`. | `operational-commitment.service.ts`, `operational-commitment-material.service.ts`, `operational-commitment-vendor.service.ts`, `operational-finance-aggregation.service.ts`, `operational-variance.service.ts`; actual cost is recognized by authoritative source transactions, not a direct HTTP actual endpoint. | `operational_budget.read/manage`; override permission for overspend policy. | Building/budget/category/PO line/vendor invoice/material usage scoped; variance reads budget period/currency. | `0311_create_operational_commitments.ts`, `0312_create_operational_commitment_entries.ts`, plus actual-source linkage migrations `0267`, `0274`. | Commitment, aggregation, variance, traceability paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 23 | Basic expense and operational cost capture | `basic-expenses`; operational finance aggregation also reads actual source candidates. | `/basic-expenses`, `/basic-expenses/:id/finalize`, `/basic-expenses/:id/cancel`. | `basic-expense.service.ts`; route comment states basic expense is not an accounting engine. | `basic_expense.read/manage`. | Building/client/expense scoped. | `0202_create_basic_expenses.ts`. | Basic expense paths were not found in OpenAPI. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 24 | Financial summary and commercial reporting read models | `basic-financial-reporting`, `management-financial-summary`, `management-operational-finance`, `management-building-operational-finance`, `management-vendor-summary`, `management-tenant-service-summary`. | `/buildings/:buildingId/financial-summary`, `/management/financial-summary`, `/management/operational-finance/budgets/:budgetId/summary`, `/management/buildings/:buildingId/operational-finance-summary`, vendor/tenant management summary routes. | Financial reporting and management read-model services. | `basic_financial_reporting.read`, `management_read_model.read`. | Building/management read-scope scoped; summaries compose operational finance, tenant/vendor, and basic finance sources. | Read models use existing finance/tenant/vendor tables; reporting archive migration exists separately (`0330`). | Financial and operational-finance management summary paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |

### Explicit Verification — Required Procurement / Finance Items

| Required item | Status | Evidence summary |
| --- | --- | --- |
| RFQ | IMPLEMENTED | `rfqs` module with lifecycle and line routes; OpenAPI paths present. |
| Quotation | IMPLEMENTED | `vendor-quotations` with vendor RFQ access/session routes, revisions, lines, attachments, submit; OpenAPI paths present. |
| Multi-vendor comparison | IMPLEMENTED | `rfq-comparisons` and `rfq-recommendations` provide comparison runs, evaluations, recommendation, and award; OpenAPI paths present. |
| Price catalog | IMPLEMENTED | `price-catalog-entries` provides lookup, lifecycle, activation/replacement/correction/deactivation. |
| Price authority | IMPLEMENTED | Price catalog lookup and governed entry lifecycle are authority surfaces; RFQ comparison freezes reference prices and PO price deviation reads current authority. |
| Budget vs committed vs actual | IMPLEMENTED | Operational budgets, commitments, source actualization seams, aggregation, variance, traceability routes/services are present; actuals are source-derived, not directly posted over HTTP. |
| Vendor invoice/payment | IMPLEMENTED | `vendor-invoices` supports finalize, verify, matching, payment, settlement readiness, consistency, trace; OpenAPI paths present. |
| BAST | IMPLEMENTED | Vendor BAST, canonical BAST document foundation/commands, submit/accept/reject routes; OpenAPI vendor BAST paths present. |

### Procurement Final Status

- **Status:** IMPLEMENTED overall, with caveats.
- **Implemented transaction workflow:** purchase request, procurement approval/readiness, RFQ, invitations, vendor quotations, comparison/evaluation, recommendation/award, RFQ-to-PO conversion, purchase order issuance, receiving, vendor invoice/payment.
- **Approval/readiness distinction:** procurement approval and PO readiness are separate surfaces; PO readiness is the readiness authority, not merely a table.
- **Not overclaimed:** procurement is not marked complete solely from migrations; runtime route and service evidence exists for each major stage. Some upstream purchase request/procurement approval OpenAPI coverage remains incomplete.

### Budget / Commitment / Actual Status

- **Status:** IMPLEMENTED.
- **Budget:** operational budgets, categories, lifecycle, source bindings, overspend policy.
- **Commitment:** explicit commitments and PO-line-derived commitments with append-only adjustment/release/cancel semantics.
- **Actual:** actualization is internal/source-driven through material usage and verified vendor invoice seams; there is deliberately no direct HTTP endpoint to write arbitrary actual amounts.
- **Variance/reporting:** aggregation, variance, and traceability read models are exposed.

### Vendor Invoice / Payment Status

- **Status:** IMPLEMENTED.
- **Evidence:** `vendor-invoices` module exposes create/list/detail/update/finalize/cancel/verify/matching/payment/settlement-readiness/consistency/trace routes; migrations `0261`-`0263` and `0274` support invoice, verification, payment status, and procurement linkage.

### BAST Status

- **Status:** IMPLEMENTED.
- **Evidence:** vendor BAST binding routes (`/vendor-basts`, submit, accept, reject), canonical BAST foundation/commands migrations, BAST document services, and acceptance sign-off modules are present. BAST is workflow-capable, not just a document table.

### PART 03 Summary Counts

| Metric | Count |
| --- | ---: |
| Capabilities audited | 24 |
| `IMPLEMENTED` | 11 |
| `RUNTIME_OPENAPI_GAP` | 11 |
| `PARTIAL` / `FOUNDATION_ONLY` | 1 |
| `NOT_FOUND` | 1 |

### Major Web Reconciliation Items

- Tenant master/PIC/space/context, tenant service requests, tenant utility requests, tenant invoices, payment status, and receipts are runtime-implemented but OpenAPI-gapped.
- Permit/contractor/work-permit surfaces are runtime-implemented but OpenAPI-gapped.
- Vendor operational work, service reports, completion reports, verification/rework/history, and service costs are runtime-implemented but OpenAPI-gapped.
- Purchase request CRUD and parts of procurement approval/readiness should be reconciled with OpenAPI and frontend flows.
- Basic expense routes are runtime-implemented but OpenAPI-gapped.
- Parking is not found and should not be planned as available backend capability without new work.

### Major Mobile Reconciliation Items

- Most PART 03 capabilities are web/admin heavy. Mobile relevance is optional except when tenant/vendor/procurement items generate field work orders, permit work status, inspections, evidence, or receiving tasks.
- Vendor/contractor mobile workflows need product confirmation because runtime routes exist mostly as backend/admin/vendor-session surfaces, not a dedicated mobile vendor app API.
- Procurement and finance approvals may be mobile-optional unless mobile approval screens are required.

### PART 03 Validation

- Documentation-only change prepared for `docs/ASENTRA_BACKEND_FINAL_CAPABILITY_INVENTORY.md`.
- Source, OpenAPI, migrations, CI, and dependencies were not modified.
- Broad tests were not run.
- `git diff --check` passed.

### PART 04 Readiness

PART 03 evidence review is complete and ready for PART 04 — Material, SLA, Notification & Document Control, subject to documentation validation and push of this PART 03 commit.

---

## PART 04 — Material, SLA, Notification & Document Control

**Baseline:** `980c33571c63eb5e38ff076b7e978b8bd36bfafa`<br>
**Review mode:** documentation-only audit. No `src`, OpenAPI, migration, CI, or dependency changes were made.<br>
**Evidence method:** inspected registered runtime routers in `src/routes/index.ts`, matching module route/controller/service/repository files under `src/modules`, supporting migrations under `src/database/migrations`, and textual route presence in `docs/api/openapi.yaml`. Migration names alone were not used to mark runtime implementation.

### PART 04 Capability Findings

| # | Capability | Backend module evidence | Runtime route evidence | Service/read-model evidence | Permission evidence | Scope evidence | Migration evidence | OpenAPI status | Implementation status | Web relevance | Mobile relevance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Material master and warehouses | `inventory-items`, `inventory-warehouses`; routers registered in `src/routes/index.ts`. | `/clients/:clientId/inventory-items`, `/inventory-items/:id`, `/buildings/:buildingId/warehouses`, `/clients/:clientId/warehouses`, `/warehouses/:id`. | Inventory item/warehouse services and repositories. | `inventory_item.read/manage`, `inventory_warehouse.read/manage`. | Client/building scoped; warehouses attach to building, items to client. | `0166_create_inventory_items.ts`, `0167_create_inventory_warehouses.ts`. | Inventory item and warehouse paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 2 | Stock / inventory ledger, balance, transfer, adjustment, minimum stock | `inventory-stock-balances`, `inventory-stock-movements`, `inventory-stock-transfers`, `inventory-stock-adjustments`, `inventory-minimum-stocks`. | `/stock-balances`, `/stock-movements`, `/stock-transfers`, `/adjustments`, `/minimum-stocks` with building/client/warehouse list variants. | Stock balance/movement/transfer/adjustment/minimum stock services and repositories maintain on-hand/reserved/available quantities. | `inventory_stock.read/manage`. | Warehouse, building, client, and item scoped. | `0168_create_inventory_stock_balances.ts`, `0169_create_inventory_stock_movements.ts`, `0170_create_inventory_stock_transfers.ts`, `0171_create_inventory_stock_adjustments.ts`, `0172_create_inventory_minimum_stocks.ts`. | Balance and movement paths present; stock transfer, adjustment, and minimum stock paths were not found in OpenAPI. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 3 | Material request and approved quantity | `material-requests`; router registered. | `/purchase-requests/:purchaseRequestId/material-requests`, `/buildings/:buildingId/material-requests`, `/items/:itemId/material-requests`, `/material-requests/:id`, `/material-requests/:id/cancel`. | `material-request.service.ts` and repository expose approved quantity; repository sets authoritative `approved_quantity`, and detail reads derive remaining quantity. | `material_request.read/manage`. | Purchase request, building, client, item scoped. | `0177_create_material_requests.ts`, `0265_add_material_request_approved_quantity.ts`. | Material request paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 4 | Reservation, demand-capped issue, work-order material issue | `inventory-material-reservations`, `inventory-work-order-material-usages`. | `/material-requests/:materialRequestId/reservations`, `/material-reservations/:id/release|cancel`, `/work-orders/:workOrderId/material-usages`, `/work-orders/:workOrderId/material-cost-summary`, list/detail usage routes. | Reservation service caps reservations by approved demand and available stock; work-order material usage service rejects issue beyond remaining authorized demand or reservation allocation and consumes reserved stock. | `inventory_stock.read/manage`, work-order read/manage context for parent work order. | Material request, reservation, work order, warehouse, building, client scoped. | `0287_create_inventory_material_reservations.ts`, `0288_add_material_request_link_to_wo_usage.ts`, `0289_add_material_reservation_consumption.ts`, `0174_create_inventory_work_order_material_usages.ts`. | Reservation and material usage paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL for field material issue. |
| 5 | UOM snapshot, operational material cost, material traceability | `inventory-stock-movements`, `inventory-work-order-material-usages`, `operational-finance` material actualization seam. | `/work-orders/:workOrderId/material-cost-summary`, material usage and movement read routes. | Stock movement types/services snapshot item UOM at movement time; material usage records total cost and movement linkage; `operational-commitment-material.service.ts` actualizes usage cost against commitments when unambiguous. | `inventory_stock.read/manage`; operational budget actualization is internal/source-driven. | Work order, material request, movement, commitment, building/client scoped. | `0266_add_operational_uom_snapshots.ts`, `0267_add_wo_material_usage_cost.ts`, `0268_add_wo_material_usage_movement_link.ts`, `0311`-`0312` commitment migrations. | Material cost summary path present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 6 | SLA definition and assignment | `sla-definitions`, `applied-slas`; routers registered. | `/clients/:clientId/sla-definitions`, `/sla-definitions/:id`, `/work-orders/:id/sla`. | `sla-definition.service.ts`; `applied-sla.service.ts` applies matching SLA to work order and exposes applied SLA/clock data. | `client_configuration.read/manage`; `work_order.read` for applied SLA read. | Client-scoped definitions; work-order/building scoped applied SLA. | `0291_create_sla_definitions.ts`, `0292_create_applied_slas_and_clocks.ts`. | SLA definition and work-order SLA read paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 7 | SLA clock, pause/resume, deadline, breach | `applied-slas`, `sla-clock-lifecycle.service.ts`. | Read via `/work-orders/:id/sla`; lifecycle is triggered by work-order state transitions and due-clock processing, not direct pause/resume HTTP commands. | Repository manages `sla_clocks` and `sla_clock_pause_intervals`; lifecycle service pauses/resumes resolution clock on work-order hold/resume; due processing marks breaches and records operational event. | `work_order.read` for read; lifecycle uses work-order transition authority internally. | Work order, building, client scoped; clock type response/resolution scoped to applied SLA. | `0292_create_applied_slas_and_clocks.ts`, `0293_create_sla_clock_pause_intervals.ts`, `0294_add_sla_clock_breach.ts`. | Work-order SLA read path present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 8 | SLA escalation policies and escalation action ledger | `sla-escalation-policies`, `sla-escalation-actions`. | `/clients/:clientId/sla-escalation-policies`, `/sla-escalation-policies/:id/levels`, `/work-orders/:id/sla/escalations`. | Policy service manages levels; escalation action service materializes immutable escalation actions at breach time and trigger service turns due actions into notification intent. | `client_configuration.read/manage`, `work_order.read` for escalation history. | Client policy scope; action ledger is work-order/building/client scoped and frozen at breach time. | `0295_create_sla_escalation_policies.ts`, `0296_create_sla_escalation_levels.ts`, `0297_create_sla_escalation_actions.ts`. | Escalation policy and work-order escalation paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 9 | SLA evidence/history/reporting read model | Applied SLA read includes clocks and pause intervals; escalation history route exists; operational events record breach/pause/resume/escalation events. No dedicated SLA reporting dashboard module found. | `/work-orders/:id/sla`, `/work-orders/:id/sla/escalations`. | Applied SLA service, escalation action read service, operational events history. | `work_order.read`. | Work-order/building/client scoped. | SLA clock/escalation migrations plus `operational_events`. | Work-order SLA/escalation paths present. | PARTIAL | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 10 | In-app notifications | `notifications`, `notification-templates`, `notification-subscriptions`, `notification-delivery`. | `/notifications`, `/notifications/:id`, `/notifications/:id/read`, template and subscription routes. | `notification.service.ts` and `notification-delivery.service.ts` create recipient in-app records; templates/subscriptions govern content and recipient preferences. | Notification inbox routes are authenticated-user scoped; template/subscription routes use `notification_template.*` and `notification_subscription.*`. | Recipient user/client/building/entity scoped through notification intent. | `0237_create_notifications.ts`, `0238_create_notification_templates.ts`, `0239_create_notification_event_subscriptions.ts`, `0240_add_notification_delivery_columns.ts`. | Notification inbox, template, subscription paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_REQUIRED. |
| 11 | Outbound delivery ledger, retry/backoff, delivery evidence | `notification-delivery`, `notification-outbound-deliveries`; no public route module for outbound delivery execution. | Internal execution service only; no direct HTTP dispatch route found. | `outbound-delivery-execution.service.ts` claims due outbound rows, invokes providers, records attempts, status, next retry, exponential backoff with jitter, and provider outcome evidence. | Internal worker/service path; no user-facing permission. | Outbound delivery row + recipient/channel scoped. | `0298_create_notification_outbound_deliveries.ts`, `0299_add_notification_delivery_attempt_linkage.ts`, `0302_add_outbound_delivery_feedback.ts`. | No outbound delivery admin/API paths found. | INTERNAL_ONLY | INTERNAL_BACKEND_ONLY | INTERNAL_BACKEND_ONLY. |
| 12 | Email provider | `email-delivery`, `notification-delivery/outbound-delivery-execution.service.ts`. | Internal provider execution only; no email send HTTP route found. | Email adapter abstraction, SMTP/noop adapter, email delivery repository/service; execution service normalizes provider outcomes and retryability. | Internal backend provider seam. | Outbound delivery channel `EMAIL`; recipient/email address scoped by delivery record. | `0241_create_notification_email_deliveries.ts`, `0298`-`0299` outbound ledger migrations. | No provider send route found. | INTERNAL_ONLY | INTERNAL_BACKEND_ONLY | INTERNAL_BACKEND_ONLY. |
| 13 | WhatsApp provider | `whatsapp-delivery`, `whatsapp-callback`, `notification-delivery/outbound-delivery-execution.service.ts`. | Internal provider execution/callback support; no user-facing send route found. | WhatsApp adapter/repository/service and sanitizer; outbound execution invokes WhatsApp adapter and records normalized provider result. | Internal backend provider seam. | Outbound delivery channel `WHATSAPP`; recipient/phone template context. | `0242_create_notification_whatsapp_deliveries.ts`, `0301_add_user_whatsapp_contact_consent.ts`, outbound ledger migrations. | No provider send route found. | INTERNAL_ONLY | INTERNAL_BACKEND_ONLY | INTERNAL_BACKEND_ONLY. |
| 14 | Push provider and invalid token handling | `push-delivery`, `notification-push-deliveries`, `notification-delivery/outbound-push-dispatch.service.ts`, `push-tokens`. | Provider dispatch is internal; push token registration routes are separate. | FCM/noop push adapter, per-device push delivery record repository, fan-out/dispatch services, token telemetry and invalidation reconciliation. Invalid provider tokens are recorded as evidence and reconciled without treating provider acceptance as device display/read. | Internal provider seam; token routes are authenticated mobile user routes. | User/device/token scoped; outbound delivery recipient fans out to active user tokens. | `0334_extend_mobile_push_tokens_for_delivery.ts`, `0335_widen_outbound_delivery_channels_for_push.ts`, `0336_create_notification_push_deliveries.ts`, `0235_create_mobile_push_tokens.ts`. | Push token routes present; provider attempt ledger routes not public. | INTERNAL_ONLY | INTERNAL_BACKEND_ONLY | MOBILE_REQUIRED for token registration; provider execution internal. |
| 15 | Mobile push token registration | `push-tokens`; router registered. | `/mobile/push-tokens`, `/mobile/push-tokens/:tokenId`. | `push-token.service.ts`, delivery telemetry and invalidation services. | Authenticated mobile context; route does not expose provider credentials. | User/device/platform scoped. | `0235_create_mobile_push_tokens.ts`, `0334_extend_mobile_push_tokens_for_delivery.ts`. | Push token paths present. | IMPLEMENTED | WEB_OPTIONAL | MOBILE_REQUIRED. |
| 16 | Notification history | `notification-history`, plus email/WhatsApp/push delivery repositories. | `/notification-history`, `/notification-history/:channel/:historyId`. | `notification-history.service.ts` reads channel histories. | Authenticated route; module uses notification history access checks. | Channel/history/user/client scoped. | Email/WhatsApp/push/outbound delivery migrations. | Notification history paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 17 | Evidence/document linkage | `evidence`, `evidence-requirements`, `work-order-evidence`, finding evidence paths, mobile evidence. | `/evidence`, `/evidence/:id`, `/work-orders/:id/evidence`, `/findings/:id/evidence`, `/mobile/evidence`, evidence requirement routes. | `evidence.service.ts`, work-order/finding evidence handlers, evidence requirement service. | `evidence.read/manage`, `finding.review` for verification evidence. | Execution, work order, finding/rework/verification, client/building scoped through source records. | `0072_create_evidence_requirements.ts`, `0073_create_evidence_submissions.ts`, `0087_add_work_order_evidence_binding.ts`, `0277_add_finding_evidence_parents.ts`. | Evidence and evidence requirement paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_REQUIRED. |
| 18 | Evidence integrity, hashing, integrity verification | `evidence/evidence-integrity.ts`, `evidence-file.routes.ts`, `evidence-integrity-verification.service.ts`. | `/evidence/:evidenceId/file`, `/evidence/:evidenceId/file/content`, `/evidence/:evidenceId/integrity-verification`, `/mobile/evidence`. | Server computes SHA-256 from uploaded bytes only; verification recomputes stored object hash and persists last integrity status/check time with operational events. | `evidence.read/manage`. | Evidence/client/building scoped via evidence source ownership. | `0303_add_evidence_integrity_metadata.ts`. | Evidence file and integrity verification paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_REQUIRED for upload; verification usually web/admin. |
| 19 | Evidence retention policy and enforcement | `evidence-retention-policies`, evidence file hold routes. | `/clients/:clientId/evidence-retention-policies`, `/evidence-retention-policies/:id`, `/evidence/:evidenceId/retention-hold`; retention execution is internal bounded processor. | Policy service/admin routes, retention application service, execution service marks due/purges eligible evidence, skips holds, audits due/purge/failure. | `client_configuration.read/manage` for policies; `evidence.manage` for holds. | Client and optional building/evidence type/execution type scope; evidence row scope for holds/purge. | `0304_create_evidence_retention_policies.ts`, `0305_add_evidence_purged_at.ts`. | Retention policy and hold paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 20 | Document metadata, versions, expiry, approvals, archive | `documents`, `document-versions`, `document-expiry`, `document-approvals`, plus specialized BAST/handover/supporting/work-completion document modules. | `/documents`, `/documents/:id/archive|restore`, `/documents/:documentId/versions`, `/documents/:documentId/expiry`, `/documents/:documentId/approvals`, approval decision routes. | Document service/repository, version/expiry/approval services; archive support and operational event auditability. | `document.read/manage/archive/approve`. | Document target/client/building scope depends on source target and document metadata. | `0224_create_documents.ts`, `0230_create_document_versions.ts`, `0231_add_document_expiry.ts`, `0232_add_document_approval_target.ts`, `0233_add_document_archive.ts`. | Generic document metadata/version/expiry/approval paths were not found in OpenAPI; specialized BAST document paths exist. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL. |

### Dedicated Status — Material Control

- **Status:** IMPLEMENTED.
- **Important implemented capabilities:** material master, warehouse, stock balances, stock movements, transfer/adjustment/minimum stock runtime surfaces, material request, approved quantity, material reservations, demand-capped issue, reservation-backed work-order material usage, UOM snapshots, operational material cost, material movement linkage, and material-cost summary.
- **Final CR-BE-INV-CONTROL verification:** Runtime/service evidence exists for approved demand cap (`approved_quantity`), reservation cap, reservation consumption, work-order usage linkage, UOM snapshots, cost capture, and operational commitment material actualization seam. OpenAPI gaps remain for stock transfer/adjustment/minimum-stock routes, but the final material control behavior is implemented at runtime.

### Dedicated Status — SLA

- **SLA clock/breach status:** IMPLEMENTED. SLA definition/application, work-order applied SLA read, response/resolution clocks, pause/resume intervals, deadline/breach detection, and breach operational events are present.
- **SLA escalation status:** IMPLEMENTED. Escalation policies/levels exist, breach-time escalation actions are materialized in a durable ledger, escalation history is readable from the work order, and due escalation trigger service creates notification intent.
- **Distinction:** Clock/breach is owned by `applied-slas` and clock lifecycle services; escalation is separately owned by `sla-escalation-policies` and `sla-escalation-actions` and is optional/policy-driven after breach.

### Dedicated Status — Notification Providers

- **EMAIL:** INTERNAL_ONLY. Email provider adapter and outbound execution are implemented internally with provider result normalization and retry handling; no user-facing send route exists.
- **WHATSAPP:** INTERNAL_ONLY. WhatsApp adapter/callback/delivery persistence and outbound execution are implemented internally; no user-facing send route exists.
- **PUSH:** INTERNAL_ONLY for provider dispatch and attempt evidence; IMPLEMENTED for mobile push token registration. Push provider acceptance is recorded as provider acceptance only and must not be interpreted as device delivery, read, or display.

### Dedicated Status — Document / Evidence Control

- **Status:** IMPLEMENTED, with OpenAPI gap for generic document metadata/version/expiry/approval routes.
- **Implemented capabilities:** evidence upload/linkage, server-side SHA-256 hashing, integrity verification, integrity audit events, retention policies, retention holds, due/purge enforcement, purged tombstone handling, document metadata, document versions, expiry, approvals, archive/restore, and auditability through operational events.
- **Final CR-BE-DOC-CONTROL verification:** Evidence integrity and retention enforcement are implemented with runtime services/routes and migrations; document control runtime exists, while generic document OpenAPI coverage remains incomplete.

### PART 04 Summary Counts

| Metric | Count |
| --- | ---: |
| Capabilities audited | 20 |
| `IMPLEMENTED` | 13 |
| `RUNTIME_OPENAPI_GAP` | 2 |
| `PARTIAL` / `FOUNDATION_ONLY` | 1 |
| `INTERNAL_ONLY` | 4 |
| `NOT_FOUND` | 0 |

### Major Web Reconciliation Items

- Inventory stock transfers, adjustments, and minimum-stock runtime routes need OpenAPI/frontend reconciliation.
- SLA has read and configuration surfaces; no dedicated SLA reporting dashboard route was found beyond work-order SLA/escalation read and operational events.
- Outbound notification provider execution is backend/internal; web should consume notification inbox/history/configuration, not provider send internals.
- Generic document metadata/version/expiry/approval routes are runtime-implemented but OpenAPI-gapped; specialized BAST document OpenAPI coverage does not cover the generic document surface.
- Evidence retention execution is an internal bounded processor; web-facing controls are policy administration and retention hold/unhold.

### Major Mobile Reconciliation Items

- Mobile-required surfaces: notification inbox/read, push token registration, mobile evidence upload/read, and field material usage if mobile material issue is needed.
- Provider acceptance for push/email/WhatsApp must not be displayed as device delivery/read/displayed; only provider attempt outcome is evidenced.
- SLA escalation/provider execution is internal; mobile should consume task/work-order/notification outputs rather than direct escalation or provider routes.
- Document metadata/version/approval is mostly web/admin; mobile relevance is optional unless field document review/approval is required.

### PART 04 Validation

- Documentation-only change prepared for `docs/ASENTRA_BACKEND_FINAL_CAPABILITY_INVENTORY.md`.
- Source, OpenAPI, migrations, CI, and dependencies were not modified.
- Broad tests were not run.
- `git diff --check` passed.

### PART 05 Readiness

PART 04 evidence review is complete and ready for PART 05 — Integration, Audit, Currency, FX & Reporting, subject to documentation validation and push of this PART 04 commit.

---

## PART 05 — Integration, Audit, Currency, FX & Reporting

**Baseline:** `0b5ce317d97257bda2a46540e854319d8f0513c1`<br>
**Review mode:** documentation-only audit. No `src`, OpenAPI, migration, CI, or dependency changes were made.<br>
**Evidence method:** inspected registered runtime routers in `src/routes/index.ts`, matching module route/controller/service/repository files under `src/modules`, supporting migrations under `src/database/migrations`, and textual route presence in `docs/api/openapi.yaml`. Migration names alone were not used to mark runtime implementation.

### PART 05 Capability Findings

| # | Capability | Backend module evidence | Runtime route evidence | Service/read-model evidence | Permission evidence | Scope evidence | Migration evidence | OpenAPI status | Implementation status | Web relevance | Mobile relevance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Integration webhook endpoint configuration | `integration-webhook-endpoints`; router registered in `src/routes/index.ts`. | `/integration/webhook-endpoints`, `/integration/webhook-endpoints/:id`, `/integration/webhook-endpoints/:id/rotate-secret`. | Endpoint service/repository/secret/probe validate client/building-scoped endpoint registry, URL safety, secret rotation, subscription probe. | `integration_webhook.read/manage`. | Client scoped with optional building narrowing. | `0307_create_integration_webhook_endpoints.ts`. | Paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 2 | Integration outbox, webhook delivery, retry, idempotency, delivery evidence/history | `integration-outbox`, `integration-webhook-deliveries`. | Delivery history read routes: `/integration/webhook-deliveries`, `/integration/webhook-deliveries/:id`. Dispatch/fan-out/execution are internal worker services. | Transactional outbox enqueue is idempotent on operational event; delivery ledger is one row per outbox event + endpoint; execution signs and POSTs, records attempts/status/next retry, and retry exhaustion. | `integration_webhook.read` for history; execution itself is backend worker/internal. | Client/building/event/outbox endpoint scoped; receiver-facing idempotency key is delivery id. | `0306_create_integration_outbox_events.ts`, `0308_create_integration_webhook_deliveries.ts`, `0309_add_operational_event_correlation.ts`. | Delivery history paths present. | IMPLEMENTED | WEB_REQUIRED for config/history | INTERNAL_BACKEND_ONLY for dispatcher. |
| 3 | Inbound integration / MarkiCam readiness | No inbound integration, inbound webhook, or MarkiCam module/route/service evidence found by repository-wide search. | None found. | None found. | None found. | None found. | None found. | None found. | NOT_FOUND | WEB_OPTIONAL if product requires it | MOBILE_OPTIONAL. |
| 4 | Security/account audit events | `audit`; router registered. | `/auth/audit-events`. | `audit.service.ts` and repository expose authentication/security audit events. | `auth.audit.read`. | Security/account audit scope; not the same as operational event history. | Audit foundation migrations from auth/audit baseline; no PART 05-specific migration. | Path present. | IMPLEMENTED | WEB_REQUIRED for admin/security | MOBILE_OPTIONAL. |
| 5 | Enterprise operational events / traceability | `operational-events`; also used broadly by domain services. | `/operational-events`, `/operational-events/:id`. | Operational event route queries `operational_events` with filters for client, building, actor, event type, entity type/id, request id, source, from/to; maps actor/entity/client/building/timestamps/metadata. | `operational_event.read`. | Client/building access enforced; inaccessible events are hidden as not found. | `0080_create_operational_events.ts`, `0309_add_operational_event_correlation.ts`. | Paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 6 | Audit export/retention/integrity | Reporting export can export supported projections; evidence retention/integrity exists, but no audit-specific retention or integrity module/route was found for auth audit or operational events. | `/reports/export`, reporting archive routes; no audit-specific retention route. | Reporting export/archives services; operational events are searchable but no dedicated audit retention/integrity service. | `reporting_export.read`, `report_export.generate`, `report_archive.read`; audit permissions for source audit reads. | Projection/report scope; not an audit-specific governance retention scope. | `0330_create_report_archives.ts` plus source audit/event tables. | Export/archive paths present. | PARTIAL | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 7 | Currency master / currency code authority | `currencies` repository/service and `client-monetary-contexts`; no public currency router found. | No currency master HTTP route found. | `currencyRepository` lists/finds/updates status internally; `clientMonetaryContextService` stores base/default/allowed currencies and command-time `assertActiveAllowedCurrency` guards transaction writes. | Internal service authority; no route permission surface found. | Global currency master plus client monetary context. | `0331_create_currency_reference_and_client_monetary_context.ts`. | No currency master paths found. | INTERNAL_ONLY | WEB_REQUIRED later if currency admin UI is needed | MOBILE_OPTIONAL. |
| 8 | Transaction currency snapshots and multi-currency safety | Transaction modules use currency snapshots: tenant invoices/charges, utility bills, vendor service costs, vendor invoices, basic expenses, inventory material usage costs, purchase/PO/price catalog, operational budgets/commitments. | Exposed through each transaction route, not one currency route. | Services call `assertActiveAllowedCurrency` / `assertActiveAllowedCurrencyCommand`; reporting groups exact currencies and keeps UNKNOWN bucket. | Source transaction permissions. | Client/building/transaction scoped; currency is captured on source transaction or snapshot. | `0332_add_operational_billing_currency_snapshots.ts`, `0266_add_operational_uom_snapshots.ts`, plus source transaction migrations. | Reflected in OpenAPI financial reporting contract text; no standalone currency route. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 9 | FX rate authority and client FX policy | `fx-rates`; router registered. | `/fx-rates`, `/fx-rates/:rateId`, `/fx-rates/:rateId/events`, `/fx-rates/:rateId/approve|reject|supersede|deactivate`, `/clients/:clientId/fx-policy`. | `fx-rate-lifecycle.service.ts`, `client-fx-policy.service.ts`, repository; lifecycle records rate events, source, effective window, approval/supersession/deactivation. | `fx_rate.read/manage/approve`, `client_fx_policy.read/manage`. | Global rate pair/effective date/source authority plus client FX policy scope. | `0333_create_fx_rate_authority_and_client_fx_policy.ts`. | Paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 10 | FX conversion service and provenance | `fx-rates/fx-conversion.service.ts`, `fx-conversion.gateway.ts`, `fx-reporting.service.ts`; no public conversion route found. | No direct `/fx/convert` route found. | Conversion service is the single arithmetic authority: validates active currencies, client FX policy, allowed currencies, reporting target, direct/inverse rate, source, staleness, effective date, rounding; returns converted amount and rate provenance. | Internal service call; no direct route permission. | Client, source currency, target/reporting currency, reference date scoped. | `0333_create_fx_rate_authority_and_client_fx_policy.ts`. | No direct conversion endpoint; FX rate/policy routes documented. | INTERNAL_ONLY | WEB_OPTIONAL via reporting views | MOBILE_OPTIONAL. |
| 11 | Basic financial reporting — CR-BE-FIN-RPT-01 final contract | `basic-financial-reporting`; router registered. | `/buildings/:buildingId/financial-summary`. | `basic-financial-reporting.service.ts` and `basic-financial-reporting.monetary-summary.ts` build `monetarySummary`, `byCurrency`, `unknown`, `distinctKnownCurrencies`, `hasUnknown`, `singleCurrencyCode`; legacy scalar amounts are nullable unless exactly one known currency and no UNKNOWN. | `basic_financial_reporting.read`. | Building scoped; optional tenant/period filters. | Source finance migrations; currency snapshots from `0331`/`0332`; no separate reporting table. | Path and currency-safe contract text present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 12 | Management financial summary | `management-financial-summary`; router registered. | `/management/financial-summary`. | Service composes building financial summaries into management read-scope contract while preserving currency-safe behavior. | `management_read_model.read`. | Management read scope over accessible buildings/clients/date range. | Uses source finance/reporting tables; no dedicated migration. | Path present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 13 | Budget / committed / actual operational finance reporting | `operational-finance`, `management-operational-finance`, `management-building-operational-finance`. | `/operational-budgets/:budgetId/aggregation`, `/operational-budgets/:budgetId/variance`, `/operational-budget-variance`, `/operational-budgets/:budgetId/traceability`, `/management/operational-finance/budgets/:budgetId/summary`, `/management/buildings/:buildingId/operational-finance-summary`. | Operational finance aggregation/variance/traceability services report planned, committed, actualized/unallocated actual, remaining and variance. | `operational_budget.read`, `management_read_model.read`. | Budget/building/client/category/currency scoped; ambiguous/mixed currency contributions fail closed. | `0283`, `0311`, `0312` operational budget/commitment migrations and source actual migrations. | Paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 14 | Reporting export and report archives | `reporting-export`, `reporting-archives`. | `/reports/export`, `/reporting/exports`, `/reporting/exports/:id`, `/reporting/archives`, `/reporting/archives/:id`, `/reporting/archives/:id/download`. | Export registry/renderers support CSV/PDF/XLSX projections; archive generation/service persists export/archive metadata and download. | `reporting_export.read`, `report_export.generate`, `report_archive.read`. | Requested projection/filter scope; archive records tied to generated report. | `0330_create_report_archives.ts`. | Paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 15 | Management / owner core executive summaries | `management-portfolio-overview`, `management-operations-command-center`, `management-daily-operations`, `management-operational-kpi`, `management-work-order-summary`, `management-critical-findings`, `management-workforce-summary`, `management-building-performance`. | `/management/portfolio-overview`, `/management/operations-command-center`, `/management/daily-operations`, `/management/operational-kpi`, `/management/work-order-summary`, `/management/critical-findings`, `/management/workforce-summary`, `/management/building-performance`. | Corresponding services/controllers create read-scope contracts over source domain data. | `management_read_model.read`. | Management read scope over accessible clients/buildings/date/as-of filters. | Read models use source tables; no dedicated read-model migration. | Paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 16 | Management utility, IKE, IKA read models | `management-utility-summary`, `utility-kpi`, `building-utility-reconciliations`. | `/management/utility-summary`, `/buildings/:buildingId/utility-summary`, `/utility/reports/kpi`, utility reconciliation routes from PART 02. | Management utility summary includes reconciliations; utility KPI delegates to utility aggregations; IKE/IKA snapshots come from building utility reconciliation. | `management_read_model.read`, `utility_kpi.read`, `utility_meter.read`. | Management/building/period scoped. | Utility and reconciliation migrations including `0280`. | Management utility paths present; `/utility/reports/kpi` path not found in OpenAPI. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 17 | ESG reporting/read models | `esg-read-models`; router registered. | `/esg/kpi`, `/management/esg-summary`. | ESG read model summarizes ESG metric values and waste records with provenance and no utility recalculation/UOM conversion. | `esg.read`. | Accessible building/date scope. | ESG metric/waste/value migrations `0326`-`0328`. | Paths present textually. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 18 | Engineering reporting/read models | `engineering-reports`, `engineering-overview`; routers registered. | `/engineering/reports/technical-summary`, `/engineering/reports/inspections`, `/meter-readings`, `/equipment-logs`, `/checklists`, `/breakdowns`, `/maintenance`, `/findings`, plus `/buildings/:buildingId/engineering/overview`. | Engineering report/overview services aggregate engineering operation, work, inspection, meter, equipment, checklist, breakdown, maintenance, and findings datasets. | `engineering_report.read`, `engineering_overview.read`. | Building/date/shift/filter scoped. | Uses engineering/work/order/source tables; no dedicated reporting migration. | Engineering report paths present. | IMPLEMENTED | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 19 | Housekeeping and security reporting/KPIs | `housekeeping-reports`, `security-reports`, `security-patrol-kpi`, `security-finding-incident-kpi`. | Housekeeping report routes are present; security report and KPI runtime routes are present. | Housekeeping/security report and KPI services aggregate cleaning, inspections, findings, consumables, quality, complaints, patrol, shift handover, incidents, visitors/keys/lost-found. | `housekeeping_report.read`, `security_report.read`, `security_patrol_kpi.read`, `security_finding_incident_kpi.read`. | Building/date/filter scoped. | Uses housekeeping/security source tables; no dedicated reporting migration. | Housekeeping report paths present; most security report/KPI paths were not found except limited security paths. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 20 | Tenant/vendor/procurement management summaries | `management-tenant-service-summary`, `management-vendor-summary`, `vendor-tenant-kpi`, procurement/RFQ/PO read surfaces. | `/management/tenant-service-summary`, `/management/vendor-summary`, `/reports/vendor-tenant-kpi`, procurement/RFQ/PO reportable routes from PART 03. | Management tenant/vendor summary services and vendor-tenant KPI service. Procurement executive summary is represented through management/vendor/finance/PO/RFQ surfaces, not a separate `management-procurement-summary` module. | `management_read_model.read`, `vendor_tenant_kpi.read`. | Management read scope; vendor/tenant/building/date filters. | Source tenant/vendor/procurement tables; no dedicated summary migration. | Management tenant/vendor paths present; `/reports/vendor-tenant-kpi` path was not found in OpenAPI. | RUNTIME_OPENAPI_GAP | WEB_REQUIRED | MOBILE_OPTIONAL. |
| 21 | Currency reporting / reporting-currency read seam | `currency-reporting`, `fx-rates/fx-reporting.service.ts`; not registered as its own router. | No dedicated currency-reporting route found. | Existing exact-currency read seam returns no cross-currency grand total; additional reporting-currency service can build converted view from FX policy/rates but is not exposed directly as an API route in this repository state. | Internal service/read seam. | Building/client/reporting currency scoped. | `0331`-`0333` currency/FX migrations. | No route found. | INTERNAL_ONLY | WEB_OPTIONAL | MOBILE_OPTIONAL. |

### Dedicated Final Status

#### INTEGRATION / WEBHOOK / OUTBOX

- **Status:** IMPLEMENTED.
- **Runtime capability:** webhook endpoint configuration, transactional outbox, subscription probe, fan-out, delivery ledger, signed HTTP delivery, retry/backoff/exhaustion, and read-only delivery history are implemented.
- **Provider-specific distinction:** this is generic webhook infrastructure; no MarkiCam-specific or inbound integration implementation was found.

#### ENTERPRISE AUDIT

- **Status:** IMPLEMENTED.
- **Security/account audit:** `/auth/audit-events` with `auth.audit.read` is implemented for authentication/security audit.
- **Operational event history:** `/operational-events` and `/operational-events/:id` with `operational_event.read` are implemented for actor/entity/client/building/request/source/timestamp traceability.
- **Audit retention/integrity:** no audit-specific retention or integrity workflow was found; evidence retention/integrity is separate from enterprise audit.

#### CURRENCY

- **Status:** IMPLEMENTED for transaction safety and reporting semantics; `INTERNAL_ONLY` for currency master administration.
- **Currency master/code authority:** `currencies` repository/service and `client-monetary-contexts` exist internally; no public currency master route was found.
- **Transaction currency:** transaction services validate active/allowed currencies and persist currency snapshots.
- **UNKNOWN:** explicitly represented for historical/null currency rows in reporting.
- **Mixed currency:** grouped by exact currency and protected from unsafe scalar aggregation.

#### FX

- **Status:** IMPLEMENTED, with conversion as an internal service rather than a public conversion endpoint.
- **Implemented:** FX rate authority, source/effective window/lifecycle/events, client FX policy, conversion service, source/target currency validation, converted amount, rate provenance, staleness/source permissions, direct/inverse handling, and fail-closed errors.
- **Not inferred from currency:** FX evidence comes from `fx-rates` services/migrations and `fx-conversion.service.ts`, not merely from currency fields.

#### BASIC FINANCIAL REPORTING

- **Status:** IMPLEMENTED.
- **CR-BE-FIN-RPT-01 final contract:** verified. `monetarySummary.byCurrency` is authoritative; `unknown`, `distinctKnownCurrencies`, `hasUnknown`, and `singleCurrencyCode` are present; legacy scalar amounts are nullable unless exactly one known currency and no UNKNOWN.
- **FX usage:** basic financial reporting does **not** perform FX conversion. It deliberately reports authoritative values by exact source currency.

#### MANAGEMENT / EXECUTIVE REPORTING

- **Status:** IMPLEMENTED overall, with OpenAPI gaps for some KPI/report paths.
- **Actual read models found:** portfolio overview, operations command center, daily operations, operational KPI, work-order summary, critical findings, workforce summary, vendor summary, tenant service summary, asset registry compliance, asset reliability work, utility summary, building performance, financial summary, operational finance, building operational finance, ESG summary/KPI, engineering reports, housekeeping reports, security reports/KPIs, utility KPI, vendor-tenant KPI, and reporting export/archive.
- **Not found as a dedicated module:** a standalone `management-procurement-summary` route/module; procurement visibility is through RFQ/PO/vendor/finance/reporting surfaces.

### Explicit Currency / FX / Reporting Statements

1. **FX is implemented:** yes — FX rate authority, client FX policy, and conversion service exist.
2. **Basic financial reporting uses FX:** no — it reports exact source-currency values and does not convert.
3. **Mixed-currency grand totals are prohibited:** yes — no fabricated cross-currency grand total is produced; unsafe legacy scalars become `null`.
4. **`byCurrency` is authoritative:** yes — `monetarySummary.byCurrency` is the authoritative financial reporting total surface.
5. **UNKNOWN is explicit:** yes — unknown/null currency is surfaced separately and excluded from known-currency arithmetic.
6. **Management KPI/read models that actually exist:** management portfolio overview, operations command center, daily operations, operational KPI, work-order summary, critical findings, workforce summary, vendor summary, tenant service summary, asset registry compliance, asset reliability work, utility summary, building performance, financial summary, operational finance, building operational finance, utility KPI, vendor-tenant KPI, workforce KPI, security patrol KPI, security finding/incident KPI, ESG KPI/summary, engineering reports, housekeeping reports, and security reports.

### PART 05 Summary Counts

| Metric | Count |
| --- | ---: |
| Capabilities audited | 21 |
| `IMPLEMENTED` | 13 |
| `RUNTIME_OPENAPI_GAP` | 3 |
| `PARTIAL` / `FOUNDATION_ONLY` | 1 |
| `INTERNAL_ONLY` | 3 |
| `NOT_FOUND` | 1 |

### Major Web Reconciliation Items

- Currency master and client monetary context have internal services but no public admin route; web currency administration needs product/API reconciliation.
- FX conversion exists as an internal governed service, not a direct `/fx/convert` endpoint; web should use documented rate/policy/reporting surfaces unless a conversion API is explicitly added later.
- Utility KPI, vendor-tenant KPI, security report/KPI, and some reporting paths have runtime/OpenAPI gaps to reconcile.
- No inbound integration or MarkiCam-specific integration was found.
- No audit-specific retention/integrity workflow was found; do not conflate evidence retention with enterprise audit retention.

### Major Mobile Reconciliation Items

- Most PART 05 capabilities are web/admin or backend/internal.
- Mobile-facing relevance is mainly notification-derived workflows and any mobile dashboard/KPI screens product explicitly requires.
- Webhook dispatch, FX conversion service, currency master service, report generation/archive, and audit search are not mobile-primary surfaces.
- Mobile should not assume management KPI/read models exist beyond the routes listed above.

### PART 05 Validation

- Documentation-only change prepared for `docs/ASENTRA_BACKEND_FINAL_CAPABILITY_INVENTORY.md`.
- Source, OpenAPI, migrations, CI, and dependencies were not modified.
- Broad tests were not run.
- `git diff --check` passed.

### PART 06 Readiness

PART 05 evidence review is complete and ready for PART 06 — Frontend/Mobile Handoff Matrix, subject to documentation validation and push of this PART 05 commit.

---

## PART 06 — Frontend / Mobile Handoff Matrix

**Baseline:** `e17eb48de2d749c3afa3ad0bc982f12e23d999a7`<br>
**Documentation mode:** consolidation of PART 01–05 findings only. No repository re-audit was performed for this PART. No `src`, OpenAPI, migration, CI, or dependency changes were made.

### Frontend Web Handoff Matrix

| # | Domain | Capability | Backend Status | Runtime Route | OpenAPI Status | Frontend Action |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Core context | Client / company / subscription context | RUNTIME_OPENAPI_GAP | `/clients`, `/subscriptions`, `/clients/:clientId/subscriptions` | Client present; subscription runtime gap | OPENAPI_RECONCILE |
| 2 | Building/location | Property, building, floor, area, room, space, functional location | IMPLEMENTED | `/properties`, `/buildings`, `/buildings/:buildingId/floors`, `/functional-locations` | Present | VERIFY_EXISTING |
| 3 | Building/location | Campus | RUNTIME_OPENAPI_GAP | `/properties/:propertyId/campuses`, `/buildings/:buildingId/campus` | Gap | OPENAPI_RECONCILE |
| 4 | Assets | Asset / equipment / technical records | IMPLEMENTED | `/buildings/:buildingId/assets`, `/assets/:id`, `/assets/:assetId/equipment-profile` | Present | VERIFY_EXISTING |
| 5 | Organization | Organization / department / team | RUNTIME_OPENAPI_GAP | `/organizations`, `/departments`, `/departments/:departmentId/teams` | Gap | OPENAPI_RECONCILE |
| 6 | Workforce | Workforce / position / shift | RUNTIME_OPENAPI_GAP | `/workforce-profiles`, `/positions`, `/buildings/:buildingId/shifts` | Gap | OPENAPI_RECONCILE |
| 7 | Vendor master | Vendor master and master subresources | RUNTIME_OPENAPI_GAP | `/clients/:clientId/vendors`, `/vendors/:id` | Gap | OPENAPI_RECONCILE |
| 8 | Forms | Dynamic forms/source forms/template/version/instances | RUNTIME_OPENAPI_GAP | `/source-forms`, `/form-templates`, `/form-instances` | Gap except measurement patches | OPENAPI_RECONCILE |
| 9 | Checklist/SOP | Checklist templates/executions; no dedicated SOP runtime | PARTIAL | `/checklist-templates`, `/checklist-executions` | Checklist present; SOP not evidenced | ADD_UI |
| 10 | Scheduler | Schedule, recurrence, generated tasks | RUNTIME_OPENAPI_GAP | `/schedules`, `/schedules/:id/recurrence`, `/tasks` | Task present; schedule gap | OPENAPI_RECONCILE |
| 11 | Work orders | Work order lifecycle, assignment, evidence, verification, history | IMPLEMENTED | `/buildings/:buildingId/work-orders`, `/work-orders/:id` | Present | VERIFY_EXISTING |
| 12 | Preventive maintenance | Asset maintenance bindings linked to schedule/task/work order | IMPLEMENTED | `/assets/:assetId/maintenance-bindings` | Present | WIRE_BACKEND |
| 13 | Inspection/findings | Inspections, findings, verification, rework, closure | IMPLEMENTED | `/inspection-bindings`, `/findings`, `/findings/:id/rework` | Present | WIRE_BACKEND |
| 14 | Engineering | Engineering operations, overview, reports, technical findings | IMPLEMENTED | `/engineering/reports/*`, `/buildings/:buildingId/engineering/overview` | Present | WIRE_BACKEND |
| 15 | Utility/meter | Utility meter master/config/hierarchy/tenant assignment | RUNTIME_OPENAPI_GAP | `/utility/meters`, `/utility/type-configurations`, tenant meter routes | Partial | OPENAPI_RECONCILE |
| 16 | Utility/meter | Utility readings, evidence, consumption | IMPLEMENTED | `/utility/meters/:id/readings`, `/utility/meter-readings/:id/evidence` | Present | WIRE_BACKEND |
| 17 | Utility/commercial | Tariffs, calculation basis, utility bills | RUNTIME_OPENAPI_GAP | `/utility-calculations`, `/utility-tariffs`, `/utility-bills` | Partial | OPENAPI_RECONCILE |
| 18 | Utility operations | Exceptions, abnormal consumption, verification | RUNTIME_OPENAPI_GAP | `/utility/exceptions`, `/utility/abnormal-consumptions`, verification routes | Partial | OPENAPI_RECONCILE |
| 19 | Utility analytics | Utility aggregations / KPI | RUNTIME_OPENAPI_GAP | `/utility/aggregations/*`, `/utility/reports/kpi` | Gap | OPENAPI_RECONCILE |
| 20 | IKE | Electricity intensity from building utility reconciliation | IMPLEMENTED | `/buildings/:buildingId/utility-reconciliations` | Present | ADD_UI |
| 21 | IKA | Water intensity from building utility reconciliation | IMPLEMENTED | `/buildings/:buildingId/utility-reconciliations` | Present | ADD_UI |
| 22 | ESG | ESG metric definitions | FOUNDATION_ONLY | `/esg/metric-definitions` | Present | WIRE_BACKEND |
| 23 | ESG | ESG waste records | IMPLEMENTED | `/esg/waste-records` | Present | WIRE_BACKEND |
| 24 | ESG | ESG metric values and periods | PARTIAL | `/esg/metric-values` | Present | WIRE_BACKEND |
| 25 | ESG | ESG KPI / management ESG summary read models | IMPLEMENTED | `/esg/kpi`, `/management/esg-summary` | Present textually | ADD_UI |
| 26 | Tenant | Tenant master/PIC/space/building context | RUNTIME_OPENAPI_GAP | `/tenant-companies`, `/tenant-pics`, `/tenant-spaces` | Gap | OPENAPI_RECONCILE |
| 27 | Tenant | Tenant service requests and utility requests | RUNTIME_OPENAPI_GAP | `/tenant-service-requests`, `/tenant-utility-requests` | Gap | OPENAPI_RECONCILE |
| 28 | Tenant finance | Tenant charges, invoices, payment status, receipts | RUNTIME_OPENAPI_GAP | `/tenant-invoices`, `/payment-receipts`, `/invoice-payment-statuses` | Gap | OPENAPI_RECONCILE |
| 29 | Permits | Work permit and contractor context | RUNTIME_OPENAPI_GAP | `/permits`, `/permit-applications`, `/contractor-contexts` | Gap | OPENAPI_RECONCILE |
| 30 | Vendor operations | Vendor operational assignment/work | RUNTIME_OPENAPI_GAP | `/vendor-assignments/:assignmentId/work`, `/vendor-works` | Gap | OPENAPI_RECONCILE |
| 31 | Vendor operations | Vendor reports, evidence, verification, rework, history | RUNTIME_OPENAPI_GAP | `/vendor-service-reports`, `/vendor-completion-reports`, `/vendor-works/:id/verification` | Gap | OPENAPI_RECONCILE |
| 32 | Vendor finance | Vendor service cost | RUNTIME_OPENAPI_GAP | `/vendor-service-costs` | Gap | OPENAPI_RECONCILE |
| 33 | Procurement | Purchase request, procurement approval, PO readiness | PARTIAL | `/purchase-requests`, `/procurement-approvals`, `/po-readiness` | Partial | OPENAPI_RECONCILE |
| 34 | Procurement | RFQ | IMPLEMENTED | `/rfqs`, `/rfqs/:id/open`, `/rfqs/:id/lines` | Present | ADD_UI |
| 35 | Procurement | Quotation / RFQ vendor portal | IMPLEMENTED | `/vendor-rfq-access/*`, `/vendor-quotations/:quotationId` | Present | ADD_UI |
| 36 | Procurement | Multi-vendor comparison, recommendation, award | IMPLEMENTED | `/rfq-comparisons`, `/rfq-recommendations`, `/rfq-awards` | Present | ADD_UI |
| 37 | Procurement | Purchase order and RFQ-to-PO conversion | IMPLEMENTED | `/purchase-orders`, `/rfq-awards/:awardId/convert-to-po` | Present | WIRE_BACKEND |
| 38 | Procurement | Receiving / procurement receipt | IMPLEMENTED | `/receivings` | Present | WIRE_BACKEND |
| 39 | Vendor finance | Vendor invoice/payment/matching/trace | IMPLEMENTED | `/vendor-invoices`, `/vendor-invoices/:id/payment` | Present | ADD_UI |
| 40 | Price authority | Price catalog and price authority | IMPLEMENTED | `/price-catalog/lookup`, `/price-catalog/entries` | Present | ADD_UI |
| 41 | BAST | BAST / completion / acceptance | IMPLEMENTED | `/vendor-basts`, `/bast-documents` | Present | WIRE_BACKEND |
| 42 | Finance | Operational budget, commitment, actual, variance | IMPLEMENTED | `/operational-budgets`, `/operational-budget-variance` | Present | WIRE_BACKEND |
| 43 | Finance | Basic expenses | RUNTIME_OPENAPI_GAP | `/basic-expenses` | Gap | OPENAPI_RECONCILE |
| 44 | Material/inventory | Material/inventory control, reservations, issue, costs | IMPLEMENTED | `/inventory-items`, `/stock-movements`, `/material-reservations`, `/material-usages` | Partial gaps | OPENAPI_RECONCILE |
| 45 | SLA | SLA definition, applied clock/breach, escalation | IMPLEMENTED | `/sla-definitions`, `/work-orders/:id/sla`, `/sla-escalation-policies` | Present | WIRE_BACKEND |
| 46 | Notification | In-app notification inbox/read/templates/subscriptions/history | IMPLEMENTED | `/notifications`, `/notification-history`, `/notification-templates` | Present | WIRE_BACKEND |
| 47 | Notification providers | Email/WhatsApp/Push provider execution | INTERNAL_ONLY | Internal dispatcher/provider services | Not public | DO_NOT_EXPOSE |
| 48 | Document/evidence | Evidence, integrity, retention, generic documents | IMPLEMENTED | `/evidence`, `/evidence/:id/file`, `/documents` | Evidence present; generic docs gap | OPENAPI_RECONCILE |
| 49 | Integration | Webhook endpoint, outbox, delivery history | IMPLEMENTED | `/integration/webhook-endpoints`, `/integration/webhook-deliveries` | Present | WIRE_BACKEND |
| 50 | Audit | Auth audit and operational events | IMPLEMENTED | `/auth/audit-events`, `/operational-events` | Present | WIRE_BACKEND |
| 51 | Currency | Transaction currency snapshots and exact-currency reporting semantics | IMPLEMENTED | Source transaction routes and reporting routes | Contract text present | VERIFY_EXISTING |
| 52 | FX | FX rate authority and client FX policy | IMPLEMENTED | `/fx-rates`, `/clients/:clientId/fx-policy` | Present | ADD_UI |
| 53 | FX | FX conversion arithmetic service | INTERNAL_ONLY | Internal `fxConversionService` | No public conversion route | DO_NOT_EXPOSE |
| 54 | Financial reporting | Building and management financial summary | IMPLEMENTED | `/buildings/:buildingId/financial-summary`, `/management/financial-summary` | Present | WIRE_BACKEND |
| 55 | Management/KPI/reporting | Management, owner, KPI, domain reporting read models | IMPLEMENTED | `/management/*`, `/reports/*`, domain report routes | Some gaps | OPENAPI_RECONCILE |
| 56 | Reporting export/archive | Export and archive generation/download | IMPLEMENTED | `/reports/export`, `/reporting/exports`, `/reporting/archives` | Present | WIRE_BACKEND |
| 57 | Parking | Parking | NOT_FOUND | None | None | DEFER_BACKEND_GAP |
| 58 | Integration | Inbound / MarkiCam-specific integration | NOT_FOUND | None | None | DEFER_BACKEND_GAP |
| 59 | ESG unsupported scope | Carbon/GHG automation, baseline/target runtime, ESG verification/evidence workflow | PARTIAL | Not implemented as runtime workflow | None | DEFER_BACKEND_GAP |

### Mobile Handoff Matrix

| # | Mobile area | Capability | Backend Status | Runtime Route | OpenAPI Status | Mobile Action |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Role/context | Authenticated role, effective client/building context, current shift/team context | IMPLEMENTED | Auth/context/mobile current-shift/my-team routes from prior mobile surfaces | Present/contracted in mobile docs | VERIFY_EXISTING |
| 2 | Tasks | Mobile assignments and generated tasks | IMPLEMENTED | `/tasks`, mobile assignment routes | Present for task core | VERIFY_EXISTING |
| 3 | Checklist | Mobile checklist execution | IMPLEMENTED | `/mobile/checklist-executions/:id`, `/checklist-executions/:id` | Present | VERIFY_EXISTING |
| 4 | Evidence | Mobile evidence upload/read | IMPLEMENTED | `/mobile/evidence`, `/mobile/evidence/:evidenceId` | Present | VERIFY_EXISTING |
| 5 | Work order | Team/my work-order execution | IMPLEMENTED | `/work-orders/team`, `/work-orders/:id` | Present | WIRE_BACKEND |
| 6 | Inspection | Technical/engineering inspection execution | IMPLEMENTED | `/engineering/inspection-bindings/:id/start`, `/engineering/inspection-executions/:id` | Present | ADD_MOBILE_FLOW |
| 7 | Findings/rework | Finding verification, rework, evidence, resubmit | IMPLEMENTED | `/findings/:id/verification`, `/findings/:id/rework`, evidence routes | Present | ADD_MOBILE_FLOW |
| 8 | Meter reading | Engineering meter-reading execution | IMPLEMENTED | `/engineering/meter-reading-bindings/:id/start`, `/engineering/meter-reading-executions/:id/reading` | Present | ADD_MOBILE_FLOW |
| 9 | Utility | Utility meter lookup/readings/evidence where field teams need them | IMPLEMENTED | `/utility/meters/:id`, `/utility/meter-readings/:id/evidence` | Present/partial | WIRE_BACKEND |
| 10 | Engineering | Engineering field operations context | IMPLEMENTED | Engineering overview/reports and execution context routes | Present | ADD_MOBILE_FLOW |
| 11 | Housekeeping | Cleaning, inspection, evidence, findings | IMPLEMENTED | Housekeeping operational routes and evidence routes from prior parts | Present for major routes | ADD_MOBILE_FLOW |
| 12 | Security | Patrol/logbook/finding/incident operational flows | IMPLEMENTED | Security operational routes from prior backend surfaces | Partial | ADD_MOBILE_FLOW |
| 13 | Material | Work-order material usage / material issue where applicable | IMPLEMENTED | `/work-orders/:workOrderId/material-usages` | Present | ADD_MOBILE_FLOW |
| 14 | Notification | Notification inbox/read | IMPLEMENTED | `/notifications`, `/notifications/:id/read` | Present | WIRE_BACKEND |
| 15 | Push | Push token registration | IMPLEMENTED | `/mobile/push-tokens`, `/mobile/push-tokens/:tokenId` | Present | VERIFY_EXISTING |
| 16 | Push provider | Push provider dispatch and attempt evidence | INTERNAL_ONLY | Internal dispatcher/provider services | Not public | BACKEND_INTERNAL |
| 17 | Offline/sync | Mobile sync/offline support | IMPLEMENTED | Mobile sync routes from existing mobile backend surfaces | Present in mobile contract docs | VERIFY_EXISTING |
| 18 | QR/device | Mobile QR resolution and diagnostics | IMPLEMENTED | Mobile QR/diagnostic routes from existing mobile backend surfaces | Present in mobile contract docs | VERIFY_EXISTING |
| 19 | Device/app | App version, diagnostics, device integration support | IMPLEMENTED | `/mobile/diagnostics`, app version/mobile support routes | Present in mobile contract docs | VERIFY_EXISTING |
| 20 | Workforce | Workforce/shift/team admin data needed by mobile | RUNTIME_OPENAPI_GAP | Workforce/shift/team routes | Gap | OPENAPI_RECONCILE |
| 21 | Tenant/permit | Tenant requests and permit work status if mobile product needs them | RUNTIME_OPENAPI_GAP | Tenant request and permit routes | Gap | OPENAPI_RECONCILE |
| 22 | Procurement/finance | Procurement, vendor invoice, financial reporting | IMPLEMENTED but management-heavy | Procurement/finance web routes | Present/partial | DEFER |
| 23 | IKE/IKA | IKE/IKA management reporting | IMPLEMENTED | Utility reconciliation routes | Present | DEFER |
| 24 | ESG | ESG KPI/records | PARTIAL | `/esg/*` | Present for supported ESG only | DEFER |
| 25 | Integration | Webhook/outbox delivery | IMPLEMENTED | Integration routes/internal dispatcher | Present for admin/history | BACKEND_INTERNAL |
| 26 | Audit/reporting | Audit search, management reports, export/archive | IMPLEMENTED | Audit/reporting routes | Present/partial | BACKEND_INTERNAL |
| 27 | Currency/FX | Currency master, FX rates/policy/conversion | IMPLEMENTED/INTERNAL_ONLY | FX routes; conversion internal | Present for rates/policy | BACKEND_INTERNAL |
| 28 | Parking | Parking | NOT_FOUND | None | None | DEFER |
| 29 | Notification providers | Email/WhatsApp/Push device delivery/read/displayed | NOT_FOUND for device delivery/read/displayed | None | None | BACKEND_INTERNAL |
| 30 | Management dashboards | Owner/executive KPI dashboards | IMPLEMENTED but web-primary | `/management/*` | Present/partial | DEFER |

### Consolidated IMPLEMENTED_RUNTIME / OPENAPI_GAP List Affecting Frontend or Mobile

1. Subscription CRUD/effective runtime routes.
2. Campus runtime routes.
3. Organization, department, and team master runtime routes.
4. Workforce, position, and shift master runtime routes.
5. Vendor master runtime routes.
6. Dynamic form/source/template/version/instance lifecycle runtime routes.
7. Scheduler and recurrence runtime routes.
8. Utility type configuration, meter hierarchy, and tenant meter assignment runtime routes.
9. Utility calculation basis/history/recalculation runtime routes.
10. Utility abnormality and verification runtime routes.
11. Utility aggregation and utility KPI runtime routes.
12. Tenant master/PIC/space/building-context runtime routes.
13. Tenant service request and tenant utility request runtime routes.
14. Tenant charge, invoice, payment status, and receipt runtime routes.
15. Permit, contractor context, and work-permit runtime routes.
16. Vendor operational work runtime routes.
17. Vendor service/completion report, verification, rework, and history runtime routes.
18. Vendor service cost runtime routes.
19. Purchase request and parts of procurement approval/readiness runtime routes.
20. Basic expense runtime routes.
21. Inventory stock transfer, adjustment, and minimum-stock runtime routes.
22. Generic document metadata/version/expiry/approval runtime routes.
23. Security report/KPI runtime routes beyond limited OpenAPI coverage.
24. Vendor-tenant KPI runtime route.
25. Utility KPI route `/utility/reports/kpi`.

### Genuine Backend Gap List — Frontend/Mobile Must Not Fabricate

1. Parking API/workflow: NOT_FOUND.
2. Dedicated SOP module/workflow beyond checklist: not evidenced.
3. ESG carbon/GHG automation, emission factors, and carbon conversion: not implemented.
4. ESG automatic utility/IKE/IKA ingestion or recalculation: not implemented.
5. ESG baseline/target runtime workflow: foundation tables only; no runtime module/route.
6. ESG evidence binding and ESG verification workflow: not implemented.
7. Inbound integration and MarkiCam-specific integration: NOT_FOUND.
8. Audit-specific retention/integrity workflow: not found; evidence retention/integrity is separate.
9. Public FX conversion endpoint: not found; conversion exists as internal governed service.
10. Provider device delivery/read/displayed status for Email/WhatsApp/Push: not implemented; provider acceptance is not device delivery/read/displayed.
11. Standalone management procurement summary module/route: not found.
12. Public currency master administration route: not found; currency master exists as internal service/repository.

### Final Handoff Summary Counts

#### Web

| Action | Count |
| --- | ---: |
| Total Web-relevant capabilities | 59 |
| `VERIFY_EXISTING` | 4 |
| `WIRE_BACKEND` | 17 |
| `ADD_UI` | 10 |
| `OPENAPI_RECONCILE` | 23 |
| `DO_NOT_EXPOSE` | 2 |
| `DEFER_BACKEND_GAP` | 3 |

#### Mobile

| Action | Count |
| --- | ---: |
| Total Mobile-relevant capabilities | 30 |
| `VERIFY_EXISTING` | 8 |
| `WIRE_BACKEND` | 3 |
| `ADD_MOBILE_FLOW` | 7 |
| `OPENAPI_RECONCILE` | 2 |
| `BACKEND_INTERNAL` | 5 |
| `DEFER` | 5 |

### Highest-Priority Frontend Reconciliation Areas

1. OpenAPI reconciliation for runtime-implemented admin/master surfaces: tenant, vendor, workforce, forms, schedules, permits, vendor operations, basic expenses, inventory transfers/adjustments/minimum stock, and generic documents.
2. Build/wire supported procurement UI: RFQ, quotation, comparison, award, PO, receiving, vendor invoice/payment, BAST, and price authority.
3. Expose IKE and IKA from utility reconciliation explicitly.
4. Expose only supported ESG: definitions, waste records, metric values, and read models; do not imply carbon/GHG automation, baselines/targets workflow, utility auto-ingestion, or ESG verification.
5. Preserve currency-safe financial reporting: use `monetarySummary.byCurrency`; do not create frontend FX arithmetic or mixed-currency grand totals.
6. Treat Email/WhatsApp/Push provider execution as backend internal; expose notification inbox/history/settings, not provider-send controls.

### Highest-Priority Mobile Reconciliation Areas

1. Verify existing mobile context, task, checklist, evidence, push token, sync, QR, and diagnostics integrations.
2. Add or wire mobile field flows where product requires them: work orders, inspections, findings/rework, meter readings, housekeeping/security operations, and material usage.
3. Keep management/executive reporting, FX, webhook dispatch, audit search, and provider execution out of mobile unless product explicitly requires read-only screens.
4. Do not display provider acceptance as push/email/WhatsApp device delivery, read, or displayed.

### PART 06 Validation

- Every PART 01–05 Web-relevant capability has been represented in the Web matrix or Backend Gap list.
- IKE is represented explicitly as `IMPLEMENTED`.
- IKA is represented explicitly as `IMPLEMENTED`.
- ESG is represented as supported `PARTIAL` scope only.
- Parking is not represented as implemented and is listed as `NOT_FOUND` / `DEFER_BACKEND_GAP`.
- Internal notification provider execution is marked `DO_NOT_EXPOSE` / `BACKEND_INTERNAL`.
- No frontend FX calculation is implied; FX conversion remains backend/internal and basic financial reporting remains exact-currency only.
- Runtime/OpenAPI gaps from PART 01–05 are preserved in the consolidated OpenAPI gap list.
- `git diff --check` passed.

### PART 06 Stop Point

PART 06 handoff consolidation is complete. This document is now the authoritative backend capability handoff for Asentra-Frontend and Asentra-Mobile reconciliation.
