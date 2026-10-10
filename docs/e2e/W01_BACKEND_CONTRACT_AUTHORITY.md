# W01 PART 01 — Backend Contract & Authority Reconciliation

**Status: AUDIT ONLY (PART 01) + BASELINE RUNTIME & PERSONA AUTHORITY CONTRACT (PART 02, §13) — tidak ada perubahan business logic, schema DB, atau API.**
**Update PART 02:** lihat §13. Runtime baseline: typecheck PASS; subset 25 file 200/212 pass (12 fail, diklasifikasikan di §13.3). E2E tetap belum complete.
**Tanggal:** 2026-10-10
**Repository:** `budiirmawan/Handyman-Backend`
**Branch:** `arena/c6fc25e1-handyman-backend` (tidak ada branch baru)
**HEAD saat audit:** `9602991c7d820a7a51257dad036bd6051b4161b2` (`Merge pull request #18 ...`), sama dengan `origin/arena/c6fc25e1-handyman-backend` lokal sebelum commit dokumen ini.

> **E2E belum complete.** Dokumen ini adalah pemetaan kontrak statis (static contract mapping) berbasis pembacaan kode, route, dan grep. **Tidak ada runtime evidence** pada PART 01: test suite tidak dijalankan, dependency tidak di-install, dan tidak ada request HTTP ke server. Status `EXISTING` berarti "kode dan route ada", bukan "terbukti berjalan end-to-end".

---

## 0. Baseline dan pengungkapan sumber

| Item | Temuan |
|---|---|
| "Business Journey Lifecycle v1.3 FROZEN" | **Tidak ditemukan** di repository (pencarian `Business Journey` dan `v1.3` di seluruh tree tidak menghasilkan dokumen baseline). |
| Sumber lifecycle yang dipakai | `docs/HANDYMAN_JOURNEY_LIFECYCLE.json` (version `1.0`, 30 tahap, 9 persona) + `docs/HANDYMAN_PRODUCT_BASELINE.md` + `docs/handyman/CR-HM-00_BACKEND_CAPABILITY_MAP.md` (status FROZEN, 37/37 covered, GAP 0 pada level *mapping*, bukan implementasi). |
| Persona yang **tidak** ada di baseline v1.0 | `Handyman Manager`, `Supervisor`, `Finance / Authorized Manager` (hanya ada `ADMIN_FINANCE`). Ketiganya diperlakukan sebagai persona yang harus dikonfirmasi. |
| Sumber CR governance yang dirujuk | `docs/handyman/CR-HM-CARE-WORKSPACE-01_PART01_AUTHORITY_CONTRACT_FREEZE.md`, `docs/handyman/HANDYMAN_CR_CODING_ROADMAP_v1.0.md`, `docs/handyman/CR-HM-00_CROSS_REPO_OWNERSHIP_MATRIX.md` |

**Tindakan:** v1.3 perlu disediakan user (lihat §10, keputusan K0). Pemetaan di bawah memakai tahap lifecycle v1.0 yang namanya sudah sejalan dengan daftar seam W01.

---

## 1. Ringkasan eksekutif

Hitungan dari 72 baris matriks §3 (status utama = kata pertama kolom status; baris "EXISTING (authority PARTIAL)" dihitung EXISTING, dan catatan authority dibaca di kolom Catatan):

| Status | Jumlah baris |
|---|---|
| EXISTING | 40 |
| PARTIAL | 18 |
| MISSING | 14 |

Temuan inti:

1. **Intake dan representasi Customer Care sudah ada** (workspace admission bertanda tangan, property grant, tenant company/PIC, occupancy, space/unit, channel attribution `BM_SUPER_APP`). Ini adalah bagian paling matang.
2. **Lifecycle teknis Handyman dari triage sampai BAST accept/reject sudah ada sebagai route dan service**, tetapi **authority-nya belum berbasis persona**. Semua route manajemen memakai `tenant_company.read` / `tenant_company.manage`, dan seed hanya mendefinisikan dua permission itu. Tidak ada seed role `CUSTOMER_CARE`, `DISPATCHER`, `FINANCE`, `SUPERVISOR`, atau `HANDYMAN_MANAGER`.
3. **Customer Care tidak bisa menjalankan langkah lifecycle setelah intake dengan authority-nya sendiri.** Route triage, inspection, diagnosis, referral, quotation, dan decision memakai `authenticationMiddleware`, yang hanya membaca `user_sessions`. Token sesi workspace Customer Care disimpan di tabel lain (`handyman_care_workspace_sessions`) dan hanya diterima route `care-workspace`.
4. **Pembayaran: Customer Care dapat CONFIRM dan REJECT.** `available-actions` menawarkan `CONFIRM` / `REJECT` untuk status `PENDING`. Ini bertentangan dengan baseline, di mana Finance/Authorized Manager memverifikasi. Service `decide()` juga tidak memeriksa bahwa pelapor dan pemverifikasi berbeda.
5. **Tidak ada entitas Work Order, Supervisor QC, Invoice, dan aksi CLOSE.** Status scope eksekusi hanya `AUTHORIZED`. Tidak ada state final. Modul Handyman tidak mengimpor `work-orders`, `permits`, `schedules`, atau `bast-documents`.
6. **Readiness (scheduling, unit access, permit) belum menjadi gate.** Assignment, arrival, dan work session tidak membaca record readiness. Hasil grep hanya berupa komentar.
7. **Beberapa service sudah ditulis tetapi tidak punya pemicu atau route:** BAST `prepare/issue/void`, settlement (6 fungsi), financial entitlement, warranty `start/expire`, ledger corrections, payment allocations, notifications, dan commercial agreement/BM fee (tanpa route HTTP).
8. **Tidak ada bukti runtime.** 150 file dengan prefix `handyman` di `tests/` ada, tetapi tidak dijalankan pada PART ini.

---

## 2. Metode dan legenda

**Metode (ringan, seam-only):**
- Inventaris route: membaca `src/routes/index.ts` dan setiap `*.routes.ts` / `*-api/*.ts` Handyman. Prefix API: `/api/v1` (`src/config/env.ts:99`).
- Pemeriksaan authority: middleware pada setiap `router.<verb>` (`auth`, `read`, `manage`), lalu panggilan `resolveHandymanAssignmentLead`, `assertBuildingScopedResourceAccess`, `canAccessBuildingScopedResource`, dan `canAccessClient` di service.
- Pemeriksaan reachability: impor lintas modul (`from '…/handyman-…'`) dan pemanggilan fungsi export dari luar modul, termasuk test.
- Pemeriksaan kontrak: perbandingan path+method OpenAPI (`docs/api/openapi.yaml`) dengan route literal di kode.
- Keamanan **tidak diaudit ulang**. Temuan keamanan sebelumnya dirujuk ke `docs/handyman/CR-HM-SEC-01_*` dan `docs/reviews/CR-HM-SEC-03_PART04_*`.

**Legenda status:**
- **EXISTING** — route dan service ada, dipakai dari luar modulnya, dan authority-nya sesuai baseline. Belum berarti terbukti runtime.
- **PARTIAL** — ada service atau record, tetapi tidak terhubung ke route, pemicu, atau gate; atau authority tidak sesuai persona baseline.
- **MISSING** — tidak ditemukan kode, state, route, atau persona untuk kapabilitas tersebut.
- **BLOCKER** — kekurangan yang menghentikan E2E W01 sampai diselesaikan (lihat §6).

---

## 3. Matriks implementasi (per seam)

### 3.A Customer Care assisted intake, Tenant/PIC, Tower/Floor/Unit

