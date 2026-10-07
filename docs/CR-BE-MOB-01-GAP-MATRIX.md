# CR-BE-MOB-01 — Mobile Operational Gap Matrix

> **Status:** PART 01 complete (Housekeeping contract published);
> PART 02 complete (Security contract published);
> PART 03 complete (Engineering contract published);
> PART 04 complete (Work Order material context + verification composition);
> PART 05 complete (QR operational-context boundary);
> PART 06 complete (offline sync resource-kind extension);
> PART 07 complete (push delivery boundary — BE-26 channel);
> PART 08 complete (cross-contract regression & handoff).
> **CR-BE-MOB-01 is COMPLETE — this matrix is final.**
> FINAL REVIEW (2026-08-20) re-verified all 41 rows and found **no defects**;
> the classification below is unchanged and no MISSING/PARTIAL capability was
> implemented.
> Companion to [`CR-BE-MOB-01-GOVERNANCE.md`](./CR-BE-MOB-01-GOVERNANCE.md).
> **Baseline:** `arena/01a01a9c-asentra-backend` @ `d02c30e` (PR #37 merged).
> **Date:** 2026-08-19

Classification: **EXISTING** | **PARTIAL** | **MISSING** | **NOT_REQUIRED**.
Actions: `NONE` | `PUBLISH_OPENAPI` | `COMPOSE_EXISTING` | `EXTEND_EXISTING` | `DO_NOT_IMPLEMENT`.

Unpublished routes have **no** `operationId`. The path shown is the
registered Express route (prefix `/api/v1`).

Wave numbers are the **existing** frozen owners. This CR does not
renumber them.

---

## Matrix

| ID | Mobile Capability | Existing Backend Domain | Existing API / operationId | Status | Actual Gap | Recommended Backend Action | Owning Existing Wave / Domain | Priority |
|---|---|---|---|---|---|---|---|---|
| HK-01 | Housekeeping — cleaning execution | Daily Cleaning is a **read view** of BE-07 `generated_tasks` bound to a Cleaning Area (BE-11A/B). Writes are the shared task-execution engine. | `listBuildingDailyCleaning`, `getDailyCleaning`, `listCleaningAreaDailyCleaning`, `assignDailyCleaning`, `listDailyCleaningAssignments`, `listWorkforceDailyCleaning`, `listTeamDailyCleaning`, plus `startTask` / `completeTask` / `cancelTask` / `listMobileAssignments`. | **EXISTING** | Published in PART 01. Execute remains BE-07 task ops (`id` = `taskId`). Optional `HOUSEKEEPING` discriminator on the mobile feed is still out of scope (P2). | `NONE`. Optional later `COMPOSE_EXISTING` discriminator only if mobile cannot key off schedule/target. | BE-11C/D + BE-07 Task Execution + BE-25C | — |
| HK-02 | Housekeeping — inspection lifecycle | Toilet inspection binding (BE-11E) and public-area inspection binding (BE-11F) start a shared BE-07 checklist execution. Complete/cancel stay on checklist. | `list/create/get/updateToiletInspectionBinding`, `startToiletInspectionExecution`, `getToiletInspectionExecution`, plus the public-area equivalents; complete via `completeChecklistExecution` / `getMobileChecklistExecution`. | **EXISTING** | Published in PART 01. Complete/pass stay on checklist — no HK complete endpoint added. | `NONE`. | BE-11E/F + BE-07 Checklist | — |
| HK-03 | Housekeeping — pass / fail verification | Quality audit (BE-11K) `PASS`/`FAIL`/`REWORK_REQUIRED`. Supervisor inspection (BE-11G) `APPROVED`/`REJECTED`/`REWORK_REQUIRED` via BE-07 reviews. | `list/create/getSupervisorInspection`, `submitSupervisorInspectionDecision`, `list/create/get/updateQualityAudit`, `completeQualityAudit`, plus existing `getMobileVerification` / finding review ops. | **EXISTING** | Published in PART 01. `/mobile/verification` still does not accept HK target types — not required; use the published HK routes. | `NONE`. | BE-11G/K + BE-07 Reviews | — |
| HK-04 | Housekeeping — reinspection | None. After fail/rework the existing path is: start a **new** checklist execution on the same binding + BE-09 finding rework (`requestFindingRework`, `resubmitFinding`). | Published: `startChecklistExecution` / binding start (unpublished) + `requestFindingRework`, `resubmitFinding`, `getFindingRework`. No `reinspect` route. | **NOT_REQUIRED** | Mobile may have simulated a reinspection id/lifecycle. That must not become a backend domain. | `DO_NOT_IMPLEMENT`. Document reuse of bind+start + BE-09 rework. | BE-07 Checklist + BE-09 Finding Rework | — |
| HK-05 | Housekeeping — consumable / material **readiness** | BE-11J consumable requirements + daily readiness. BE-16J item/warehouse bindings; readiness derived from authoritative stock. | Unpublished: `POST/GET/PATCH /housekeeping/consumable-requirements`, readiness record routes, `POST /housekeeping/consumable-requirements/{id}/bindings`, `GET /buildings/{buildingId}/housekeeping-consumable-bindings`, related list/get. | **PARTIAL** | Readiness/binding capability exists; contract unpublished. Mobile cannot show authoritative READY/LOW/NOT_READY from OpenAPI. | `PUBLISH_OPENAPI` for BE-11J + BE-16J reads (and existing write for recording a check). | BE-11J Consumable Readiness + BE-16J HK Consumable Binding | P1 |
| HK-06 | Housekeeping — field consumable **usage** / stock-out | No HK usage table. Authoritative consumption is BE-16I Work Order material usage (`recordWorkOrderMaterialUsage`) + stock-out movements. | Published: `recordWorkOrderMaterialUsage`, `listWorkOrderMaterialUsages`, `getWorkOrderMaterialUsage`, stock movement/balance ops. | **NOT_REQUIRED** | A housekeeping-specific usage engine would duplicate BE-16. If a clean job must consume stock, attach it to a Work Order or post a stock-out with an existing source — do not add `housekeeping_material_usages`. | `DO_NOT_IMPLEMENT` a HK usage domain. If product later requires job-level consumption, `EXTEND_EXISTING` BE-16 stock-out source — separate CR, not this mobile CR’s default. | BE-16 Inventory / BE-16I WO Material Usage | — |
| HK-07 | Housekeeping — finding | BE-11H binds HK sources to a BE-09 Finding (lifecycle stays BE-09). | `listHousekeepingFindings`, `createHousekeepingFinding`, `getHousekeepingFinding`, plus published finding/rework ops on `findingId`. | **EXISTING** | Published in PART 01. Path `{id}` is the HK link id; workflow uses `findingId`. | `NONE`. | BE-11H + BE-09 Findings | — |
| HK-08 | Housekeeping — rework | Shared BE-09 finding rework (also vendor-rework, out of mobile HK scope). | `getFindingRework`, `requestFindingRework`, `updateFindingReworkNotes`, `rejectFinding`, `resubmitFinding`. | **EXISTING** | None for the rework authority. | `NONE`. Mobile binds to published finding rework. | BE-09 Finding Rework | — |
| HK-09 | Housekeeping — evidence on HK source | BE-11I is a binding over BE-07 evidence. | `listHousekeepingEvidenceRequirements`, `listHousekeepingEvidence`, `submitHousekeepingEvidence`, plus `uploadMobileEvidence` / file APIs. | **EXISTING** | Published in PART 01. Bytes stay on the existing file upload endpoints. | `NONE`. | BE-11I + BE-07 Evidence + BE-25E | — |
| SEC-01 | Security — patrol execution | BE-12D operational view of a BE-07 generated task bound to a BE-12B route via BE-12C schedule binding. | `listBuildingPatrolExecutions`, `getPatrolExecution`, `startPatrolExecution`, plus route/post context `listBuildingPatrolRoutes`, `getPatrolRoute`, `listBuildingSecurityPosts`, `getSecurityPost`. | **EXISTING** | Published in PART 02. `id` = BE-07 `taskId`; start still delegates to the shared task engine. Assignment is the published BE-07 `assignTask` on the same id. | `NONE`. | BE-12D Patrol Execution + BE-07 Task | — |
| SEC-02 | Security — checkpoint confirmation | `patrol_point_visits` written by the visit endpoint. Point = sequenced BE-04 location refs on the route. | `recordPatrolPointVisit`, `listPatrolPointVisits`, `updatePatrolPointVisit`, plus checkpoint definition `addPatrolRoutePoint`, `listPatrolRoutePoints`, `updatePatrolRoutePoint`. | **EXISTING** | Published in PART 02. Confirmation is by canonical `pointId` — still **not** QR-based (see QR-04, unchanged **MISSING**). | `NONE`. No checkpoint master was created. | BE-12D + BE-12B Patrol Route Points | — |
| SEC-03 | Security — patrol completion | Applies checkpoint-progress rules, then completes the underlying BE-07 task. | `completePatrolExecution`. | **EXISTING** | Published in PART 02. Mobile must call this rather than the blunt `completeTask`, which bypasses the patrol checks. | `NONE`. | BE-12D + BE-07 Task Execution | — |
| SEC-04 | Security — occurrence (distinct type) | No occurrence entity. | — | **NOT_REQUIRED** | Mobile simulation of “occurrence” must not become a table or `/occurrences` API. | `DO_NOT_IMPLEMENT`. Map UI to SEC-05. | — | — |
| SEC-05 | Security — incident / field reporting | BE-21A Incident foundation; BE-21B Operational Incident (`SECURITY` category, `availableActions`); BE-12H Security Finding (patrol/checklist/daily-activity/handover/post); BE-12F daily-activity read model. | `createIncident`, `listIncidents`, `getIncident`, `updateIncident`, `cancelIncident`, `createOperationalIncident`, `listOperationalIncidents`, `getOperationalIncident`, `updateOperationalIncident`, `createSecurityFinding`, `listSecurityFindings`, `getSecurityFinding`, `getSecurityDailyActivity`. | **EXISTING** | Published in PART 02. Routing rule contracted: patrol/checklist issue → Security finding (BE-09 workflow on `findingId`); standalone event → Operational Incident. No third authority. | `NONE`. BE-12I readiness, BE-12M reporting datasets, keys / lost-found / visitor bindings / shift handovers and BE-21K closure stay unpublished (not mobile field execution). | BE-21A/B + BE-12H/F (+ BE-09 once linked) | — |
| ENG-01 | Engineering — PM/CM field execution | Work Order execution (BE-08 actions). `workType` is a data-driven code, not a PM/CM enum. BE-10G maintenance binding **links** asset to schedule, task, or WO and does not execute; BE-10F breakdown links a corrective WO. | Published: `acknowledgeWorkOrder` … `completeWorkOrder`, `listMobileAssignments`, `startTask`/`completeTask`/`assignTask`, plus PART 03 `create/list/get/updateMaintenanceBinding`, `linkMaintenanceSchedule`, `linkMaintenanceTask`, `linkMaintenanceWorkOrder`, `createBreakdown`, `listAsset/BuildingBreakdowns`, `getBreakdown`, `closeBreakdown`, `linkBreakdownCorrectiveWorkOrder`. | **EXISTING** | Published in PART 03. The binding/context gap is closed; execution deliberately remains the BE-08/BE-07 surface — no second execution path was added. | `NONE`. | BE-08 Work Order + BE-07 Task + BE-10F/G | — |
| ENG-02 | Engineering — diagnosis / test (separate) | None. Capture is inspection / meter / log / checklist / form. | — | **NOT_REQUIRED** | A diagnosis or test-result domain would duplicate BE-07 forms/checklists and BE-10 bindings. | `DO_NOT_IMPLEMENT`. | BE-07 Form/Checklist + BE-10B–E | — |
| ENG-03 | Engineering — technical readings / inspection / log / checklist | BE-10B equipment inspection, BE-10C meter reading (numeric BE-07 form field + UOM + range → `form_responses`), BE-10D log sheet, BE-10E engineering checklist. | Published (PART 03): inspection `create/list(Asset,Building)/get/update`, `startInspectionExecution`, `getInspectionExecutionContext`; meter `…Binding*`, `startMeterReadingExecution`, `submitMeterReading`, `getMeterReadingContext`; log sheet `…Binding*`, `startLogSheetExecution`, `listLogSheetExecutions`, `getLogSheetExecutionContext`; checklist `…Binding*`, `startEngineeringChecklistExecution`, `getEngineeringChecklistExecutionContext`. | **EXISTING** | Published in PART 03. Writes stay on the bindings + BE-07 stores; no second measurement engine. | `NONE`. | BE-10B/C/D/E + BE-07 Form/Checklist/UOM | — |
| ENG-04 | Engineering — supervisor review | BE-25J mobile verification (checklist/form/finding) + BE-08I WO verification + BE-07 reviews. PART 03 additionally publishes the Engineering supervisor **records**: BE-10A daily operations, BE-10K overview, BE-10J shift handover. | Published: `getMobileVerification`, `submitMobileVerification`, `getWorkOrderVerification`, `submitWorkOrderVerification`, `listReviews`, plus PART 03 `getEngineeringDailyOperations`, `getEngineeringOverview`, `create/list/get/updateEngineeringShiftHandover`, `markEngineeringShiftHandoverReady`, `acknowledgeEngineeringShiftHandover`. Unpublished: `GET/POST /utility/abnormal-consumptions/{id}/verification` (BE-18K). | **PARTIAL** | Review authority and Engineering supervisor records are contracted. Remaining: `WORK_ORDER` is not a `/mobile/verification` target (convenience only) and BE-18K abnormal-utility verification is unpublished. | Prefer `NONE` + published targets. Optional `COMPOSE_EXISTING` `WORK_ORDER` on BE-25J (WO-03). Publish BE-18K only if mobile reviews abnormal utility. | BE-25J + BE-08I + BE-07 Reviews + BE-10A/J/K (+ BE-18K if needed) | P2 |
| ENG-05 | Engineering — meter / technical reading review | A completed reading is a BE-07 form instance and is reviewed via BE-07 reviews / BE-25J. BE-18K reviews abnormal consumption, not every reading. | Same as ENG-04. | **PARTIAL** | No per-reading review API beyond form/checklist review — and none was created in PART 03. That is sufficient by design. | `DO_NOT_IMPLEMENT` a reading-review domain. Use the ENG-04 path. | BE-07 Reviews + BE-25J + BE-18K | P1 |
| ENG-06 | Engineering — utility / billing meter capture | BE-18 utility meters: reading capture, latest/list reads and reading **evidence** (requirements, validation, submit). A separate billing/tenant authority from the BE-10C technical meter reading. | Unpublished: `POST /utility/meters/{id}/readings`, `GET /utility/meters/{id}/readings`, `GET /utility/meters/{id}/readings/latest`, `GET /utility/meter-readings/{id}`, `GET /buildings/{buildingId}/meter-readings`, `GET/POST /utility/meter-readings/{id}/evidence*`, `GET /buildings/{buildingId}/utility-meters`, `GET /utility/meters/{id}`. | **PARTIAL** | Capability exists and is unpublished. Deliberately NOT published in PART 03: BE-18 is billing-oriented, and publishing it beside BE-10C would create two competing meter-reading contracts for mobile. Documented, not invented and not mapped onto BE-10C. | `PUBLISH_OPENAPI` in a later PART/CR **after** the product decides which meter authority mobile reads. Do not merge the two authorities. | BE-18 Utility Meter + BE-07 Evidence | P1 |
| WO-01 | Work Order — material usage | BE-16I usage + stock-out + cost snapshot (CR-BE-MAT-01). | `recordWorkOrderMaterialUsage`, `listWorkOrderMaterialUsages`, `getWorkOrderMaterialUsage`, `getWorkOrderMaterialCostSummary`, building/client list ops. | **EXISTING** | None for the usage authority. | `NONE`. | BE-16I + CR-BE-MAT-01 | — |
| WO-02 | Work Order — item / warehouse / material context | BE-16A item master, BE-16B warehouse master, BE-16H Asset ↔ SPARE_PART binding, BE-07 UOM. Usage embeds `itemId`/`warehouseId`/`uomId` snapshots. | Published: `listUoms`, `getUom`, `listWarehouseStockBalances`, `getStockBalance`, plus PART 04 `listClientInventoryItems`, `getInventoryItem`, `listBuildingWarehouses`, `listClientWarehouses`, `getWarehouse`, `listAssetSpareParts`, `listInventoryItemAssetBindings`, `getAssetSparePart`. | **EXISTING** | Published in PART 04 (reads only). The field picker can now list items, warehouses and an asset's expected spare parts from the contract. | `NONE`. Master-data writes stay unpublished (WO-05). | BE-16A/B/H + BE-07 UOM + BE-16 stock | — |
| WO-03 | Work Order — supervisor verification | BE-08I verification/rework/close via the BE-07 review primitive (`target_type = WORK_ORDER`). | Published: `getWorkOrderVerification`, `submitWorkOrderVerification`, `closeWorkOrderAfterCanonicalBastReadiness`, plus the supervisor context `getWorkOrderCompletion`, `getWorkOrderHistory`, `listWorkOrderEvidence`, `listWorkOrderEvidenceRequirements`, `listReviews`. | **EXISTING** | None. PART 04 documented the composition and pinned it by test; nothing was re-published. | `NONE`. | BE-08I + BE-07 Reviews | — |
| WO-04 | Work Order — `WORK_ORDER` target on `/mobile/verification` | BE-25J composition. `MOBILE_VERIFICATION_TARGET_TYPES` = CHECKLIST_EXECUTION / FORM_INSTANCE / FINDING. | Published: `getMobileVerification`, `submitMobileVerification` (three targets only). | **MISSING** | Adding WORK_ORDER is a **runtime** change (new target type), forbidden by PART 04's rules. Not invented, not advertised: a PART 04 test asserts the documented enum equals the implemented constant. Mobile supervisors use the published Work Order verification endpoints instead. | Optional later `COMPOSE_EXISTING` in a PART that is allowed to change runtime — must not alter BE-08I rules. | BE-25J + BE-08I | P2 |
| WO-05 | Work Order — material master administration | BE-16A/B/H write routes (create item / warehouse / spare-part binding, patch, patch status). | Unpublished: `POST /clients/{clientId}/inventory-items`, `PATCH /inventory-items/{id}`, `PATCH /inventory-items/{id}/status`, `POST /buildings/{buildingId}/warehouses`, `PATCH /warehouses/{id}`, `PATCH /warehouses/{id}/status`, `POST /assets/{assetId}/spare-parts`, `PATCH /asset-spare-parts/{id}`. | **PARTIAL** | Capability exists and is deliberately unpublished — master-data administration is not mobile field execution. Pinned in `mobile-material-context-contract.test.ts` so the exclusion is explicit and cannot rot. | `PUBLISH_OPENAPI` only if an admin/web contract needs it; not required for mobile. | BE-16A/B/H | P2 |
| QR-01 | QR — asset | BE-05H asset identifiers (opaque `identifier_value`, types QR/TAG/BARCODE/LEGACY) + BE-25F composition. | `resolveMobileQr`, `resolveAssetByIdentifier`, `getAsset`, `getAssetLocation`, `getEquipmentProfile`, `listAssetIdentifiers`. | **EXISTING** | Unchanged and preserved by PART 05. The ASSET-only boundary is now machine-readable (`x-qr-supported-target-types`) and pinned to `MOBILE_QR_TARGET_TYPES` by test. | `NONE`. | BE-25F + BE-05H | — |
| QR-02 | QR — location (floor / area / room / space) | BE-04 structure. `code` is unique per parent but there is **no** location identifier registry and no resolve-by-code route. | Published canonical-id reads: `getBuildingHierarchy`, `listBuildingFloors`, `getFloor`, `listFloorAreas`, `getArea`, `listAreaRooms`, `getRoom`, `listRoomSpaces`, `getSpace`. No scan resolution. | **MISSING** | PART 05 froze the payload convention: the QR payload is an OPAQUE BE-05H identifier value, and that registry is asset-scoped. An opaque location label therefore has no authority; a canonical UUID needs no resolver. Documented in `x-qr-target-type-boundary`, never mapped onto ASSET. | Later, in order: (1) product decision opaque-vs-canonical; (2) a location identifier authority (BE-05H pattern); (3) only then `EXTEND_EXISTING` `MOBILE_QR_TARGET_TYPES`. Do not add `/mobile/qr/location`. GPS/geofence = `DO_NOT_IMPLEMENT`. | BE-25F + BE-04 Structure | P2 |
| QR-03 | QR — functional location | BE-04 functional locations + context projection. No FL identifier registry. | Published canonical-id reads: `getFunctionalLocation`, `getFunctionalLocationContext`, `listBuildingFunctionalLocations`. No scan resolution. | **MISSING** | Same fork as QR-02; recorded in the PART 05 boundary with its published fallbacks. | Same as QR-02. Extend BE-25F only over a real FL identifier authority; do not create an FL-QR module. | BE-25F + BE-04 Functional Locations | P2 |
| QR-04 | QR — checkpoint | BE-12B patrol route points: canonical UUID + sequence + location FKs, no identifier value. | Published: `listPatrolRoutePoints`, `getPatrolExecution`, `listPatrolPointVisits`, and confirmation by canonical `pointId` via `recordPatrolPointVisit` (PART 02). No scan resolution. | **MISSING** | Scan-to-confirm remains unimplemented; confirm-by-`pointId` is EXISTING since PART 02. Recorded in the PART 05 boundary. | Add checkpoint as a `resolveMobileQr` target **only** if `patrol_route_points` gain identifiers. Do not create a checkpoint-QR domain. | BE-25F + BE-12B Points + BE-12D Visit | P1 |
| QR-05 | QR — Work Order scan | BE-08 Work Orders carry a human-readable `workOrderNumber`, but no identifier registry and no resolve-by-number route. | Published canonical-id reads: `listMobileAssignments`, `getWorkOrder`, `listBuildingWorkOrders`. No scan resolution. | **MISSING** | Mobile reaches a Work Order through its assignment feed or canonical id. Recorded in the PART 05 boundary rather than mapped onto ASSET or guessed from a number. | Same three-step precondition as QR-02. A `workOrderNumber` lookup would be a new resolver behaviour — out of scope. | BE-25F + BE-08 Work Order | P2 |
| QR-06 | QR — GPS / geofenced scan | None. The resolver stores and reads no coordinate. | — | **NOT_REQUIRED** | Location proof must not become a backend authority in this CR. A PART 05 test asserts no GPS/geofence field exists in any `MobileQr*` schema or in the resolver source. | `DO_NOT_IMPLEMENT`. | — | — |
| SYN-01 | Offline sync — supported resource kinds | BE-25G batch over shared services. | `processSyncBatch`. Kinds: `TASK_EXECUTION` (`START`/`COMPLETE`/`CANCEL`), `CHECKLIST_RESPONSES` (`SAVE`), `EVIDENCE_SUBMISSION` (`SUBMIT`), `TASK_ASSIGNMENT` (`UPDATE`), plus PART 06 `PATROL_EXECUTION` (`START`/`COMPLETE`), `PATROL_POINT_VISIT` (`SUBMIT`), `METER_READING` (`SUBMIT`). | **EXISTING** | Seven kinds. The original four are byte-for-byte unchanged (asserted by test). | `NONE`. | BE-25G (+ BE-12D, BE-10C) | — |
| SYN-02 | Offline sync — authoritative IDs | Client `operationId` (1–128) bound to user + resourceType + resourceId + operation in `mobile_sync_idempotency`. Domain ids remain the resource ids. | `processSyncBatch` (`operationId`, `resourceId`). | **EXISTING** | None for supported kinds. Extended kinds must reuse the same id rules. | `NONE`. Future kinds: `EXTEND_EXISTING` only — no new id scheme. | BE-25H | — |
| SYN-03 | Offline sync — conflict / retry | BE-25I `data.baseVersion` vs resource `updatedAt` → `SYNC_CONFLICT` + `error.conflict.current` + reload guidance. Replay of same `operationId` does not re-execute. Failed writes need a **new** operationId. | `processSyncBatch` + BE-25K `error.conflict`. | **EXISTING** | None for supported kinds. Evidence create has no pre-row conflict (idempotency only). | `NONE`. Apply the same rules to any new kind. | BE-25I + BE-25K | — |
| SYN-04 | Offline sync — operational kinds beyond the four | Same BE-25G dispatcher, extended in PART 06 over already-published writes. | Added: `PATROL_EXECUTION` → `startPatrolExecution`/`completePatrolExecution`; `PATROL_POINT_VISIT` → `recordPatrolPointVisit`; `METER_READING` → `submitMeterReading`. Still unsupported and documented on the operation (`x-sync-unsupported-resource-types`): `WORK_ORDER_ACTION`, `WORK_ORDER_MATERIAL_USAGE`, `INCIDENT`, `SECURITY_FINDING`, `SUPERVISOR_DECISION`, `EVIDENCE_BYTES`. | **PARTIAL** | Patrol execute/visit and meter reading are syncable. WO actions need envelope verbs the contract does not have; WO material usage is a stock-ledger write with no reservation concept; incident and finding creates have no prior authoritative `resourceId` (client-supplied unique number); supervisor decisions must not be queued against unseen state. Each is documented with a reason and the online operation to use — none is advertised as syncable. | `EXTEND_EXISTING` further only after the specific blocker is resolved (envelope verbs / reservation decision / create-id convention). Never a catch-all kind. | BE-25G over BE-12D / BE-10C (+ BE-08, BE-16I, BE-21 later) | P1 |
| SYN-05 | Offline evidence byte queue | Bytes stay on `uploadMobileEvidence` / evidence file API. | `uploadMobileEvidence`, `uploadEvidenceFile`. Sync carries metadata only. | **NOT_REQUIRED** | Backend must not store an offline byte queue. | `DO_NOT_IMPLEMENT`. | BE-25E + BE-25G | — |
| NTF-01 | Mobile notification — push token registration | BE-25L `mobile_push_tokens` (user + device, rotate, deactivate; migration 0235). | `registerPushToken`, `listPushTokens`, `deactivatePushToken`. | **EXISTING** | None for registration. PART 07 makes explicit that registration is **not** delivery: it creates no notification, no attempt and no provider send, and the schema exposes no delivery outcome field. | `NONE`. | BE-25L | — |
| NTF-02 | Mobile notification — in-app delivery / inbox | BE-26A records from BE-26D subscriptions + BE-26B templates + BE-26C recipient resolution; BE-26E in-app delivery; BE-26K history. | `listNotifications`, `getNotification`, `markNotificationRead`, `listNotificationHistory`, `getNotificationHistoryItem`. | **EXISTING** | This is the authoritative mobile delivery path today. Record channel enum is `IN_APP` only; history channels are `IN_APP`/`EMAIL`/`WHATSAPP`. | `NONE`. | BE-26A/E/K | — |
| NTF-03 | Mobile notification — push **delivery** contract | No push delivery attempt record, no PUSH history channel, no adapter, no token fan-out. Email/WhatsApp attempt tables + adapters exist; push has neither. | Token ops only (NTF-01). No `deliverPush`, no PUSH channel, no push route. | **MISSING** | Confirmed by review, not assumed. Split into stage 3 (delivery attempt — PARTIAL overall, PUSH missing) and stage 4 (provider delivery — MISSING), published machine-readably as `x-push-delivery-lifecycle` on `registerPushToken`. A missing push is invisible to the backend because no attempt row exists — hence MISSING, not degraded. | A later CR that is ALLOWED to add schema: (1) push delivery attempt table + migration mirroring `email_deliveries`; (2) adapter with the existing no-op/logging default; (3) `PUSH` in `NOTIFICATION_HISTORY_CHANNELS` + fan-out over ACTIVE tokens; (4) then the OpenAPI enums. Never `/mobile/push-send` as a separate domain. | BE-26 (+ BE-25L tokens) | P1 |
| NTF-04 | Mobile notification — push **provider** integration | None. Repo-wide search finds no `sendPush`/`deliverPush`/`pushAdapter`/FCM/APNS/Firebase/OneSignal, no vendor dependency, and no push migration beyond the BE-25L token table. | — | **MISSING** | Distinct from NTF-03: even with an attempt record there is no vendor transport. Recorded separately so "we have tokens" is never mistaken for "we can send". A PART 07 test fails if a provider SDK, dependency or send route appears. | Separate CR together with NTF-03 step 2. Do not add a vendor before the attempt record exists. | BE-26 (+ BE-25L tokens) | P1 |
| NTF-05 | Mobile notification — client-simulated / browser push | None, by design. | — | **NOT_REQUIRED** | A locally raised banner must never be reported as backend delivery, and the backend must never fabricate a delivery success. Mobile uses the IN_APP inbox (NTF-02) until NTF-03/04 land. | `DO_NOT_IMPLEMENT`. | — | — |

---

## Summary counts

| Status | Rows |
|---|---:|
| EXISTING | 21 |
| PARTIAL | 6 |
| MISSING | 7 |
| NOT_REQUIRED | 7 |
| **Total** | **41** |

PART 01 flipped HK-01, HK-02, HK-03, HK-07, HK-09 from PARTIAL → EXISTING
(OpenAPI publish only). HK-05 consumable readiness remains PARTIAL.

PART 02 flipped SEC-01, SEC-02, SEC-03, SEC-05 from PARTIAL → EXISTING
(OpenAPI publish only). SEC-04 stays NOT_REQUIRED — no occurrence domain was
created — and QR-04 stays MISSING: no checkpoint identifier authority exists,
so checkpoint confirmation is by canonical `pointId`. Security evidence has no
Security-specific route; it is documented reuse of the BE-07 evidence
operations on the checklist execution or BE-09 finding, and is therefore
recorded as **PARTIAL** (reuse path) rather than invented.

PART 03 flipped ENG-01 and ENG-03 from PARTIAL → EXISTING (OpenAPI publish
only) and published the Engineering supervisor records (BE-10A/J/K) behind
ENG-04. ENG-02 stays NOT_REQUIRED — no diagnosis/test-result domain was
created — and ENG-05 stays PARTIAL by design: no per-reading review engine
exists or was added. Engineering **evidence** needed no new row: every BE-10
execution id is a BE-07 `CHECKLIST_EXECUTION` / `FORM_INSTANCE`, which the
already-published evidence operations accept. A new row **ENG-06** records the
BE-18 utility/billing meter capture surface as PARTIAL — it exists, is
unpublished, and was deliberately left unpublished rather than mapped onto the
BE-10C technical meter authority.

PART 04 flipped WO-02 from PARTIAL → EXISTING by publishing the BE-16A/B/H
reference **reads**. WO-01 and WO-03 were already EXISTING and were documented
as composition rather than re-published. Two new rows record the honest
boundaries: **WO-04** (`WORK_ORDER` on `/mobile/verification`) is **MISSING** —
it needs a runtime change, so it was documented instead of invented, and a test
pins the documented target enum to the implemented constant — and **WO-05**
(material master administration writes) is **PARTIAL**: it exists, is not
mobile field execution, and is pinned as deliberately unpublished.

PART 05 flipped nothing — and that is the finding. The review confirmed a
single scan authority (asset-scoped BE-05H identifiers) and exactly two
resolve-by-value routes in the whole router, so no additional QR target could
be published faithfully. QR-01 stays EXISTING and byte-preserved; QR-02/03/04
stay MISSING with the payload convention now frozen and their canonical-id
fallbacks named; two new rows record the remaining honest boundaries —
**QR-05** (Work Order scan) MISSING and **QR-06** (GPS / geofenced scan)
NOT_REQUIRED. The boundary is machine-readable on the operation
(`x-qr-supported-target-types`, `x-qr-target-type-boundary`) and a test pins it
to the implemented `MOBILE_QR_TARGET_TYPES` constant, so an unsupported target
cannot be advertised.

PART 06 moved SYN-04 from MISSING → PARTIAL — the CR's first runtime change.
Three kinds were added to the existing BE-25G dispatcher over writes published
in PART 02/03 (`PATROL_EXECUTION`, `PATROL_POINT_VISIT`, `METER_READING`), each
delegating to the same service its published REST operation calls, with the
same permission, the same Building scope, an authoritative `resourceId`, and no
new operation verb. Six candidate kinds were evaluated and rejected with
reasons and are published as explicitly unsupported, so an offline record with
no authoritative backend write stays local. SYN-01/02/03 remain EXISTING with
their BE-25H/BE-25I guarantees intact; SYN-05 remains NOT_REQUIRED.

PART 07 flipped nothing, and that is again the finding. BE-26 delivers IN_APP,
EMAIL and WHATSAPP; it has no push delivery attempt record, no adapter, no
provider and no token fan-out, and building one needs a table + migration this
PART forbids. NTF-03 therefore stays MISSING, now split into the four
explicitly separated stages (token registration EXISTING, notification creation
EXISTING, delivery attempt PARTIAL with PUSH missing, provider delivery
MISSING) published as `x-push-delivery-lifecycle`. Two new rows separate the
remaining concerns: **NTF-04** (push provider integration) MISSING and
**NTF-05** (client-simulated push) NOT_REQUIRED. Tests pin every documented
channel enum to its implemented constant and fail if a push route, module,
migration or vendor dependency appears.

PART 08 changed no classification. It re-validated PART 01–07 together
(`tests/mobile-cr-regression-contract.test.ts`) and found one real
inconsistency: the `x-required-permission` / `x-building-scoped` convention
started in PART 02 had never been applied to the PART 01 Housekeeping surface.
Rather than weaken the assertion, all 34 Housekeeping operations were annotated
with the permission their BE-11 router already enforces, so **137/137**
CR-published operations now carry both annotations — and the suite additionally
proves every documented permission exists in the seeded catalogue. Final
counts: 21 EXISTING, 6 PARTIAL, 7 MISSING, 7 NOT_REQUIRED.

ENG-01 is **PARTIAL** because the unpublished maintenance/breakdown
binding is the remaining gap; WO execution itself is already
contracted. WO-03 is **EXISTING** because BE-08I is published;
`WORK_ORDER` on `/mobile/verification` is optional composition only.

### Required backend work (later PARTs)

| Class of work | Rows | New domain? |
|---|---|---|
| `PUBLISH_OPENAPI` only | ~~HK-01, HK-02, HK-03, HK-07, HK-09~~ (done, PART 01), ~~SEC-01, SEC-02, SEC-03, SEC-05~~ (done, PART 02), ~~ENG-01 (bindings), ENG-03~~ (done, PART 03), ~~WO-02~~ (done, PART 04), HK-05, ENG-06, WO-05 | No |
| Optional `COMPOSE_EXISTING` | HK-01 discriminator, HK-03 queue, WO-03 `WORK_ORDER` target | No |
| `EXTEND_EXISTING` | QR-02/03/04/05 (only after an identifier authority is approved — see PART 05), ~~SYN-04~~ (done in part, PART 06 — remaining kinds blocked on envelope verbs / reservation / create-id decisions), NTF-03 + NTF-04 (blocked on a CR allowed to add a delivery table + adapter — see PART 07) | No |
| `DO_NOT_IMPLEMENT` | HK-04, HK-06, SEC-04, ENG-02, SYN-05, plus GPS / session-refresh already frozen | — |
| `NONE` | HK-08, WO-01, QR-01, SYN-01, SYN-02, SYN-03, NTF-01, NTF-02 | — |

**No new mobile operational domain is required.**

---

## Mapping to proposed PARTs

| PART | Matrix rows |
|---|---|
| PART 01 — Housekeeping contract publish ✅ **DONE** | HK-01, HK-02, HK-03, HK-05, HK-07, HK-09 (HK-04/HK-06 documented as out) |
| PART 02 — Security patrol & field-incident publish ✅ **DONE** | SEC-01, SEC-02, SEC-03, SEC-05 published (SEC-04 documented as out; QR-04 unchanged) |
| PART 03 — Engineering field / reading publish ✅ **DONE** | ENG-01 bindings, ENG-03, ENG-04 supervisor records published; ENG-05 reuse documented; ENG-02 out; ENG-06 recorded as deferred |
| PART 04 — WO material context + verification composition ✅ **DONE** | WO-02 published; WO-01/WO-03 documented as already-composed; WO-04 recorded MISSING; WO-05 recorded as deliberately unpublished |
| PART 05 — QR operational-context boundary ✅ **DONE** | QR-02/03/04 confirmed MISSING with frozen payload convention + published fallbacks; QR-05 and QR-06 added; QR-01 preserved unchanged |
| PART 06 — Sync resource-kind extension ✅ **DONE** | SYN-04 partially closed (3 kinds added, 6 documented unsupported); SYN-01–03/05 unchanged |
| PART 07 — Push delivery contract ✅ **DONE** | NTF-03 confirmed MISSING with the four stages published; NTF-04 and NTF-05 added; NTF-01/02 unchanged |
| PART 08 — Regression & handoff ✅ **DONE** | all 41 rows re-validated together; Housekeeping RBAC/scope annotations aligned; handoff published |

---

## Final three-way split (PART 08)

**1. Ready for mobile integration (EXISTING, 21).** HK-01, HK-02, HK-03,
HK-07, HK-08, HK-09, SEC-01, SEC-02, SEC-03, SEC-05, ENG-01, ENG-03, WO-01,
WO-02, WO-03, QR-01, SYN-01, SYN-02, SYN-03, NTF-01, NTF-02.

**2. Requires a future backend CR (MISSING 7 + the PARTIAL limits 6).**

| Row | Status | Precondition |
|---|---|---|
| QR-02, QR-03, QR-04, QR-05 | MISSING | An identifier authority for that domain, then `EXTEND_EXISTING` on `MOBILE_QR_TARGET_TYPES` |
| WO-04 | MISSING | A PART allowed to change runtime; must not alter BE-08I rules |
| NTF-03, NTF-04 | MISSING | A CR allowed to add a push delivery table + migration and a provider adapter |
| HK-05 | PARTIAL | Publish BE-11J/BE-16J readiness reads |
| ENG-04, ENG-05 | PARTIAL | Optional `WORK_ORDER` verification composition / BE-18K abnormal review; no per-reading review engine |
| ENG-06 | PARTIAL | Product decision on which meter authority mobile reads (BE-10C vs BE-18) |
| WO-05 | PARTIAL | Only if an admin/web contract needs the master-data writes |
| SYN-04 | PARTIAL | Envelope verbs / reservation decision / create-id convention |

**3. Intentionally not required (NOT_REQUIRED, 7).** HK-04 reinspection
domain, HK-06 HK stock-usage engine, SEC-04 occurrence domain, ENG-02
diagnosis / test-result domain, QR-06 GPS / geofenced scan, SYN-05 offline
evidence-byte queue, NTF-05 client-simulated push. Mobile must not implement a
backend-shaped substitute for any of these.

Binding guide: [`api/CR_BE_MOB_01_MOBILE_HANDOFF.md`](./api/CR_BE_MOB_01_MOBILE_HANDOFF.md).

---

## Validation

Classification document. Route/schema/behaviour changes: **none** in any
PART so far — PART 01 and PART 02 are OpenAPI publish only. Authoritative
narrative: [`CR-BE-MOB-01-GOVERNANCE.md`](./CR-BE-MOB-01-GOVERNANCE.md)
(§13 PART 01, §14 PART 02, §15 PART 03, §16 PART 04, §17 PART 05,
§18 PART 06, §19 PART 07, §20 PART 08).

STOP.