| ID | Kapabilitas | Status | Bukti (file › fungsi / route) | Catatan / gap |
|---|---|---|---|---|
| A-01 | Admission workspace Customer Care (assertion bertanda tangan, purpose `HANDYMAN_CARE_WORKSPACE`) | EXISTING | `handyman-care-workspace/care-workspace.routes.ts` › `POST /handyman/care/session` (`admitCareWorkspace`, `x-hub-signature-256`); `DELETE /handyman/care/session`; migrasi `0429_create_handyman_care_workspace_sessions.ts`; test `handyman-care-workspace-admission*.test.ts` | Sesi workspace terpisah dari `user_sessions`. Benar sesuai CR-HM-CARE-WORKSPACE-01 PART 01. |
| A-02 | Handoff represented-context (assertion) dan channel attribution | EXISTING | `handyman-handoff/handoff.routes.ts` › `POST /handoff/assertions`, `POST /handoff/channel-attributions`; `handyman-channel-attributions` (origin `BM_SUPER_APP`) | Origin channel hanya `BM_SUPER_APP`. Tidak ada referensi ASENTRA/BM Operations di kode Handyman. |
| A-03 | Scope property Customer Care (ACTIVE grant) | EXISTING | `handyman-care-actors/handyman-care-property-scope.service.ts` (`actorCapability === 'CUSTOMER_CARE'`); `GET /handyman/care/properties`, `GET /handyman/care/properties/:propertyId/buildings` | Grant membatasi discovery; bukan izin bulk. |
| A-04 | Tenant company dan Tenant PIC | EXISTING | `GET /handyman/care/properties/:propertyId/tenant-companies`; `handyman-requests/handyman-service-request.types.ts` (`tenantCompanyId`, `tenantPicId`) | PIC bukan `User` lokal. Sesuai kontrak. |
| A-05 | Occupancy (represented customer aktif) | EXISTING | `GET /handyman/care/properties/:propertyId/occupancies`; `care-workspace-occupancies.repository.ts` (memakai `tenant-building-contexts`) | Tidak ada authority occupancy baru. |
| A-06 | Unit = `spaceId` (room → area → floor → building) | EXISTING | `GET /handyman/care/properties/:propertyId/spaces`; `handyman-service-request.types.ts` (`spaceId`); `handyman-quotations/handyman-execution-scope.service.ts` › `deriveExecutionScopeLocation` (FAIL-CLOSED) | Lokasi dihitung server-side. |
| A-07 | **Tower** sebagai konsep | **PARTIAL** | Pencarian `tower` di `src/modules/handyman-*`: **0 hasil**. Lokasi memakai `buildingId` dan `floor` (24 file menyebut floor). | Perlu keputusan K3: Tower = Building atau level baru. Tidak boleh menambah modul baru tanpa keputusan. |
| A-08 | Floor sebagai bagian lokasi arrival | EXISTING | `handyman-arrival-locations/*`, `handyman-arrival-results/*` (referensi floor) | Floor dipakai sebagai expected location, bukan sebagai entitas lifecycle. |
| A-09 | Intake Customer Care via exchange (care-bound) | EXISTING | `POST /handyman/care/properties/:propertyId/create-exchanges` (workspace); `POST /handyman/requests/care` (`handyman-api.routes.ts`, tanpa `auth` lokal, memakai exchange token) | **Dua jalur create untuk intake yang sama.** Lihat O1 (§7). |
| A-10 | Intake dari user lokal (attribution-bound) | EXISTING | `POST /handyman/requests` (`auth` + `tenant_company.manage`) | Jalur untuk Tenant PIC lokal. |
| A-11 | Lampiran intake (foto/video) | EXISTING | `GET/POST /handyman/requests/:id/intake-evidence`; `handyman-evidence/handyman-intake-evidence.service.ts` (memakai `../evidence/storage` dan `../evidence/evidence-integrity`) | Reuse storage bersama, sesuai roadmap. |
| A-12 | List dan detail request untuk Customer Care | EXISTING | `GET /handyman/care/requests`, `GET /handyman/care/requests/:requestId` (workspace); `GET /handyman/requests`, `GET /handyman/requests/:id` (bearer) | **Dua surface baca.** Lihat O2. |
| A-13 | Status visibility untuk request | EXISTING | `GET /handyman/requests/:id/status-visibility` (`handyman-sla-status-api`) | Tidak ada di surface workspace; lihat O3. |

### 3.B Inspection, diagnosis, quotation, tenant approval

| ID | Kapabilitas | Status | Bukti | Catatan / gap |
|---|---|---|---|---|
| B-01 | Triage (POST/GET) | EXISTING (authority PARTIAL) | `handyman-lifecycle-api.routes.ts` › `/requests/:id/triage`; `handyman-requests/handyman-request-triage.service.ts` (`assertBuildingScopedResourceAccess` baris 129, 223) | Route memakai `tenant_company.manage`, bukan persona. **Customer Care tidak bisa memanggil** (B1). |
| B-02 | Inspection (POST/GET) | EXISTING (authority PARTIAL) | `handyman-lifecycle-api` › `/inspection`; `handyman-request-inspection.service.ts` | Sama dengan B-01. |
| B-03 | Diagnosis dan scope classification | EXISTING (authority PARTIAL) | `handyman-lifecycle-api` › `/diagnosis`; `handyman-request-diagnosis.service.ts` (memakai `handyman-disciplines`) | Klasifikasi disciplines diturunkan server-side. |
| B-04 | Specialist escalation / referral | EXISTING (authority PARTIAL) | `handyman-lifecycle-api` › `/referral`; `handyman-request-referral.service.ts` | Riwayat request tetap dipertahankan. |
| B-05 | Quotation versioned (create, lines, totals, issue, expire, supersede) | EXISTING | `handyman-quotations-api.routes.ts` › `/requests/:id/quotation`, `/quotations/:id/versions`, `/quotation-versions/:id/{lines,totals,issue,expire,supersede}`; `handyman-quotations/handyman-quotation.service.ts` | Snapshot dan versi tersedia. |
| B-06 | Quotation presented ke customer | EXISTING | `GET /handyman/requests/:id/quotation/presented`; `GET /handyman/quotation-versions/:id/{decision,lines,totals,execution-scope}` | Dibaca lewat bearer; Customer Care belum punya jalur (B1). |
| B-07 | Customer approval APPROVE/REJECT terikat ke versi | EXISTING (authority PARTIAL) | `POST /handyman/quotation-versions/:id/decision` (`tenant_company.manage`); `handyman-quotation-decision.service.ts` › `decideHandymanQuotation` (`assertQuotationThreadBuildingAccess`, import baris 8) | Enum `HANDYMAN_QUOTATION_DECISIONS = ['APPROVE','REJECT']`. Tidak ada `REVISION` eksplisit; revisi lewat `supersede`. |
| B-08 | Execution Scope dibuat saat APPROVE (satu transaksi) | EXISTING | `handyman-quotation-decision.service.ts` baris ~238–250 (`buildExecutionScopeInput` hanya jika `decision === 'APPROVE'`) | Ini satu-satunya pemicu scope eksekusi. |
| B-09 | Revisi quotation oleh customer (policy-permitted) | PARTIAL | `supersede` ada; tidak ada decision `REVISION_REQUESTED` | Perlu keputusan K5 (lihat §10). |
| B-10 | Pricing execution (labor, material, fee) | PARTIAL | `handyman-labor-pricing`, `handyman-material-pricing`, `handyman-pricing-contract` (service ada; `pricing-contract` dipakai `handyman-customer-transactions`); **tidak ada route** | Jalur pemanggilan dari quotation line ke pricing belum dibuktikan. |

### 3.C Tenant-controlled scheduling, crew assignment, Work Order

| ID | Kapabilitas | Status | Bukti | Catatan / gap |
|---|---|---|---|---|
| C-01 | Scheduling readiness (create, supersede, read, history) | EXISTING (gate PARTIAL) | `handyman-readiness-api.routes.ts` › `/requests/:id/scheduling-readiness{,/history}`, `/scheduling-readiness/:id/supersede`; `handyman-scheduling/handyman-scheduling.service.ts` | Input hanya "request reference + preferred window" (`handyman-scheduling.types.ts:57`). |
| C-02 | Konfirmasi jadwal oleh tenant/customer | **MISSING** | Tidak ada state konfirmasi tenant pada readiness. Input `preferred window` saja. | Perlu K4: apakah konfirmasi tenant wajib sebelum dispatch. |
| C-03 | Gate: readiness scheduling/unit access/permit mempengaruhi assignment, arrival, work session | **MISSING** | `handyman-scope-assignments`, `handyman-arrival-*`, `handyman-work-sessions`: 0 referensi fungsional ke readiness (hanya komentar `NO scheduling`). | **BLOCKER B5.** |
| C-04 | Crew: work crew, lead, members, status | EXISTING | `handyman-provider-api.routes.ts` › `/work-crews{,/:id,/:id/lead,/:id/members,/:id/status}`, `/crew-memberships/:id/status`; `handyman-providers/handyman-work-crew.service.ts` | Helper tidak wajib login (sesuai baseline). |
| C-05 | Provider context dan worker context | EXISTING | `handyman-provider-api` › `/provider-contexts*`, `/worker-contexts*`, `/provider-availability` | Reuse `vendors` sebagai konteks. |
| C-06 | Assignment execution scope (assign, reassign, read) | EXISTING | `handyman-scope-assignments-api.routes.ts` › `/execution-scopes/:id/assignment{,/reassign}`; `handyman-scope-assignment.service.ts` › `assignHandymanExecutionScopeCrew`, `reassignHandymanExecutionScopeCrew`, `resolveHandymanAssignmentLead` (baris 359) | Sumber kebenaran Lead. |
| C-07 | **Work Order** sebagai entitas | **MISSING** | Tidak ada tabel/entitas WO Handyman. `HANDYMAN_EXECUTION_SCOPE_STATUSES = ['AUTHORIZED']` (`handyman-quotations/handyman-execution-scope.types.ts:13`). `work-orders` (FM) tidak diimpor (0 hasil). | **BLOCKER B4.** Kandidat: Execution Scope = Work Order (K2). |
| C-08 | Dispatch queue (daftar scope untuk dispatcher) | **MISSING** | Tidak ada `GET` daftar execution scope. Hanya `GET /handyman/requests` (list request). | Dibutuhkan Handyman-Operations. |
| C-09 | Tenant-controlled scheduling sebagai proses end-to-end | PARTIAL | C-01 + C-03 + C-06 belum terhubung. | Tergantung B5 dan K4. |

### 3.D Permit/access coordination, work session, material, evidence

| ID | Kapabilitas | Status | Bukti | Catatan / gap |
|---|---|---|---|---|
| D-01 | Permit readiness (record) | PARTIAL | `handyman-readiness-api` › `/permit-readiness{,/history}`, `/permit-readiness/:id/supersede`; `handyman-scheduling/handyman-permit-readiness.service.ts` | **Tidak terhubung ke `src/modules/permits`** (0 referensi). Record standalone, tanpa gate. Keputusan: reuse atau tetap standalone (K6). |
| D-02 | Unit access readiness (record) | PARTIAL | `handyman-readiness-api` › `/unit-access-readiness{,/history}`; `handyman-scheduling/handyman-unit-access.service.ts` | Sama dengan D-01: tanpa gate. |
| D-03 | Arrival verification (challenge, location, result) | EXISTING (authority OK) | `handyman-arrival-verification-api.routes.ts` › `GET/POST /execution-scopes/:id/arrival-verification`; `handyman-arrival-results/*` memanggil `resolveHandymanAssignmentLead` (2 call site) | Route tulis hanya `auth`. Verifikasi Lead dilakukan di service (lihat §5). Presence ≠ billable terpisah. |
| D-04 | Work session (check-in, start-work, pause, material-run, resume, complete, check-out, active) | EXISTING | `handyman-work-sessions-api.routes.ts`; `handyman-work-sessions/handyman-work-session.service.ts` (`resolveHandymanAssignmentLead` 3 call site) | Lead-only di service. |
| D-05 | Time model (presence, actual work, billable) | EXISTING | `GET /handyman/work-sessions/:id/time-projection`; `handyman-work-session.service.ts` (6 referensi billable/presence/actual) | Terpisah sesuai baseline. |
| D-06 | Material lines: estimate, approve, issue, purchase, use, return, settle, final-charge-ready | EXISTING (integrasi PARTIAL) | `handyman-material-execution-api.routes.ts`; `handyman-material-execution.service.ts` › `authorityPreamble` (baris 81–104, Lead-only) | Tidak ada referensi `inventory-stock-movements`/`inventory-material-reservations` pada modul material. Catalog hanya membaca `inventory-items`. |
| D-07 | Evidence scope dan record (create, files, finalize, read) | EXISTING | `handyman-evidence-qc-api.routes.ts` › `/execution-scopes/:id/evidence`, `/evidence-records/:id{,/files,/finalize}`; `handyman-evidence-qc.service.ts` (6 call site `resolveHandymanAssignmentLead`) | Reuse `../evidence/storage` dan `../evidence/evidence-integrity`. |
| D-08 | Stage evidence (BEFORE/DURING/AFTER/QC/DEFECT/RECTIFICATION/MATERIAL/BAST/WARRANTY) | PARTIAL | Stage type belum diverifikasi per stage pada PART ini | Verifikasi di PART 05–07. |

### 3.E Supervisor QC, rework, BAST

| ID | Kapabilitas | Status | Bukti | Catatan / gap |
|---|---|---|---|---|
| E-01 | QC run (open, items, finish; status OPEN/PASSED/FAILED) | EXISTING (authority PARTIAL) | `handyman-evidence-qc-api` › `/execution-scopes/:id/qc-runs`, `/qc-runs/:id/items`, `/qc-runs/:id/finish`; `handyman-evidence-qc.service.ts` (`handymanQcNotAuthorizedError`, Lead) | **QC dijalankan oleh Crew Lead, bukan Supervisor.** Tidak ada persona Supervisor (B7). |
| E-02 | Supervisor QC sebagai persona terpisah | **MISSING** | Tidak ada role/permission Supervisor. 0 referensi `supervisor` di `handyman-*`. | **BLOCKER B7.** |
| E-03 | Defect dan rectification (OPENED → RECTIFYING → RECTIFIED → VERIFIED) | EXISTING | `handyman-evidence-qc-api` › `/execution-scopes/:id/defects`, `/defects/:id/{start-rectification,record-rectification,request-reinspection,pass-reinspection}`; `handyman-evidence-qc/*.service` | Rework dilakukan oleh Lead. Pemisahan QC/rework belum tervalidasi. |
| E-04 | BAST read, accept, reject, sign-off | EXISTING (authority PARTIAL) | `handyman-bast-api.routes.ts` › `GET /execution-scopes/:id/bast`, `GET /bast/:id`, `POST /bast/:id/{accept,reject,sign-off}`; `handyman-bast.service.ts` (`acceptHandymanBast` baris 240; `scope.status !== 'AUTHORIZED'` baris 88; `assertBuildingScopedResourceAccess`) | Sign-off oleh tenant lewat bearer; Customer Care belum punya jalur (B1). |
| E-05 | **BAST issuance** (prepare → issue, void) | **PARTIAL → BLOCKER** | `handyman-bast/handyman-bast.service.ts` › `prepareHandymanBast` (baris 94), `issueHandymanBast` (216), `voidHandymanBast` (228). **0 pemanggil** di luar modul, **0 route HTTP**. | **BLOCKER B6.** Tidak ada cara mengeluarkan BAST lewat API. |
| E-06 | Gate BAST terhadap QC PASSED dan checkout | **MISSING** | `handyman-bast.service.ts`: 0 referensi `qc` atau `PASS`. | **BLOCKER B6.** |
| E-07 | Check-out | EXISTING | `POST /execution-scopes/:id/work-sessions/check-out` | Hubungan check-out → BAST belum terbukti. |

### 3.F Invoice, Customer Care payment report, Finance/Authorized Manager verification

| ID | Kapabilitas | Status | Bukti | Catatan / gap |
|---|---|---|---|---|
| F-01 | Customer transaction (ledger anchor per execution scope) | EXISTING | `handyman-customer-transactions/*.service` (dipakai oleh `handyman-customer-payments/handyman-customer-payment.service.ts`); `GET /execution-scopes/:id/customer-ledger`, `GET /customer-ledger` | Ledger read reuse. |
| F-02 | **Invoice** sebagai dokumen | **MISSING** | Tidak ada entitas/route invoice. Satu-satunya kata `invoice` di `handyman-*` ada di regex firewall warranty-contract. | Perlu K7: apakah Handyman perlu invoice terpisah dari ledger. |
| F-03 | Customer Care **report** payment (claim `PENDING`) | EXISTING (authority PARTIAL) | `POST /execution-scopes/:id/customer-payments` (`tenant_company.manage`); `handyman-customer-payment.service.ts` › `recordHandymanCustomerPayment` | Pelaporan oleh Customer Care tersedia **hanya** via bearer `tenant_company.manage`, bukan authority workspace. |
| F-04 | Payment **confirm/reject** oleh Finance | **PARTIAL → BLOCKER** | `POST …/customer-payments/:id/confirm`, `…/reject`; `handyman-customer-payment.available-actions.ts` (`PENDING → ['CONFIRM','REJECT']`) | **Customer Care diberi aksi CONFIRM/REJECT** oleh read projection. Tidak ada pembatasan persona Finance. **BLOCKER B3.** |
| F-05 | Pemisahan pelapor dan pemverifikasi (maker-checker) | **MISSING** | `handyman-customer-payment.service.ts` › `decide()` (baris 255–): hanya `authorityPreamble` dan pemeriksaan status. `recorded_by_user_id` dan `decided_by_user_id` disimpan (`repository.ts` baris 31–32, 158) tetapi **tidak dibandingkan**. | **BLOCKER B3.** |
| F-06 | Authority persona Finance / Authorized Manager | **MISSING** | Seed tidak punya role finance Handyman. Hanya `tenant_company.*`. | **BLOCKER B2.** |
| F-07 | Koreksi ledger dan alokasi pembayaran | PARTIAL | `handyman-customer-ledger-corrections` (service, 0 impor dari luar kecuali types), `handyman-customer-payment-allocations` (0 impor). **Tanpa route.** | Tidak terjangkau HTTP. |
| F-08 | Financial read (ringkasan) | PARTIAL | `handyman-financial-read` (2 export, 0 pemanggil). | Tanpa route. |

### 3.G Handyman Manager exclusive final CLOSE

| ID | Kapabilitas | Status | Bukti | Catatan / gap |
|---|---|---|---|---|
| G-01 | State final CLOSED untuk scope atau request | **MISSING** | `HANDYMAN_EXECUTION_SCOPE_STATUSES = ['AUTHORIZED']`. `HANDYMAN_SERVICE_REQUEST_STATUSES` berakhir di `REFERRED`. `CLOSED` hanya muncul di komentar (`customer-payment.types.ts:17`, komentar "CLOSED neutral channel vocabulary"). | **BLOCKER B4.** |
| G-02 | Persona Handyman Manager | **MISSING** | Tidak ada di `HANDYMAN_JOURNEY_LIFECYCLE.json` v1.0 maupun seed. | Perlu K1 (konfirmasi persona). |
| G-03 | Route `CLOSE` | **MISSING** | Tidak ada route. | Setelah B1–B7 dan B9. |

### 3.H Settlement, commercial fee, warranty lifecycle

| ID | Kapabilitas | Status | Bukti | Catatan / gap |
|---|---|---|---|---|
| H-01 | Settlement (prepare, include, reconcile, settle, correction, hold) | **PARTIAL (service-only)** | `handyman-settlement/handyman-settlement.service.ts` baris 182–365 (6 fungsi). **0 impor dari luar modul**, **0 route**. | Tidak terjangkau. |
| H-02 | Financial entitlement (provider, BM fee) | **PARTIAL (service-only)** | `handyman-financial-entitlements` (1 export) — diimpor hanya oleh `handyman-settlement`. | Tidak terjangkau. |
| H-03 | Commercial agreement (versioned) | PARTIAL | `handyman-commercial-agreements` (lifecycle + service). **Tanpa route.** Diimpor `handyman-pricing-contract`, `labor-pricing`, `material-pricing`, `bm-fee-rules`. | Tidak ada HTTP. |
| H-04 | BM fee rules (LABOR_ONLY default) | PARTIAL | `handyman-bm-fee-rules` (service). **Tanpa route.** | Tidak ada HTTP. |
| H-05 | Warranty record dan read | EXISTING | `handyman-service-warranty-api.routes.ts` › `GET /execution-scopes/:id/service-warranty`, `GET /service-warranties/:id` | Read saja. |
| H-06 | **Warranty start** (pembuatan dari BAST ACCEPTED) | **MISSING** | `startHandymanServiceWarranty` (`handyman-service-warranty.service.ts:127`) — **0 pemanggil**. | **BLOCKER B9.** |
| H-07 | Warranty expiry | PARTIAL | `expireHandymanServiceWarranty` (baris 216) — **0 pemanggil**; tidak ada job/scheduler. | Perlu keputusan scheduler. |
| H-08 | Claim (create, submit, approve, reject, withdraw) | EXISTING (bergantung H-06) | `POST /service-warranties/:id/claims`, `POST /service-warranty-claims/:id/{submit,approve,reject,withdraw}`; `handyman-service-warranty-claims/*` | Claim hanya bisa dibuat jika warranty ACTIVE, dan H-06 belum ada. |
| H-09 | Rework warranty dan chargeable additional work | EXISTING | `POST /service-warranty-reworks/:id/authorize`, `POST /chargeable-additional-works/:id/{accept,reject}`; `GET …/:id` | Lead-gated di service (`handyman-service-warranty-rework.service.ts` baris 145). |
| H-10 | Service warranty terpisah dari asset warranty | EXISTING | `handyman-service-warranty-contracts` (firewall) | Sesuai CR-HM-00. |

### 3.X Lintas seam

| ID | Kapabilitas | Status | Bukti | Catatan / gap |
|---|---|---|---|---|
| X-01 | SLA status dan provider performance | EXISTING | `handyman-sla-status-api.routes.ts` › `GET /sla/subjects/:type/:id`, `GET /provider-performance`, `GET /requests/:id/status-visibility`, `GET /execution-scopes/:id/status-visibility` | Read terturunkan. |
| X-02 | Notifikasi Handyman | PARTIAL | `handyman-notifications` (1 export, **0 impor**) | Belum terhubung ke event. |
| X-03 | Audit | PARTIAL | `handyman-audit` (diimpor hanya oleh `handyman-provider-performance`). Event per modul ada (mis. tabel event pembayaran dengan `actor_user_id`). | Belum ada audit terpadu per aksi. |
| X-04 | Authority via persona (role/permission per persona) | **MISSING** | `src/database/seeds/foundation-access.seed.ts:254–255`: hanya `tenant_company.read` dan `tenant_company.manage`. Pencarian `CUSTOMER_CARE|DISPATCHER|FINANCE|SUPERVISOR` di seed: 0 hasil. | **BLOCKER B2.** |

**Hitungan akhir baris:** 72 baris, lihat §1 (diverifikasi ulang di §11.3).

---

## 4. Route dan kontrak yang dipakai tiga frontend yang ada

Tiga frontend diambil dari `docs/HANDYMAN_PRODUCT_BASELINE.md`. **Repository frontend tidak ada di workspace ini**, sehingga pemakaian aktual oleh frontend **belum diverifikasi**. Kolom "Kontrak" menunjukkan endpoint yang sudah ada dan harus dipakai ulang. Tidak ada endpoint baru yang diusulkan.

### 4.1 Handyman-Frontend (Customer Care via BM Super App)

| Langkah | Endpoint (sudah ada) | Auth | Status |
|---|---|---|---|
| Handoff / assertion | `POST /handoff/assertions`, `POST /handoff/channel-attributions` | integration signature | EXISTING |
| Admission workspace | `POST /handyman/care/session`, `DELETE /handyman/care/session` | signed / bearer workspace | EXISTING |
| Pilih property, building, tenant, unit | `GET /handyman/care/properties`, `…/{propertyId}/buildings`, `…/tenant-companies`, `…/spaces`, `…/occupancies` | workspace bearer | EXISTING |
| Katalog | `GET /handyman/care/properties/{propertyId}/catalogue/{services,material-profiles,material-profiles/{profileId}}` | workspace bearer | EXISTING |
| Buat intake | `POST /handyman/care/properties/{propertyId}/create-exchanges` atau `POST /handyman/requests/care` | workspace / exchange | EXISTING (duplikat O1) |
| Lampiran intake | `GET/POST /handyman/requests/{id}/intake-evidence` | **bearer `tenant_company.*`** | PARTIAL (B1) |
| Daftar dan detail | `GET /handyman/care/requests`, `…/{requestId}` | workspace bearer | EXISTING |
| Status | `GET /handyman/requests/{id}/status-visibility` | bearer | PARTIAL (B1) |
| Quotation presented dan decision | `GET /handyman/requests/{id}/quotation/presented`, `POST /handyman/quotation-versions/{id}/decision` | bearer `tenant_company.*` | PARTIAL (B1) |
| BAST accept/reject/sign-off | `POST /handyman/bast/{id}/{accept,reject,sign-off}` | bearer | PARTIAL (B1) |
| Pelaporan pembayaran | `POST /handyman/execution-scopes/{id}/customer-payments` | bearer `tenant_company.manage` | PARTIAL (F-03) |
| **Konfirmasi pembayaran** | `POST …/customer-payments/{paymentId}/confirm` | bearer | **BLOCKER B3** (seharusnya tidak untuk Customer Care) |
| Warranty claim | `POST /handyman/service-warranties/{id}/claims`, `…/submit` | bearer | PARTIAL (B9) |

### 4.2 Mob-Handyman (Lead Worker / field)

| Langkah | Endpoint | Auth | Status |
|---|---|---|---|
| Penugasan | `GET /handyman/execution-scopes/{id}/assignment` | bearer `tenant_company.read` | EXISTING |
| Arrival | `GET/POST /handyman/execution-scopes/{id}/arrival-verification` | bearer (Lead di service) | EXISTING |
| Work session | `GET …/work-sessions`, `…/active`, `POST …/check-in`, `start-work`, `pause`, `resume`, `material-run`, `complete`, `check-out`; `GET /handyman/work-sessions/{id}/time-projection` | bearer (Lead di service) | EXISTING |
| Material | `GET …/material-lines`, `POST …/material-lines/estimate`, `…/{lineId}/{approve,issue,purchase,use,return,settle}`, `GET …/final-charge-ready` | bearer (Lead di service) | EXISTING (integrasi inventory PARTIAL) |
| Evidence | `POST/GET …/evidence`, `POST /handyman/evidence-records/{id}/files`, `…/finalize`, `GET …` | bearer (Lead di service) | EXISTING |
| QC | `POST/GET …/qc-runs`, `POST /handyman/qc-runs/{id}/items`, `…/finish` | bearer (Lead di service) | EXISTING (B7) |
| Defect | `POST/GET …/defects`, `POST /handyman/defects/{id}/{start-rectification,record-rectification,request-reinspection,pass-reinspection}` | bearer (Lead di service) | EXISTING |
| Status | `GET /handyman/execution-scopes/{id}/status-visibility` | bearer | EXISTING |

### 4.3 Handyman-Operations (Dispatcher / Admin)

| Langkah | Endpoint | Auth | Status |
|---|---|---|---|
| Daftar request | `GET /handyman/requests` | bearer `tenant_company.read` | EXISTING (tanpa persona Dispatcher) |
| Triage / inspection / diagnosis / referral | `POST/GET /handyman/requests/{id}/{triage,inspection,diagnosis,referral}` | bearer | EXISTING |
| Readiness | `POST/GET /handyman/requests/{id}/{scheduling,unit-access,permit}-readiness{,/history}`, `POST …/{readinessId}/supersede` | bearer | PARTIAL (tanpa gate, B5) |
| Quotation issue | `POST /handyman/quotation-versions/{id}/{lines,issue,expire,supersede}`, `POST /handyman/requests/{id}/quotation` | bearer | EXISTING |
| Assignment | `POST/GET /handyman/execution-scopes/{id}/assignment`, `POST …/reassign` | bearer | EXISTING |
| Crew, provider, worker | `…/work-crews*`, `…/provider-contexts*`, `…/worker-contexts*`, `GET /handyman/provider-availability` | bearer | EXISTING |
| Performa dan SLA | `GET /handyman/provider-performance`, `GET /handyman/sla/subjects/{type}/{id}` | bearer | EXISTING |
| Dispatch queue (daftar scope) | — | — | **MISSING (C-08)** |
| Close | — | — | **MISSING (G-03)** |

---

## 5. Persona dan authority (state saat ini)

| Persona (baseline v1.0) | Identitas di backend | Authority saat ini | Yang tidak bisa dilakukan | Status |
|---|---|---|---|---|
| Tenant/Customer | Tidak login langsung (README) | Tidak ada | — | Sesuai |
| Customer Care | Actor BM terverifikasi (`actorCapability = CUSTOMER_CARE`), sesi workspace | Workspace: admission, scope, intake, read. Tidak ada jalur lifecycle lanjutan. | Triage, quotation decision, BAST, pembayaran (lewat bearer) | **PARTIAL (B1)** |
| Dispatcher | User lokal | `tenant_company.read/manage` + building scope. Tidak ada role Dispatcher. | Membedakan dari Admin Operations | **MISSING (B2)** |
| Admin Operations | User lokal | Sama dengan Dispatcher | — | **MISSING (B2)** |
| Admin Configuration | User lokal | Tidak ada permission Handyman | — | **MISSING (B2)** |
| Admin Finance | User lokal | Tidak ada role finance Handyman. Pembayaran confirm memakai `tenant_company.manage` + building scope. | Verifikasi pembayaran yang terpisah | **MISSING (B2, B3)** |
| Admin Access | User lokal | Tidak ada permission khusus | — | **MISSING (B2)** |
| Lead Worker | User lokal + assignment Lead (`resolveHandymanAssignmentLead`) | Lead-only di service untuk work session, material, evidence, QC, defect, arrival | Persona terpisah belum ada | **EXISTING (service)** |
| Helper Worker | Worker context tanpa login wajib | Anggota crew, tidak punya action sendiri | — | Sesuai |
| Supervisor (tidak ada di baseline v1.0) | — | — | QC independen | **MISSING (B7)** |
| Finance / Authorized Manager (tidak ada di v1.0 sebagai nama) | — | — | Verifikasi pembayaran, settlement | **MISSING (B2, B3)** |
| Handyman Manager (tidak ada di v1.0) | — | — | CLOSE final | **MISSING (B4)** |

**Catatan segregasi:** Lead yang sama memegang `approve` material line (`material-execution.service.ts` baris 232–): tidak ada pemisahan antara estimator/requester dan approver. Perlu diputuskan (K8).

**Catatan keamanan:** Pemeriksaan keamanan sudah dilakukan pada CR-HM-SEC-01 dan CR-HM-SEC-03. PART 01 tidak mengulang audit keamanan. Hanya kesenjangan authority persona yang dicatat.

---

## 6. Blocker register

| ID | Blocker | Dampak E2E | Bukti | Bergantung | PART target |
|---|---|---|---|---|---|
| **B1** | Customer Care tidak bisa menjalankan lifecycle setelah intake dengan authority workspace. Route lifecycle (triage…decision, BAST, status, payment report) hanya menerima `user_sessions`. | Tahap 4–11 tidak bisa dijalankan sebagai Customer Care | `authentication.middleware.ts` → `session.service.ts` → `user_sessions` (`session.repository.ts:45–56`); `handyman_care_workspace_sessions` (0429) hanya dipakai `care-workspace.routes.ts` | K1 | PART 03 |
| **B2** | Tidak ada model persona/permission Handyman. Seluruh Handyman memakai `tenant_company.read/manage`. | Tidak bisa membedakan Dispatcher, Finance, Supervisor, Manager | `foundation-access.seed.ts:254–255`; 0 role seed Handyman | K1 | PART 02 |
| **B3** | Customer Care dapat CONFIRM/REJECT pembayaran. Tidak ada maker-checker. | Melanggar baseline "Finance verifies" dan risiko kontrol | `customer-payment.available-actions.ts`; `decide()` tanpa cek `recorded_by ≠ decided_by` | K4 | PART 04 |
| **B4** | Work Order dan state CLOSE tidak ada. Execution scope hanya `AUTHORIZED`. | Tidak ada dispatch/WO lifecycle; CLOSE tidak bisa dijalankan | `handyman-execution-scope.types.ts:13`; 0 `CLOSED` state | K2, K1 | PART 05 + PART 11 |
| **B5** | Readiness (scheduling, unit access, permit) tidak menggerbang assignment, arrival, atau work session. | Tenant-controlled scheduling dan access coordination tidak mempengaruhi eksekusi | 0 referensi fungsional pada `handyman-scope-assignments`, `handyman-arrival-*`, `handyman-work-sessions` | K4, K6 | PART 05 |
| **B6** | BAST tidak bisa diterbitkan lewat API dan tidak ada gate QC PASSED. | Accept/sign-off tidak punya BAST untuk diproses | `handyman-bast.service.ts` `prepare/issue/void` 0 pemanggil; `bast-api` tanpa route issue | K9 | PART 07 |
| **B7** | QC dijalankan Lead, tidak ada Supervisor QC. | Pemisahan tugas QC tidak ada | `handyman-evidence-qc.service.ts` (Lead); 0 referensi Supervisor | K8 | PART 08 |
| **B8** | Settlement, financial entitlement, commercial agreement, BM fee, ledger correction, payment allocation, financial read tidak punya route. | Settlement dan fee tidak terjangkau | §3.F, §3.H; 0 impor dari luar | K7 | PART 10 |
| **B9** | Warranty tidak pernah dimulai (`startHandymanServiceWarranty` 0 pemanggil). Claim tidak bisa lahir dari warranty riil. | Tahap warranty tidak tercapai | `handyman-service-warranty.service.ts:127`, 0 pemanggil | B6 | PART 09 |
| **B10** | Invoice tidak ada. | Tahap "Invoice" tidak ada | §3.F F-02 | K7 | PART 10 |
| **B11** | Tower tidak punya padanan model. | Mapping input Customer Care ambigu | §3.A A-07 | K3 | PART 02 (keputusan) |
| **B12** | Tidak ada bukti runtime. | Tidak bisa menyatakan E2E complete | 150 file test Handyman belum dijalankan (§9) | — | PART 02 (baseline) |

---

## 7. Register overlap kontrak (tanpa endpoint baru)

| ID | Overlap | Surface A | Surface B | Keputusan yang dibutuhkan |
|---|---|---|---|---|
| O1 | Dua jalur intake Customer Care | `POST /handyman/care/properties/{propertyId}/create-exchanges` | `POST /handyman/requests/care` | Tetapkan satu jalur kanonik untuk frontend workspace. Jangan tambah jalur ketiga. |
| O2 | Dua surface baca request | `GET /handyman/care/requests{,/:id}` (workspace) | `GET /handyman/requests{,/:id}` (bearer) | Jalur workspace harus memakai data yang sama, bukan query baru. |
| O3 | Dua surface status | `GET /handyman/requests/:id/status-visibility` | belum ada padanan workspace | Tambahkan akses workspace ke endpoint yang sudah ada (PART 03), bukan endpoint baru. |
| O4 | Pembayaran | `customer-payments/…/confirm` (bearer) | `available-actions` menawarkan CONFIRM ke Customer Care | Pisahkan authority (B3). |
| O5 | Quotation presented | `GET /handyman/requests/{id}/quotation/presented` (bearer) | `GET /handyman/quotation-versions/{id}/decision` | Keduanya tetap; buka akses workspace untuk keduanya bila diputuskan. |
| O6 | Evidence intake vs evidence scope | `…/intake-evidence` (request) | `…/execution-scopes/{id}/evidence` | Bukan duplikat; stage berbeda. Pertahankan. |

---

## 8. Scope guard

- **BM Super App hanya channel akses.** Tercermin di `channel_attribution.origin_channel = BM_SUPER_APP` (satu-satunya nilai) dan `handoff` / `care-workspace`. Tidak ada modul BM Super App sebagai domain Handyman.
- **ASENTRA dan BM Operations tidak masuk modul Handyman.** Pencarian `asentra|bm_operations|bm-operations|BM Operations` di `src/modules/handyman-*`: **0 hasil**.
- **BM_FEE** adalah istilah fee komersial (`handyman-bm-fee-rules`), bukan channel.
- Modul FM (`work-orders`, `permits`, `schedules`, `bast-documents`, `evidence` umum) **tidak diimpor** oleh Handyman kecuali `evidence/storage` dan `evidence/evidence-integrity` (utilitas file).

---

## 9. Bukti runtime

| Pemeriksaan | Dijalankan? | Hasil |
|---|---|---|
| `npm ci` / install dependency | Tidak (validasi ringan) | — |
| `npm run typecheck` | Tidak | — |
| `npm test` (150 file dengan prefix `handyman` di `tests/`) | Tidak | — |
| Request HTTP ke server | Tidak | — |
| Migrasi database | Tidak | — |

**Kesimpulan:** Tidak ada runtime evidence untuk W01 PART 01. Setiap klaim "EXISTING" adalah klaim kode/route. E2E **tidak** dinyatakan complete.

---

## 10. Keputusan yang dibutuhkan dan urutan PART coding berikutnya

### 10.1 Keputusan (K)

| ID | Pertanyaan | Dibutuhkan untuk |
|---|---|---|
| K0 | Sediakan dokumen "Business Journey Lifecycle v1.3 FROZEN". Apakah v1.0 JSON dan product baseline dianggap sumber sementara? | Seluruh matriks |
| K1 | Konfirmasi daftar persona final: apakah `Supervisor`, `Finance / Authorized Manager`, dan `Handyman Manager` adalah persona baru, dan apa nama role/permission-nya? | B2, B4, B7 |
| K2 | Apakah **Execution Scope** adalah Work Order Handyman, atau perlu entitas WO terpisah? | B4, C-07 |
| K3 | Apakah **Tower** = Building, atau ada level di antara Property dan Building? | B11 |
| K4 | Apakah jadwal wajib dikonfirmasi tenant (atau Customer Care atas nama tenant) sebelum dispatch? Apakah readiness harus ACTIVE sebelum assignment dan arrival? | B3, B5, C-02 |
| K5 | Apakah customer boleh meminta REVISION sebagai decision tersendiri, atau cukup supersede oleh BM/Ops? | B-09 |
| K6 | Apakah permit dan unit access readiness harus memakai `src/modules/permits` (FM) atau tetap standalone? | D-01, D-02 |
| K7 | Apakah invoice adalah dokumen terpisah dari customer ledger, dan apakah settlement/fee wajib punya HTTP surface di PART berikutnya? | B8, B10 |
| K8 | Apakah QC wajib dilakukan Supervisor (bukan Lead)? Apakah Lead boleh approve material yang ia estimasi sendiri? | B7, §5 |
| K9 | Siapa yang menerbitkan BAST (Lead, Supervisor, atau sistem setelah QC PASSED)? | B6 |

### 10.2 Urutan PART coding berikutnya (usulan, bukan implementasi)

Urutan mengikuti dependensi authority → gate → dokumen → final close. Setiap PART wajib menambah bukti runtime pada scope-nya.

| PART | Fokus | Blocker | Catatan |
|---|---|---|---|
| **PART 02** | **Baseline runtime + keputusan persona.** Jalankan `npm ci`, `typecheck`, dan subset test Handyman sebagai baseline. Bekukan matriks persona→permission (K1, K3, K4). Tanpa perubahan route. | B2, B11, B12 | Ini PART pertama yang memberi runtime evidence. |
| **PART 03** | **Jembatan authority Customer Care.** Izinkan workspace principal membaca dan memakai endpoint lifecycle yang sudah ada (triage, quotation presented/decision, BAST accept, status) melalui exchange/workspace authority. Tidak ada endpoint duplikat. Tutup O2 dan O3. | B1 | Harus memakai `care-workspace` dan `handyman_care_workspace_sessions`, bukan `user_sessions`. |
| **PART 04** | **Pemisahan verifikasi pembayaran.** Customer Care hanya report. Finance/Authorized Manager confirm/reject. Enforce maker ≠ checker. Tutup O4. | B3, B2 | Putuskan apakah ledger correction dan allocation ikut PART ini (K7). |
| **PART 05** | **Work Order, dispatch, dan gate readiness.** Dispatch queue (GET scope), konfirmasi jadwal tenant (K4), readiness menjadi prasyarat assignment dan arrival. | B4, B5 | Bergantung K2 dan K4. |
| **PART 06** | **Arrival dan work session di bawah gate baru.** Verifikasi end-to-end: arrival → check-in → start → material → complete → check-out, dengan bukti runtime. | B5 | Ini seam Mob-Handyman. |
| **PART 07** | **Penerbitan BAST.** Tambahkan route issue (atau trigger) dan gate QC PASSED + check-out. Accept oleh tenant lewat workspace. | B6 | Bergantung K9. |
| **PART 08** | **Supervisor QC dan rework independen.** QC open/finish oleh Supervisor. Lead tetap untuk rectification. | B7 | Bergantung K1, K8. |
| **PART 09** | **Warranty start dan expiry.** Pemicu `startHandymanServiceWarranty` dari BAST ACCEPTED. Putuskan scheduler untuk `expire`. | B9 | Bergantung PART 07. |
| **PART 10** | **Settlement, fee, invoice (read dulu).** HTTP read untuk commercial agreement, BM fee, settlement, entitlement. Invoice bila diputuskan. | B8, B10 | Bergantung K7. |
| **PART 11** | **Handyman Manager CLOSE.** State CLOSED dan route close. Prasyarat: BAST ACCEPTED, pembayaran terverifikasi, settlement reconciled, warranty dimulai. | B4 (G-01…G-03) | Hanya setelah PART 04, 07, 09, 10. |
| **PART 12** | **Runtime E2E harness.** Satu skenario end-to-end per persona dengan bukti runtime. Baru pada titik ini boleh menyatakan E2E. | B12 | Terakhir, bukan pertama. |

**Batas PART 01:** Tidak ada perubahan kode, migrasi, route, atau OpenAPI. Perbaikan OpenAPI (jika ada) dilakukan di setiap PART terkait.

---

## 11. Validasi yang dijalankan pada PART 01

| Pemeriksaan | Perintah / metode | Hasil |
|---|---|---|
| Branch dan HEAD | `git branch --show-current`, `git rev-parse HEAD` | `arena/c6fc25e1-handyman-backend`, `9602991` |
| Inventaris route | Pembacaan `src/routes/index.ts` dan `*.routes.ts` Handyman | Lihat §3–§4 |
| Pemeriksaan authority middleware | Skrip regex pada `router.<verb>(…)` Handyman | Write `auth`-only di work-session, material, evidence-qc, arrival-verification; diverifikasi Lead di service |
| Reachability | Impor lintas modul dan indeks identifier | Lihat H-01, H-02, F-07, X-02, B-10 |
| Drift OpenAPI | Parse `docs/api/openapi.yaml` vs route literal | 0 route literal di kode yang tidak ada di OpenAPI. Selisih sisanya berasal dari path berbasis template/array. |
| Referensi path di dokumen ini | Skrip §11.1 | Lihat hasil di bawah |
| `git diff --check` | Lihat §11.2 | Lihat hasil di bawah |

### 11.1 Skrip pemeriksaan path dan hitungan status

```bash
# dijalankan dari /home/user/Handyman-Backend
python3 - <<'PY'
import re,os,sys
doc=open('docs/e2e/W01_BACKEND_CONTRACT_AUTHORITY.md').read()
paths=set(re.findall(r'`((?:src|docs|tests|scripts)/[^`\s]+)`',doc))
missing=[p for p in sorted(paths) if not os.path.exists(p.split(' ')[0])]
print('path refs:',len(paths),'missing:',len(missing))
for m in missing: print('  MISSING',m)
PY
```

Hasil dan hitungan status akan dicatat di §11.3 setelah skrip dijalankan.

### 11.2 Pemeriksaan diff

```bash
git diff --check
git status --short
```

### 11.3 Hasil

Dijalankan pada working tree sebelum commit:

- Referensi path di dokumen: **14** diperiksa, **0** tidak resolve (glob `*` dan sufiks `:baris` ditangani).
- Placeholder tersisa: **0**.
- Jumlah bagian `##`: 13.
- `git diff --check`: **bersih**.
- `git status --short`: hanya `docs/e2e/` (satu file baru). Tidak ada perubahan `src/`, `tests/`, migrasi, atau OpenAPI.
- Hitungan status matriks: EXISTING 40, PARTIAL 18, MISSING 14 (total 72 baris).

---

## 12. Lampiran: perintah audit yang dipakai

Tidak ada perubahan kode. Perintah audit yang dipakai bersifat baca-saja (`grep`, `sed`, skrip Python ke `/tmp`). Skrip tidak disimpan di repository.

---

## 13. PART 02 — Runtime Baseline & Persona Authority Contract

**Status:** dokumen kontrak + baseline runtime. **Tanpa perubahan API, schema DB, atau business logic.** Tidak ada PR dibuat.
**Tanggal:** 2026-10-10 · **Branch:** `arena/c6fc25e1-handyman-backend` · **Baseline sebelum PART 02:** `cbb64c7`

### 13.1 Ringkasan

- **Runtime:** typecheck PASS. Subset 25 file Handyman dijalankan (bukan full suite): **212 tests, 200 pass, 12 fail, 0 skip**. Dari 12 kegagalan, **9 adalah defect tes** (2 kolisi token tetap, 7 ekspektasi stale) dan **3 adalah temuan authority nyata** (Lead tidak bisa membaca evidence/QC karena route read memakai `tenant_company.read`).
- **Hipotesis awal "duplicate key karena DB tidak di-reset" terbantah:** kolisi terjadi juga pada DB yang baru direset, di dalam satu run.
- **Authority HTTP Handyman sangat sempit:** seluruh route Handyman hanya memakai dua kode permission, `tenant_company.read` (14 route) dan `tenant_company.manage` (9 route). Sisanya dijaga assignment Lead atau scope di service. Tidak ada kode `handyman.*` di seed.
- **K0 masih terbuka:** dokumen "Business Journey Lifecycle v1.3 FROZEN" **tetap tidak ditemukan** di repo (`docs/HANDYMAN_JOURNEY_LIFECYCLE.json` masih v1.0). Kontrak di §13.6 dirumuskan dari ringkasan v1.3 yang diberikan user dan **harus diverifikasi terhadap file v1.3 asli** sebelum PART 03 dimulai.

### 13.2 Baseline runtime (PASS / FAIL / BLOCKED)

| Cek | Status | Bukti / catatan |
|---|---|---|
| Install dependency | PASS | `npm ci` sesuai lockfile; log di `/tmp/npmci.log` (di luar repo). |
| PostgreSQL 18.4 `127.0.0.1:5432` | PASS | Proses "Test PostgreSQL" berjalan. |
| `npm run typecheck` | PASS | Diulang pada PART 02. |
| Subset 25 file Handyman, run #2 (DB **tidak** direset) | **FAIL** | 200/212 pass, 12 fail, `EXIT=1`. Log: `/tmp/w01-p02-subset.log`. |
| Care workspace 5 file, DB `asentra_test` **direset** | **FAIL** | 61/65 pass, 4 fail (2 duplicate key + 2 stale). Log: `/tmp/w01-p02-care-fresh.log`. |
| Subset 25 file pada DB direset | NOT RUN | Hanya subset care workspace yang dijalankan ulang di DB baru. |
| Full test suite | NOT RUN | Sesuai batasan PART 02. |
| Evidence/QC over HTTP | **FAIL** (3 test) | Authority mismatch, lihat §13.3 kelas C. |
| OpenAPI exact-equality | **FAIL** (sebagian) | Ekspektasi stale, lihat §13.3 kelas B. |
| E2E tiga frontend / BM Super App channel | **BLOCKED** | Tidak ada bukti runtime lintas frontend pada PART 02. |

Status E2E: **belum complete.** Tidak ada pernyataan E2E complete tanpa bukti runtime.

### 13.3 Klasifikasi 12 kegagalan

Kelas A = defect tes (kolisi data); B = ekspektasi stale; C = temuan authority (kode, bukan tes).

| # | Test (file:baris) | Kelas | Penyebab | Tindakan (PART 03 / cleanup tes) |
|---|---|---|---|---|
| 1 | CR-HM-02 OpenAPI exact surface (`handyman-api.test.ts:605`) | B | Aktual memiliki satu `get` tambahan pada path yang diekspektasikan hanya `post`. Belum diperiksa per path. | Periksa path, perbarui ekspektasi. |
| 2 | Caps TTL by exchange and remaining workspace lifetime (`handyman-care-workspace-create-exchange.test.ts:351`) | A | Token tetap `'hcw_' + 'E'.repeat(43)` dipakai ulang di beberapa test dalam satu run. `token_hash` unik → `duplicate key`. Terjadi pada DB direset. | Ganti dengan token unik per test (`randomBytes`). |
| 3 | Revalidates grants and revocation/expiry on all pages (`handyman-care-workspace-requests.test.ts:287`) | A | Kolisi token yang sama seperti #2. | Sama seperti #2. |
| 4 | Adds only list, not detail/mutation (`handyman-care-workspace-requests.test.ts:379`) | B | Test mengharapkan `GET /handyman/care/requests/{id}` = 404 dan tidak terdokumentasi di OpenAPI. Kode dan OpenAPI keduanya memuatnya, dan ada `handyman-care-workspace-request-detail.test.ts` yang menunjukkan detail sengaja ditambahkan kemudian. | Konfirmasi tahap pengenalan detail, lalu perbarui test. |
| 5 | Documents just the admitted care route families (`handyman-care-workspace-scope.test.ts:322`) | B | Daftar route tidak memuat `create-exchanges` (PART 05B) dan `care/requests` (PART 06A). | Perbarui daftar ke surface yang sah. |
| 6 | Firewall sweep, file customer-payment (`handyman-customer-payments.test.ts:719`) | B | `readdirSync` menemukan `handyman-customer-payment.available-actions.ts` (CR-HM-17) yang belum ada di daftar tes. | Tambahkan file ke daftar yang diizinkan. |
| 7 | Evidence CREATE/FILE_ADD/FINALIZE (`handyman-evidence-qc-api.test.ts:192`, baris 314) | C | `GET /handyman/evidence-records/:id` diproteksi `requirePermission('tenant_company.read')`. Lead fixture tidak memiliki permission itu → `PERMISSION_DENIED`. POST create lolos karena route tidak memakai `requirePermission`. | Keputusan persona (§13.4): read Lead harus berbasis assignment. |
| 8 | QC OPEN/ITEM_SET/FINISH (`handyman-evidence-qc-api.test.ts:342`, baris 407) | C | `GET` list QC scope → 403. Penyebab sama seperti #7. | Sama seperti #7. |
| 9 | Defect ladder (`handyman-evidence-qc-api.test.ts:426`, baris 484) | C | `GET` list defect → `403 !== 200`. Penyebab sama. | Sama seperti #7. |
| 10 | OpenAPI 8-operation CR-HM-03 surface (`handyman-lifecycle-api.test.ts:453`) | B | Surface bertambah: diagnosis, inspection, permit-readiness, quotation, scheduling-readiness, unit-access-readiness, dan history masing-masing. | Perbarui ekspektasi ke daftar terverifikasi. |
| 11 | OpenAPI/runtime parity, readiness (`handyman-readiness-api.test.ts:480`) | B | Aktual memuat path readiness/quotation/arrival yang ditambahkan CR berikutnya. | Perbarui ekspektasi. |
| 12 | OpenAPI/runtime parity, scope assignment (`handyman-scope-assignments-api.test.ts:757`) | B | Aktual memuat `/execution-scopes/{id}/assignment` dan path terkait; ekspektasi "ZERO" tidak diperbarui. | Perbarui ekspektasi. |

**Ringkas:** kelas A 2, kelas B 7 (#1, 4, 5, 6, 10, 11, 12), kelas C 3 (#7, 8, 9).

**Catatan kelas B:** tes "parity / ZERO surface" menjadi stale karena CR berikutnya menambah surface secara sah. Mengubah ekspektasi hanya boleh dilakukan **setelah** setiap path dicocokkan dengan CR yang memilikinya. Jangan memperbarui ekspektasi secara massal tanpa pemeriksaan.

### 13.4 Persona → permission matrix

Keterangan kolom: **Existing HTTP** = permission yang benar-benar dipakai route. **Resource scope existing** = guard di service/middleware yang sudah ada. **Perlu ditambahkan** = usulan kode `handyman.*` baru, atau kandidat reuse kode FM bila semantiknya identik.

| Persona | Identitas backend | Existing HTTP permission | Resource scope existing | Perlu ditambahkan (usulan) | Batas tindakan (v1.3, verifikasi K0) |
|---|---|---|---|---|---|
| **Customer Care** | Actor BM terverifikasi (`CUSTOMER_CARE`) lewat care workspace | Tidak ada (auth `careWorkspaceSession`) | Grant workspace: property, tenant company, building | Tidak perlu permission user; capability workspace `handyman.payment.report` | Intake, read yang di-grant, create-exchange, **lapor pembayaran (PENDING)**. Tidak: CONFIRM/REJECT, verify, BAST accept, CLOSE. |
| **Dispatcher** | User lokal | `tenant_company.read/manage` (sebagian route) | `assertBuildingScopedResourceAccess` (building + client aktif) | `handyman.dispatch.manage` (kandidat reuse `schedule.manage` bila semantik sama) | Jadwal, assign crew, antrean. Tidak: verify pembayaran, CLOSE. |
| **Inspector** | **Belum ada di v1.0** | Tidak ada | — | `handyman.inspection.perform` | Inspeksi, diagnosis, temuan. Tidak: approve QC, CLOSE. |
| **Lead Worker** | User + assignment Lead (`resolveHandymanAssignmentLead`) | `tenant_company.read` untuk GET evidence/QC (**penyebab kelas C**); write tanpa permission | Assignment Lead per execution scope | Tidak untuk write. Read harus berbasis assignment, bukan `tenant_company.read`. | Work session, material, evidence, QC item, reply defect. Tidak: QC approve atas scope yang ia kerjakan, verify, CLOSE. |
| **Supervisor** | **Belum ada di v1.0** | Tidak ada | — | `handyman.qc.review` (+ kandidat reuse `supervisor_inspection.manage`, `finding.close`) | QC independen. **Wajib: Supervisor bukan Lead pada scope yang sama.** |
| **Finance** | **Belum ada role Handyman** (hanya `ADMIN_FINANCE` di v1.0) | Pembayaran confirm memakai `tenant_company.manage` | Building scope | `handyman.payment.verify` (kandidat reuse `invoice_payment_status.manage`, `payment_receipt.manage` hanya jika semantik identik) | Verify/reject pembayaran yang dilaporkan. **Wajib: verifier ≠ pelapor (maker-checker).** |
| **Authorized Manager** | **Belum ada** | Tidak ada | — | `handyman.payment.verify` dan/atau `handyman.scope.approve` (**K-P02-3**) | Verifikasi di atas ambang (ambang belum ditentukan). Tidak: CLOSE. |
| **Handyman Manager** | **Belum ada di v1.0 / seed** | Tidak ada | — | `handyman.scope.close` (eksklusif) | Satu-satunya yang boleh CLOSE final scope/request. |

**Catatan:** Helper Worker tidak memiliki authority sendiri (sesuai §5). Tenant tidak login langsung (sesuai README-HANDYMAN-OVERWRITE).

### 13.5 Permission: existing, perlu ditambahkan, dan resource-scope

**A. Existing (dipakai runtime saat ini)**

- `tenant_company.read` (14 route, termasuk GET evidence/QC/defect yang gagal di kelas C).
- `tenant_company.manage` (9 route, termasuk `POST /execution-scopes/:id/customer-payments` dan `…/confirm|reject`).

**B. Existing di seed/FM, tetapi belum dipakai Handyman (kandidat reuse, bukan otomatis)**

`work_order.manage/read`, `bast.accept`, `payment_receipt.manage`, `invoice_payment_status.manage`, `permit.approve`, `supervisor_inspection.manage`, `finding.close`, `tenant_invoice.manage`, `evidence.manage`, `schedule.manage`.
Aturan reuse: pakai kode FM **hanya** bila semantiknya identik dan kepemilikannya FM. Jika Handyman memiliki keputusan (report, verify, CLOSE, QC review), gunakan namespace `handyman.*` baru agar authority tidak bocor ke persona FM.

**C. Perlu ditambahkan (usulan, belum diimplementasikan)**

`handyman.payment.report` (capability workspace Customer Care), `handyman.payment.verify`, `handyman.scope.close`, `handyman.qc.review`, `handyman.inspection.perform`, `handyman.dispatch.manage`, `handyman.scope.approve` (opsional, K-P02-3). Penambahan dilakukan lewat konfigurasi/provisioning, bukan seed role baru (seed hanya punya `PLATFORM_ADMIN`).

**D. Resource-scope enforcement (existing, dipertahankan)**

- Building + client: `assertBuildingScopedResourceAccess` (`context-access.service.ts`), menolak dengan `BUILDING_ACCESS_DENIED` (403) bila tidak ada assignment ACTIVE. Dipakai evidence-qc.
- Lead assignment: `resolveHandymanAssignmentLead` untuk write work session, material, evidence, QC, defect.
- Care workspace grant: property/tenant/building, dengan pemeriksaan ulang tiap halaman (sudah diuji lulus di `handyman-care-workspace-scope`).

**Keputusan persona-scope untuk kelas C:** route **read** Handyman dijaga oleh `resolveHandymanAssignmentLead` atau assignment building, **bukan** `tenant_company.read`. Dengan begitu Lead dapat membaca scope yang ia kerjakan tanpa diberi permission tenant. Ini perubahan authority yang harus diimplementasikan di PART 03, bukan di tes.

### 13.6 Kontrak authority (berdasarkan ringkasan v1.3; verifikasi K0)

**Customer Care — payment reporting**
- Pelaporan dilakukan lewat **care workspace** (capability `handyman.payment.report`), bukan bearer `tenant_company.manage`. Tidak ada endpoint duplikat untuk tiga frontend.
- Hasil: klaim pembayaran `PENDING` dengan `recorded_by` = actor care.
- Read projection untuk Customer Care **tidak boleh** memuat `CONFIRM` atau `REJECT` pada `available-actions`. Ini menutup B3 (F-04).

**Finance — verification**
- Verifikasi dilakukan oleh principal dengan `handyman.payment.verify` dan building scope.
- Aksi: `CONFIRM` atau `REJECT` pada status `PENDING`.
- **Maker-checker wajib:** `decided_by_user_id` ≠ `recorded_by_user_id`. Kolom sudah ada dan tersimpan (`repository.ts` 31–32, 158), tetapi belum dibandingkan (F-05 / B3). Enforcement ini adalah pekerjaan PART 03.
- Authorized Manager: hanya jika K-P02-3 menetapkan peran verifier. Ambang nilai belum ditentukan.

**Manager-only CLOSE**
- Hanya **Handyman Manager** (`handyman.scope.close`) yang boleh CLOSE final scope/request. Customer Care, Dispatcher, Finance, Authorized Manager, Supervisor, dan Lead **tidak** boleh.
- Prasyarat CLOSE (perlu konfirmasi v1.3): pembayaran terverifikasi, BAST diterima, QC disetujui, dan tidak ada defect terbuka.
- State `CLOSED` belum ada di `HANDYMAN_EXECUTION_SCOPE_STATUSES` maupun `HANDYMAN_SERVICE_REQUEST_STATUSES` (G-01, B4).

### 13.7 Pemetaan data (tanpa duplikasi authority)

**Execution Scope vs Work Order**
- **Execution Scope** adalah anchor authority eksekusi Handyman: status, crew, assignment, ledger, dan CLOSE. Ini milik Handyman.
- **Work Order** adalah objek FM. Bukti: kode Handyman menyatakan secara eksplisit "NO FM work_order references" (`handyman-work-session.types.ts`, `handyman-arrival-location.service.ts`). Saat ini **tidak ada tautan**.
- **Keputusan:** Handyman **tidak** membuat state machine Work Order kedua. Jika tautan dibutuhkan, cukup referensi ID read-only (`work_order.read`) yang dicatat sebagai keputusan eksplisit di PART 03. Work Order tidak boleh menjadi sumber status CLOSE.

**Building vs Tower**
- **Tower = Building.** Bukti: kode contoh `TOWER_A` pada validasi Building (`building.validation.ts`). Tidak ada tabel Tower.
- **Keputusan:** tidak ada entitas Tower baru. Label "Tower" hanya klasifikasi atau nama di atas Building. Hierarki: Building → Floor → Space/Unit (Space/Unit sebagai child Floor perlu dikonfirmasi di PART 03).
- Scope key untuk authority = Building (+ Client), sesuai `assertBuildingScopedResourceAccess`.

### 13.8 Keputusan baru yang dibutuhkan

| ID | Keputusan | Rekomendasi |
|---|---|---|
| K0 (lanjutan) | Sediakan file **Business Journey Lifecycle v1.3 FROZEN** | Wajib sebelum PART 03. Kontrak §13.6 dan matriks §13.4 bergantung pada file ini. |
| K-P02-1 | Read Handyman Lead: `tenant_company.read` atau assignment | Assignment (§13.5 D). |
| K-P02-2 | Reuse kode FM atau namespace `handyman.*` | `handyman.*` untuk keputusan Handyman; reuse FM hanya jika semantik identik. |
| K-P02-3 | Authorized Manager: verifier pembayaran dan/atau approver scope? Ambang nilai? | Belum ditentukan. Tunggu v1.3. |
| K-P02-4 | Supervisor vs Lead pada scope yang sama | Dilarang (segregasi). |

### 13.9 Rekomendasi PART 03

1. Verifikasi v1.3 terhadap §13.6 (K0) sebelum coding.
2. Perbaiki **kelas A** (token unik per test) dan **kelas B** (ekspektasi stale, dengan pemeriksaan per path). Ini bukan perubahan API.
3. Ubah authority read Lead dari `tenant_company.read` ke assignment, lalu jalankan ulang tiga test kelas C.
4. Implementasikan maker-checker pada verify (F-05) dan pastikan `available-actions` Customer Care tidak memuat CONFIRM/REJECT.
5. Tambahkan state CLOSED dan route CLOSE hanya untuk `handyman.scope.close`, setelah prasyarat v1.3 dikonfirmasi.
6. Baru setelah itu, jalankan ulang subset pada DB direset dan catat PASS/FAIL. Jangan menyatakan E2E complete sebelum ada bukti runtime lintas journey.

### 13.10 Validasi PART 02

- `npm run typecheck`: PASS.
- Subset 25 file: 212/200/12, dijelaskan di §13.3.
- Care workspace 5 file pada DB direset: 65/61/4.
- Tidak ada perubahan kode, API, atau schema. Hanya dokumen ini yang berubah.
- Node_modules tidak di-stage. Artefak log berada di `/tmp` (di luar repo).
