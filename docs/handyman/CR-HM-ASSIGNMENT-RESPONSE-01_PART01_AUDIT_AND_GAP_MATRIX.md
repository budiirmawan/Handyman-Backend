# CR-HM-ASSIGNMENT-RESPONSE-01 — PART 01: Recovery, Technical Audit, Gap Matrix & PART 02 Implementation Plan

- **CR ID:** `CR-HM-ASSIGNMENT-RESPONSE-01`
- **Part:** `PART 01 — Recovery & Audit Assignment Response`
- **Repository:** `budiirmawan/Handyman-Backend`
- **Active Branch:** `arena/daf49406-handyman-backend`
- **Recovered From Branch:** `arena/acfea631-handyman-backend`
- **Baseline `main`:** `e8b94af426d5d730900d98716135a7114e62e097`
- **Status:** `PART 01 DELIVERED — READY FOR PART 02`

---

## 1. Branch Recovery & Git Baseline Verification

### 1.1 Baseline & Branch State Before Recovery
- **Active Branch:** `arena/daf49406-handyman-backend`
- **Initial HEAD & `main` Baseline:** `e8b94af426d5d730900d98716135a7114e62e097` (`Merge pull request #54 from budiirmawan/arena/8f1ba51f-handyman-backend`)
- **Pre-recovery Ancestor Check:** Neither `4a3bc7d` nor `a391a2e` from `arena/acfea631-handyman-backend` was an ancestor of `HEAD` (`e8b94af`).

### 1.2 Controlled Cherry-Pick Recovery
Because `4a3bc7d120ef144ce38049043e8708cac9ae13e7` had parent `e8b94af426d5d730900d98716135a7114e62e097` and `a391a2eb0d7767777aedfa28af59f52b81954f43` had parent `4a3bc7d120ef144ce38049043e8708cac9ae13e7`, both commits were integrated onto `arena/daf49406-handyman-backend` via `git cherry-pick --ff 4a3bc7d a391a2e` with zero conflicts and without rewriting any code:

| Order | Commit SHA | Subject | Migration | Verification |
|---|---|---|---|---|
| 1 | `4a3bc7d120ef144ce38049043e8708cac9ae13e7` | `feat(handyman): close PART 01 field receipt & worker reimbursement gaps (CR-HM-FIELD-EXPENSE-HELPER-01)` | `0470_handyman_field_expense_reimbursement.ts` | `git merge-base --is-ancestor 4a3bc7d HEAD` = `true` |
| 2 | `a391a2eb0d7767777aedfa28af59f52b81954f43` | `feat(handyman): close PART 02 helper attendance confirmation & personnel change gaps (CR-HM-FIELD-EXPENSE-HELPER-01)` | `0471_handyman_helper_attendance_confirmation.ts` | `git merge-base --is-ancestor a391a2e HEAD` = `true` |

---

## 2. Audit Menyeluruh: Assignment/Reassignment, Notifikasi `IN_APP`, Work Order Acknowledge, Mobile Feed & Status Operations

### 2.1 Audit Assignment & Reassignment (3 Track Penugasan di Backend)

Handyman-Backend memiliki tiga jalur penugasan otoritatif yang saling melengkapi:

#### A. Standard Work Order Assignment (`src/modules/work-order-assignments/`, Migrasi `0085_create_work_order_assignments.ts`)
- **Endpoints:**
  - `POST /api/v1/work-orders/:id/assignments` (`work_order.manage` + BE-02 Building access) → `assignWorkOrder`
  - `PATCH /api/v1/work-orders/:id/assignments/:assignmentId` (`work_order.manage` + BE-02 Building access) → `deactivateWorkOrderAssignment` (`status: 'INACTIVE'`) atau `reassignWorkOrder`
  - `GET /api/v1/work-orders/:id/assignments` & `GET /api/v1/work-orders/:id/assignments/current` (`work_order.read` + BE-02 Building access)
- **Model & Invarian:**
  - Tabel `work_order_assignments` mendukung `assignee_type` ∈ `('WORKFORCE', 'TEAM', 'VENDOR', 'VENDOR_WORKFORCE')` dan `status` ∈ `('ACTIVE', 'INACTIVE')`.
  - Partial unique index `work_order_active_assignment_unique ON work_order_assignments (work_order_id) WHERE status = 'ACTIVE'` menjamin maksimal satu penugasan aktif per Work Order.
  - Mencatat `WORK_ORDER_ASSIGNED`, `WORK_ORDER_REASSIGNED`, dan `WORK_ORDER_ASSIGNMENT_DEACTIVATED` ke `operational_events` melalui `recordWorkOrderEvent`.
- **Temuan Audit:**
  1. Tidak memancarkan notifikasi `IN_APP` (`recordNotification`) kepada pekerja yang ditugaskan saat `assignWorkOrder` maupun `reassignWorkOrder`.
  2. Tabel `work_order_assignments` belum menyimpan status respons pekerja (`PENDING` / `TERIMA` / `TIDAK_BISA`) ataupun alasan penolakan (`decline_reason`).
  3. Pada `reassignWorkOrder`, deaktivasi baris lama (`updateStatus(current.id, 'INACTIVE')`) dan pembuatan baris baru (`create(newAssignment)`) dilakukan secara berurutan di luar satu transaksi DB eksplisit (`withTransaction`).

#### B. Handyman Execution Scope Crew Assignment (`src/modules/handyman-scope-assignments/`, Migrasi `0396` & `0439`)
- **Endpoints:**
  - `POST /api/v1/handyman/execution-scopes/:executionScopeId/assignment` (`tenant_company.manage` + exact-Building access) → `assignHandymanExecutionScopeCrew`
  - `POST /api/v1/handyman/execution-scopes/:executionScopeId/assignment/reassign` (`tenant_company.manage` + exact-Building access, membutuhkan `expectedVersion`, `reason`, dan opsional `idempotencyKey`) → `reassignHandymanExecutionScopeCrew`
  - `GET /api/v1/handyman/execution-scopes/:executionScopeId/assignment` (`tenant_company.read` + exact-Building access)
- **Model & Invarian:**
  - Tabel `handyman_execution_scope_assignments` mengikat `execution_scope_id` (`status = 'AUTHORIZED'`) ke `handyman_provider_context_id` dan `handyman_crew_id` dengan `status` ∈ `('ACTIVE', 'SUPERSEDED')` serta `version` (`INTEGER NOT NULL DEFAULT 1`).
  - **Penting — Trigger Imutabilitas (`0396`)**: Trigger `handyman_es_assignment_block_mutation` memblokir semua `DELETE` dan memblokir semua `UPDATE` pada `handyman_execution_scope_assignments` kecuali transisi `OLD.status = 'ACTIVE' -> NEW.status = 'SUPERSEDED'` dengan seluruh kolom identitas tetap sama. Metadata riwayat disimpan pada tabel pendamping `handyman_execution_scope_assignment_history` (`0439`).
  - Penugasan mengunci baris scope (`SELECT ... FOR UPDATE`), memvalidasi kru aktif dan Crew Lead aktif (`resolveHandymanAssignmentLead`), serta pada `reassign` membatalkan (*supersede*) `handyman_dispatch_releases` berstatus `RELEASED` (`0441`) dan menolak `reassign` bila terdapat sesi kerja aktif (`status <> 'CHECKED_OUT'`).
- **Temuan Audit:**
  1. Tidak memancarkan notifikasi `IN_APP` kepada Crew Lead (`PIC_PEKERJAAN`, `target.leadUserId`) saat penugasan awal maupun penugasan ulang (*reassignment*).
  2. Belum memiliki endpoint atau penyimpanan bagi Crew Lead untuk merespons penugasan (`TERIMA` / `TIDAK_BISA` dengan alasan wajib).

#### C. Handyman Inspection Visit Assignment (`src/modules/handyman-inspector-assignments/`, Migrasi `0438`)
- **Endpoints:**
  - `POST /api/v1/handyman/visits/:visitAppointmentId/inspector-assignment` (`tenant_company.manage` + exact-Building access) → `assignInspectorToVisit`
  - `POST /api/v1/handyman/visits/:visitAppointmentId/inspector-assignment/reassign` (`tenant_company.manage` + exact-Building access, `expectedVersion`, `reason`) → `reassignInspectorForVisit`
  - `POST /api/v1/handyman/visits/:visitAppointmentId/inspector-assignment/revoke` (`tenant_company.manage` + exact-Building access, `expectedVersion`, `reason`) → `revokeInspectorAssignment`
  - `GET /api/v1/handyman/visits/:visitAppointmentId/inspector-assignment` & `GET /api/v1/handyman/requests/:handymanRequestId/inspector-assignments`
- **Model & Invarian:**
  - Tabel `handyman_inspector_assignments` mengikat `visit_appointment_id` (`kind = 'INSPECTION'`) ke pekerja individual `inspector_user_id` (`users.id`) dengan `status` ∈ `('ACTIVE', 'SUPERSEDED', 'REVOKED')` dan `version`.
  - **Penting — Trigger Imutabilitas (`0438`)**: Trigger `handyman_insp_assignment_freeze` memblokir `DELETE` dan hanya mengizinkan `UPDATE` untuk transisi `OLD.status = 'ACTIVE' -> NEW.status IN ('SUPERSEDED', 'REVOKED')` dengan `NEW.version = OLD.version + 1`.
- **Temuan Audit:**
  1. Tidak memancarkan notifikasi `IN_APP` kepada `inspectorUserId` saat ditugaskan, digantikan (*reassigned*), atau dicabut (*revoked*).
  2. Belum memiliki endpoint atau penyimpanan bagi Inspector untuk merespons penugasan kunjungan inspeksi (`TERIMA` / `TIDAK_BISA` dengan alasan wajib).

---

### 2.2 Audit Notifikasi `IN_APP` (`src/modules/notifications/`, `src/modules/handyman-notifications/`, Migrasi `0237` & `0358`)
- **Kapabilitas Eksisting:**
  - Tabel `notifications` (`0237`, diperluas oleh `0240` dan `0358`) menyimpan notifikasi kotak masuk per pengguna (`recipient_user_id`, `client_id`, `type`, `channel = 'IN_APP'`, `status` ∈ `('UNREAD', 'READ')`, `title`, `body`, `source_entity_type`, `source_entity_id`, `source_event_type`, `template_key`, `metadata`, `navigation_target_type`, `navigation_target_id`).
  - Endpoint kotak masuk Mobile/Web yang sudah tersedia:
    - `GET /api/v1/notifications` (self-scoped ke `req.auth.userId`, mendukung filter `?status=UNREAD|READ` dan paginasi)
    - `GET /api/v1/notifications/:id` (self-scoped)
    - `PATCH /api/v1/notifications/:id/read` (transisi idempoten `UNREAD -> READ`)
    - `GET /api/v1/notifications/:id/navigation-target` (`work_order.read`, me-resolve `navigation_target_type = 'WORK_ORDER_FIELD_WORK'` ke item `MobileAssignmentFeedItem`)
- **Temuan Audit & Gap:**
  1. **Tidak ada emisi `recordNotification` langsung dari alur Assignment/Reassignment**: Hasil penelusuran seluruh pemanggil `recordNotification` menunjukkan hanya SLA escalation (`sla-escalation-trigger.service.ts`), notification reminders/escalations, dan `deliverInAppNotifications` (berbasis langganan `notification_subscriptions`) yang memanggil `recordNotification`. Tanpa baris langganan/template yang di-seed per client, penugasan baru tidak menghasilkan baris di `notifications`.
  2. **Kontrak `HANDYMAN_NOTIFICATION_CONTRACT` belum memuat event Assignment & Assignment Response**: Hanya memuat 13 event (SLA, triage, referral, request cancelled, quotation, readiness, crew lead/member designation).
  3. **Constraint `notifications_navigation_target_check` (`0358`)**: Saat ini mengizinkan `(navigation_target_type IS NULL AND navigation_target_id IS NULL)` atau `(navigation_target_type = 'WORK_ORDER_FIELD_WORK' AND navigation_target_id IS NOT NULL)`. Untuk penugasan `work_orders`, `navigationTarget: { type: 'WORK_ORDER_FIELD_WORK', id: workOrderId }` dapat langsung diisi; sedangkan untuk penugasan Handyman Execution Scope dan Inspection Visit, informasi navigasi kontekstual (`executionScopeId`, `handymanRequestId`, `visitAppointmentId`, `assignmentId`) dapat disertakan secara kanonis pada `sourceEntityType`, `sourceEntityId`, dan `metadata` (dengan `navigationTarget: null` agar mematuhi constraint `0358` dan kontrak `CR-BE-RN21-NOTIFICATION-NAV-01`).

---

### 2.3 Audit Work Order Acknowledge (`TERIMA`) & Gap Respons `TIDAK BISA`

#### A. Kontrak Eksisting untuk Respons `TERIMA` (Acknowledge)
Saat ini mekanisme penerimaan tugas hanya ada pada **Standard Work Order** melalui `src/modules/work-order-actions/`:
- **Endpoint:** `POST /api/v1/work-orders/:id/acknowledge`
- **Otorisasi:** `authenticationMiddleware` + `requirePermission('work_order.manage')` + `assertWorkOrderBuildingAccess(req.auth.userId, workOrderId)` + `isActorAuthorizedForWorkOrderAssignment(actorUserId, activeAssignment)`
- **Payload Input:** `{ notes?: string }` (opsional, maksimal 2000 karakter)
- **Perilaku State Machine (`ACTION_RULES.ACKNOWLEDGED`):**
  1. Memvalidasi Work Order ada (`404 WORK_ORDER_NOT_FOUND` bila tidak ada).
  2. Memvalidasi adanya penugasan `ACTIVE` pada `work_order_assignments` (`400 WORK_ORDER_EXECUTION_NO_ASSIGNMENT` bila tidak ada).
  3. Memvalidasi aktor adalah penerima tugas sah (`403 WORK_ORDER_EXECUTION_UNAUTHORIZED` bila bukan).
  4. Memvalidasi `work_orders.status` ∈ `['OPEN', 'ASSIGNED']` (`400 WORK_ORDER_EXECUTION_INVALID_STATE` bila status di luar itu).
  5. Dalam satu transaksi: mengubah `work_orders.status` dari `OPEN -> ASSIGNED` (bila semula `OPEN`), menyisipkan baris `action_type = 'ACKNOWLEDGED'` ke `work_order_actions`, dan memenuhi jam SLA `RESPONSE` (`satisfyClock(workOrder, 'RESPONSE', action.occurredAt, tx)`).
  6. Mencatat `WORK_ORDER_STATUS_CHANGED` (jika berubah) dan `WORK_ORDER_EXECUTION_ACTION` ke `operational_events`, lalu mengembalikan `201 Created` (`PublicWorkOrderAction`).

#### B. Gap pada Respons `TERIMA` & Gap Kritis Respons `TIDAK BISA` dengan Alasan Wajib
1. **Tidak Ada Endpoint atau Model Respons `TIDAK BISA` (Decline / Unable) di Seluruh Track:**
   - Pada Standard Work Order, satu-satunya aksi penolakan/pembatalan adalah `POST /api/v1/work-orders/:id/cancel`, yang merupakan **aksi manajemen** (`requiresAssignment: false`) yang mengubah `work_orders.status` menjadi terminal `'CANCELLED'` dan menghentikan seluruh SLA clock. Pekerja lapangan **tidak boleh** membatalkan Work Order ketika berhalangan; pekerja hanya menolak/mengembalikan penugasan (`TIDAK_BISA`) dengan alasan wajib agar Operations dapat melakukan *reassignment*.
2. **Tidak Ada Endpoint Respons (`TERIMA` maupun `TIDAK_BISA`) pada Handyman Execution Scope & Inspection Visit:**
   - Crew Lead (`PIC_PEKERJAAN`) pada `handyman_execution_scope_assignments` dan Inspector pada `handyman_inspector_assignments` belum memiliki endpoint Mobile (`/handyman/field/...`) untuk mengonfirmasi `TERIMA` atau menyatakan `TIDAK_BISA` beserta alasan wajib (`reason`).
3. **Ketiadaan Idempotency & State Respons Per-Assignment pada `POST /api/v1/work-orders/:id/acknowledge`:**
   - Memanggil `POST /api/v1/work-orders/:id/acknowledge` berulang kali saat status `ASSIGNED` akan terus menambahkan baris duplikat `ACKNOWLEDGED` di `work_order_actions` tanpa pemeriksaan idempotensi per `assignment_id`.
4. **Ketiadaan Gate Eksekusi terhadap Penugasan yang Ditolak (`TIDAK_BISA`):**
   - Bila pekerja telah menyatakan `TIDAK_BISA` pada suatu penugasan aktif (sebelum Operations melakukan *reassign*), sistem wajib memblokir eksekusi lapangan (`START` pada Work Order, `CHECK_IN` pada Handyman Work Session) pada penugasan yang sudah ditolak tersebut.

---

### 2.4 Audit Penentuan Penerima Notifikasi: Pekerja Individual vs Crew Lead (`PIC_PEKERJAAN`)

Sesuai aturan arsitektur Handyman (termasuk `CR-HM-04` dan `CR-HM-FIELD-EXPENSE-HELPER-01` PART 02 tentang Helper tanpa akun login):

| Jalur Penugasan | Entitas yang Ditugaskan | Aktor Lapangan & Penerima Notifikasi `IN_APP` yang Benar | Resolusi Otoritatif di Backend |
|---|---|---|---|
| **Handyman Execution Scope Assignment** (`handyman_execution_scope_assignments`) | Kru Kerja (`handyman_crew_id`) | **Hanya Crew Lead aktif (`PIC_PEKERJAAN`)** — *Helper tidak memiliki/tidak wajib memiliki akun login Mobile* | `resolveHandymanAssignmentLead`: `handyman_crew_leads (ORDER BY lead_seq DESC LIMIT 1)` → `handyman_crew_memberships (ACTIVE)` → `handyman_worker_contexts (ACTIVE)` → `workforce_profiles (ACTIVE, user_id IS NOT NULL)` → `users (ACTIVE)` (`leadUserId`) |
| **Handyman Inspector Assignment** (`handyman_inspector_assignments`) | Pekerja Individual Inspector (`inspector_user_id`) | **Pekerja Individual Inspector (`inspectorUserId`)** | Kolom `handyman_inspector_assignments.inspector_user_id` (`users.id` berstatus `ACTIVE` dengan penempatan gedung aktif) |
| **Standard Work Order — `WORKFORCE` / `VENDOR_WORKFORCE`** (`work_order_assignments`) | Profil Pekerja Individual (`workforce_profile_id`) | **Pekerja Individual (`workforce_profiles.user_id`)** | `workforce_profiles.id = workforce_profile_id` → `workforce_profiles.user_id` (dengan `users.status = 'ACTIVE'`) |
| **Standard Work Order — `TEAM`** (`work_order_assignments`) | Tim Internal (`team_id`) | **Anggota aktif tim yang memiliki akun `users` aktif & akses gedung** | `workforce_profiles WHERE team_id = $1 AND status = 'ACTIVE' AND user_id IS NOT NULL` + `user_building_assignments (ACTIVE)` |
| **Standard Work Order — `VENDOR`** (`work_order_assignments`) | Vendor (`vendor_id`) | **Pekerja vendor aktif yang terikat ke `vendor_workforce_bindings` & memiliki akun `users` aktif di gedung tersebut** | `vendor_workforce_bindings (ACTIVE)` → `workforce_profiles (ACTIVE, user_id IS NOT NULL)` + `user_building_assignments (ACTIVE)` |
| **Respons Pekerja (`TERIMA` / `TIDAK_BISA`) → Operations** | Baris Penugasan Aktif | **Petugas Operations pemberi tugas (`assignedByUserId`)** | Kolom `assigned_by_user_id` pada penugasan aktif (jika `users.status = 'ACTIVE'`) |

- **Saat Reassignment (Penugasan Ulang):**
  - Penerima baru (Crew Lead baru / Inspector baru / Workforce baru) menerima notifikasi `IN_APP` penugasan baru.
  - Penerima lama (Crew Lead lama / Inspector lama / Workforce lama, apabila berbeda dari penerima baru dan memiliki `user_id` aktif) menerima notifikasi `IN_APP` bahwa penugasannya telah digantikan (*superseded/reassigned*).

---

### 2.5 Audit Mobile Feed & Status Operations

#### A. Mobile Feeds
1. **`GET /api/v1/mobile/assignments` (`src/modules/mobile-assignments/`)**:
   - Mengembalikan daftar `TASK` dan `WORK_ORDER` aktif milik pekerja yang login.
   - **Gap:** Objek `assignee` hanya menampilkan `{ assigneeType, workforceProfileId, teamId, assignedByUserId, assignedAt, assignmentStatus }` tanpa `responseStatus` (`PENDING | TERIMA | TIDAK_BISA`), `respondedAt`, atau `declineReason`. Selain itu, `availableActions` hanya menampilkan `ACKNOWLEDGE`, `START`, `HOLD`, `RESUME`, `ADD_NOTE`, `CANCEL`, `COMPLETE`, `CLOSE` — belum mencerminkan ketersediaan aksi respons (`ACKNOWLEDGE` / `DECLINE`) atau menyembunyikan `START` ketika penugasan telah ditolak (`TIDAK_BISA`).
2. **`GET /api/v1/handyman/field/my-jobs` & `GET /api/v1/handyman/field/execution-scopes/:executionScopeId` (`src/modules/handyman-field-feed/`)**:
   - `MY_JOBS_SQL` mengembalikan daftar pekerjaan bagi Crew Lead (`PIC_PEKERJAAN`) dan `MY_INSPECTIONS_SQL` mengembalikan daftar inspeksi bagi Inspector.
   - **Gap:** Baik `jobs[]`, `inspections[]`, maupun `assignmentContext` pada detail Execution Scope / Request belum menyertakan status respons penugasan (`responseStatus`: `'PENDING' | 'TERIMA' | 'TIDAK_BISA'`, `respondedAt`, `respondedByUserId`, `responseNotes`, `declineReason`).

#### B. Operations Status & Queue Surfaces
1. **`GET /api/v1/handyman/operations/queue` (`src/modules/handyman-operations-queue/`)** dan **`GET /api/v1/handyman/requests/:requestId/status` & `GET /api/v1/handyman/execution-scopes/:executionScopeId/status` (`src/modules/handyman-sla-status-api/`)**:
   - Saat ini `stages.assignment` hanya berisi `{ assignmentId, status, providerContextId, crewId }`.
   - **Gap:** Operations belum dapat melihat apakah penugasan kru saat ini masih menunggu respons (`PENDING`), sudah diterima (`TERIMA`), atau ditolak (`TIDAK_BISA` beserta `declineReason`, `respondedAt`, `respondedByUserId`, dan penanda `reassignmentRequired: true`).
2. **Detail Assignment Reads (`GET /api/v1/handyman/execution-scopes/:executionScopeId/assignment`, `GET /api/v1/handyman/visits/:visitAppointmentId/inspector-assignment`, `GET /api/v1/work-orders/:id/assignments`, `GET /api/v1/work-orders/:id/assignments/current`)**:
   - **Gap:** Belum memproyeksikan ringkasan respons pekerja (`responseStatus`, `respondedAt`, `respondedByUserId`, `declineReason`, `notes`) pada representasi publik penugasan.

---

## 3. Gap Matrix (`Existing` / `Reuse` / `New`)

| # | Area Kapabilitas | Status (`Existing` / `Reuse` / `New`) | Artefak / Lokasi | Penjelasan & Keputusan Arsitektur |
|---|---|---|---|---|
| 1 | Penugasan & Reassignment Kru Execution Scope (`0396`, `0439`, `0441`) | **Existing / Reuse** | `src/modules/handyman-scope-assignments` | Tetap menjadi otoritas penugasan kru; trigger imutabilitas `0396` (`handyman_es_assignment_block_mutation`) dijaga utuh tanpa modifikasi kolom langsung pada tabel dasar. |
| 2 | Penugasan & Reassignment Inspector Visit (`0438`) | **Existing / Reuse** | `src/modules/handyman-inspector-assignments` | Tetap menjadi otoritas penugasan inspector; trigger imutabilitas `0438` (`handyman_insp_assignment_freeze`) dijaga utuh. |
| 3 | Penugasan & Reassignment Standard Work Order (`0085`) | **Existing / Reuse + Hardened Transaction** | `src/modules/work-order-assignments` | Tetap menjadi otoritas penugasan Work Order; akan diperkaya dengan emisi notifikasi `IN_APP` dan proyeksi respons penugasan. |
| 4 | Fondasi Kotak Masuk Notifikasi `IN_APP` (`0237`, `0358`) | **Existing / Reuse** | `src/modules/notifications` (`recordNotification`, `listNotifications`, `markNotificationRead`) | Digunakan langsung untuk mengirim notifikasi `IN_APP` kepada pekerja individual atau Crew Lead (`PIC_PEKERJAAN`) saat assign/reassign, serta kepada Operations saat pekerja merespons `TERIMA` / `TIDAK_BISA`. |
| 5 | Resolusi Crew Lead Otoritatif (`PIC_PEKERJAAN`) | **Existing / Reuse** | `resolveHandymanAssignmentLead` (`src/modules/handyman-scope-assignments`) | Digunakan untuk menentukan `leadUserId` penerima notifikasi dan memverifikasi otorisasi Crew Lead saat merespons penugasan Execution Scope. |
| 6 | Kontrak Acknowledge Standard Work Order (`POST /work-orders/:id/acknowledge`) | **Existing / Extend** | `src/modules/work-order-actions` | Dipertahankan kompatibilitasnya (`OPEN -> ASSIGNED`, pemenuhan SLA `RESPONSE`), sekaligus disinkronkan dengan ledger respons penugasan (`TERIMA`), idempotensi per-assignment, dan pemblokiran bila status respons sudah `TIDAK_BISA`. |
| 7 | Tabel & Ledger Respons Penugasan (`handyman_assignment_responses` & `handyman_assignment_response_events`) | **New (PART 02 — Migrasi `0472`)** | `src/database/migrations/0472_handyman_assignment_responses.ts` | Menyimpan status respons per `assignment_id` (`TERIMA` / `TIDAK_BISA`), alasan wajib (`decline_reason` saat `TIDAK_BISA`), catatan (`notes`), `responded_by_user_id`, `responded_at`, `idempotency_key`, serta histori append-only tanpa melanggar trigger imutabilitas `0396`/`0438`. |
| 8 | Endpoint Respons Penugasan (`TERIMA` & `TIDAK_BISA`) untuk Work Order, Execution Scope, dan Inspection Visit | **New (PART 02)** | `src/modules/handyman-assignment-responses` / `work-order-actions` | Menyediakan endpoint respons bagi pekerja individual dan Crew Lead (`TERIMA` maupun `TIDAK_BISA` dengan alasan wajib) beserta validasi ketatnya. |
| 9 | Proyeksi Status Respons pada Mobile Feed & Status Operations | **New / Extend (PART 02)** | `handyman-field-feed`, `mobile-assignments`, `handyman-sla-status-api`, `handyman-operations-queue` | Menambahkan visibilitas `assignmentResponse` (`responseStatus`: `'PENDING' | 'TERIMA' | 'TIDAK_BISA'`, `respondedAt`, `declineReason`, `reassignmentRequired`) ke Mobile feed dan Operations status/queue. |

---

## 4. Rencana Implementasi PART 02 (Arsitektur, Otorisasi, Response Status, Idempotency & Race Condition)

### 4.1 Desain Database (Migrasi `0472_handyman_assignment_responses.ts`)
Karena tabel `handyman_execution_scope_assignments` (`0396`) dan `handyman_inspector_assignments` (`0438`) memiliki trigger imutabilitas yang melarang `UPDATE` selain transisi `ACTIVE -> SUPERSEDED|REVOKED`, respons pekerja disimpan pada tabel kanonis terpisah:
1. **`handyman_assignment_responses`** (1 baris kanonis per `assignment_id`):
   - `id UUID PRIMARY KEY`
   - `client_id UUID NOT NULL REFERENCES clients(id)`
   - `building_id UUID NOT NULL REFERENCES buildings(id)`
   - `assignment_target_type TEXT NOT NULL CHECK (assignment_target_type IN ('WORK_ORDER_ASSIGNMENT', 'EXECUTION_SCOPE_ASSIGNMENT', 'INSPECTOR_VISIT_ASSIGNMENT'))`
   - `assignment_id UUID NOT NULL`
   - `work_order_id UUID REFERENCES work_orders(id)`
   - `execution_scope_id UUID REFERENCES handyman_execution_scopes(id)`
   - `visit_appointment_id UUID REFERENCES handyman_visit_appointments(id)`
   - `handyman_request_id UUID REFERENCES handyman_service_requests(id)`
   - `response_status TEXT NOT NULL CHECK (response_status IN ('TERIMA', 'TIDAK_BISA'))`
   - `decline_reason TEXT`
   - `notes TEXT`
   - `responded_by_user_id UUID NOT NULL REFERENCES users(id)`
   - `responded_by_worker_context_id UUID REFERENCES handyman_worker_contexts(id)`
   - `responded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `idempotency_key TEXT NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 8 AND 200)`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - **Constraints & Indexes:**
     - `UNIQUE (assignment_target_type, assignment_id)` — menjamin tepat satu keputusan akhir per `assignment_id` aktif; ketika Operations melakukan *reassignment*, baris penugasan baru memiliki `assignment_id` baru yang otomatis berstatus efektif `'PENDING'`.
     - `CONSTRAINT handyman_assignment_responses_reason_check CHECK ((response_status = 'TIDAK_BISA' AND decline_reason IS NOT NULL AND char_length(btrim(decline_reason)) BETWEEN 1 AND 1000) OR (response_status = 'TERIMA' AND decline_reason IS NULL))` — menjamin alasan wajib (`decline_reason`) selalu ada pada `TIDAK_BISA` dan tidak boleh ada pada `TERIMA`.
     - Trigger append-only/immutability (`BEFORE UPDATE OR DELETE`) pada `handyman_assignment_responses` dan `handyman_assignment_response_events` sehingga respons yang sudah tercatat tidak dapat dihapus atau dimanipulasi.

### 4.2 Aturan Otorisasi (Authorization)
1. **Exact-Building Isolation (`BE-02G`)**:
   - Setiap pembacaan dan penulisan wajib memverifikasi bahwa aktor memiliki `user_building_assignments` berstatus `ACTIVE` pada `building_id` dan `client_id` dari Work Order / Execution Scope / Inspection Visit terkait (`assertBuildingScopedResourceAccess` / `assertWorkOrderBuildingAccess`). Akses lintas gedung dalam client yang sama atau lintas client ditolak dengan `403 BUILDING_ACCESS_DENIED`.
2. **Verifikasi Identitas Penerima Tugas (Strict Assignee Authority)**:
   - **Execution Scope Assignment**: Hanya **Crew Lead aktif (`PIC_PEKERJAAN`)** dari kru yang sedang memegang penugasan `ACTIVE` pada scope tersebut (`resolveHandymanAssignmentLead(executionScopeId, actorUserId).leadUserId === actorUserId`). Helper atau Crew Lead dari kru lain ditolak dengan `403`.
   - **Inspector Visit Assignment**: Hanya **Inspector aktif** yang tercantum pada penugasan `ACTIVE` kunjungan inspeksi tersebut (`activeAssignment.inspectorUserId === actorUserId`).
   - **Standard Work Order Assignment**: Hanya pekerja yang memenuhi `isActorAuthorizedForWorkOrderAssignment(actorUserId, activeAssignment)` (pemilik `workforce_profile_id`, anggota aktif `team_id`, atau pekerja vendor aktif pada `vendor_id`) serta memegang izin eksekusi yang sesuai.
   - Petugas Operations yang bukan penerima tugas lapangan tidak boleh memalsukan respons pekerja (`403`).

### 4.3 State Machine `responseStatus` & Efek Samping Operasional
- **Nilai Status Respons Efektif per Assignment:**
  - `'PENDING'`: Penugasan berstatus `ACTIVE` dan belum memiliki baris di `handyman_assignment_responses`.
  - `'TERIMA'` (`ACCEPTED` / `ACKNOWLEDGED`):
    - Pekerja/Crew Lead menyetujui penugasan.
    - Pada Standard Work Order: juga menjalankan transisi `OPEN -> ASSIGNED` (bila masih `OPEN`), mencatat `ACKNOWLEDGED` di `work_order_actions`, dan memenuhi jam SLA `RESPONSE`.
    - Pada Execution Scope / Inspection Visit: mencatat respons `TERIMA`, mencatat `operational_events`, dan mengirimkan notifikasi `IN_APP` kepada `assignedByUserId` (Operations).
  - `'TIDAK_BISA'` (`DECLINED` / `UNABLE`):
    - Wajib menyertakan `reason` (`1..1000` karakter setelah `trim()`; jika kosong/hilang ditolak dengan `422 HANDYMAN_ASSIGNMENT_DECLINE_REASON_REQUIRED`).
    - Ditolak (`409`) apabila pekerjaan sudah dimulai (`work_orders.status` ∈ `['IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CLOSED', 'CANCELLED']`, `handyman_work_sessions` aktif sudah ada / `CHECKED_IN`, atau `handyman_visit_appointments.state === 'IN_PROGRESS' | 'COMPLETED'`).
    - Penugasan tetap memiliki jejak audit utuh dengan status respons `'TIDAK_BISA'` dan `reassignmentRequired: true` pada proyeksi Operations Queue & Status Visibility, sementara eksekusi lapangan (`START` Work Order / `CHECK_IN` Work Session) oleh penugasan yang telah menyatakan `TIDAK_BISA` diblokir dengan `409` hingga Operations melakukan *reassignment*.
    - Mengirimkan notifikasi `IN_APP` prioritas kepada `assignedByUserId` (Operations) berisi identitas pekerjaan dan alasan `TIDAK_BISA`.

### 4.4 Idempotency
1. **Idempotent Replay untuk Keputusan yang Sama:**
   - Bila pekerja mengirim ulang permintaan `TERIMA` (ketika sudah `TERIMA`) atau `TIDAK_BISA` (ketika sudah `TIDAK_BISA` dengan `idempotencyKey` yang sama atau alasan yang sama pada `assignment_id` yang sama), service mengembalikan baris respons yang sudah tercatat (`replayed: true`, HTTP `200 OK`) tanpa menggandakan baris di `handyman_assignment_responses`, `work_order_actions`, `operational_events`, ataupun menggandakan notifikasi `IN_APP`.
2. **Penolakan Perubahan Keputusan yang Bertentangan (`409 Conflict`):**
   - Bila penugasan sudah direspons `TERIMA` lalu pekerja mencoba mengirim `TIDAK_BISA` (atau sebaliknya `TIDAK_BISA -> TERIMA`), atau mengirim `TIDAK_BISA` dengan `idempotencyKey` baru dan alasan berbeda setelah keputusan terkunci, service menolak dengan `409 HANDYMAN_ASSIGNMENT_RESPONSE_ALREADY_RECORDED`. Jika pekerja yang sudah `TERIMA` kemudian mengalami kendala darurat sebelum sesi dimulai, prosedurnya adalah menghubungi Operations untuk melakukan `reassign` (dengan `reason` wajib di sisi Operations).

### 4.5 Penanganan Race Condition & Concurrency
1. **Row-Level Locking (`SELECT ... FOR UPDATE`) dalam Satu Transaksi (`withTransaction`)**:
   - Saat memproses respons pekerja (`TERIMA` / `TIDAK_BISA`), transaksi mengunci baris induk (`work_orders` / `handyman_execution_scopes` / `handyman_visit_appointments`) **dan** baris penugasan `ACTIVE` (`work_order_assignments` / `handyman_execution_scope_assignments` / `handyman_inspector_assignments`) dengan `SELECT ... FOR UPDATE`.
2. **Race Condition: Pekerja Merespons Bersamaan dengan Operations Melakukan Reassign**:
   - Karena baik `reassign` maupun `respond` mengakuisisi `FOR UPDATE` lock pada scope/visit dan baris assignment aktif dalam urutan yang konsisten:
     - Jika `reassign` menang lebih dulu, penugasan lama telah berubah menjadi `SUPERSEDED` / `INACTIVE` dan kru/pekerja baru menjadi `ACTIVE`; saat transaksi `respond` milik pekerja lama dievaluasi, pemeriksaan otorisasi mendapati pekerja lama bukan lagi pemegang penugasan `ACTIVE` (atau `assignmentId` yang dikirim sudah `SUPERSEDED`) sehingga ditolak secara deterministik (`409`/`403`) tanpa mengotori penugasan milik pekerja baru.
     - Jika `respond` (`TIDAK_BISA`) menang lebih dulu, respons tercatat pada `assignment_id` lama; ketika `reassign` berjalan berikutnya, `reassign` men-supersede `assignment_id` lama (beserta respons `TIDAK_BISA`-nya tetap tersimpan di histori) dan membuat `assignment_id` baru dengan status respons bersih `'PENDING'`.
3. **Race Condition: Dua Request Respons Paralel dari Pekerja yang Sama**:
   - Diserialisasi oleh `FOR UPDATE` lock pada baris assignment aktif **dan** dijaga sebagai *defense-in-depth* oleh constraint database `UNIQUE (assignment_target_type, assignment_id)` pada `handyman_assignment_responses` (menangkap kode PostgreSQL `23505`).

---

## 5. Verifikasi Kompatibilitas Lintas PR & Migrasi (`0461–0471`)

### 5.1 Peta Urutan Nomor Migrasi Database
| Rentang Migrasi | Pemilik / Branch / PR | Status di Branch Ini (`arena/daf49406-handyman-backend`) | Keterangan Kompatibilitas |
|---|---|---|---|
| `0001..0460` | Baseline `main` (`e8b94af`) | **Ada (Ancestor)** | Fondasi utama termasuk `0085`, `0086`, `0237`, `0358`, `0396`, `0438`, `0439`, `0440`, `0441`. |
| `0461..0467` | PR #55 (`30be708`, `CR-HM-WORKER-COMPETENCY-01`) | Di branch PR #55 (`arena/3df97f5e-handyman-backend`) | Mengelola `workforce_certifications`, `service_catalog_competency_requirements`, `workforce_competency_decision_history`, dan multi-trade WO classification. |
| `0468` | Commit `63f3a85` (`CR-HM-BE-IAM-PERMISSION-REVOCATION-01`) | Di branch IAM Revocation | Menambahkan `PERMISSION_GRANTED` / `PERMISSION_REVOKED` pada constraint event audit IAM. |
| `0469` | Cadangan (*Reserved slot*) | Kosong | Dikosongkan untuk mencegah benturan penomoran antar branch paralel. |
| `0470` | Commit `4a3bc7d` (`CR-HM-FIELD-EXPENSE-HELPER-01` PART 01) | **Ada (Dipulihkan di HEAD)** | `0470_handyman_field_expense_reimbursement.ts` — Foto Nota & Reimbursement Petugas. |
| `0471` | Commit `a391a2e` (`CR-HM-FIELD-EXPENSE-HELPER-01` PART 02) | **Ada (Dipulihkan di HEAD)** | `0471_handyman_helper_attendance_confirmation.ts` — Konfirmasi Kehadiran Helper. |
| **`0472`** | **Rencana PART 02 (`CR-HM-ASSIGNMENT-RESPONSE-01`)** | **Disiapkan untuk PART 02** | `0472_handyman_assignment_responses.ts` — bebas benturan nomor dengan `0461–0467` (PR #55), `0468` (IAM), dan `0470–0471` (Expense–Helper). |

### 5.2 Kompatibilitas Modul & Skema dengan PR #55 (`30be708`), IAM (`63f3a85`), dan Expense–Helper (`0470–0471`)
1. **Kompatibilitas dengan PR #55 (`CR-HM-WORKER-COMPETENCY-01`, `30be708`)**:
   - PR #55 menambahkan evaluasi kompetensi (`assertCompetencyEligible` & `persistCompetencyDecision`) di dalam `assignHandymanExecutionScopeCrew`, `reassignHandymanExecutionScopeCrew`, `assignWorkOrder`, dan `reassignWorkOrder`.
   - Karena rencana PART 02 menyimpan respons penugasan pada tabel baru `handyman_assignment_responses` (`0472`) dan memanggil helper emisi notifikasi/proyeksi secara modular tanpa mengubah skema dasar `handyman_execution_scope_assignments` atau `work_order_assignments`, integrasi dengan PR #55 bersifat **100% aditif dan bebas konflik struktural**.
2. **Kompatibilitas dengan IAM Permission Revocation (`63f3a85`, Migrasi `0468`)**:
   - Seluruh endpoint baru pada PART 02 akan menggunakan middleware `authenticationMiddleware` + `requirePermission(...)` yang me-resolve izin efektif per-request dari database, sehingga pencabutan izin melalui `DELETE /api/v1/roles/:roleId/permissions/:permissionId` (`63f3a85`) langsung berlaku seketika tanpa memerlukan perubahan sesi atau skema.
3. **Kompatibilitas dengan Expense–Helper (`4a3bc7d` & `a391a2e`, Migrasi `0470–0471`)**:
   - Kedua commit telah dipulihkan utuh sebagai ancestor `HEAD`. Aturan bahwa Helper tidak wajib memiliki akun login (`users`) pada `0471` dijaga sepenuhnya pada desain Assignment Response: untuk penugasan kru (`handyman_execution_scope_assignments`), penerima notifikasi `IN_APP` dan aktor yang berwenang merespons `TERIMA` / `TIDAK_BISA` adalah **Crew Lead (`PIC_PEKERJAAN`)**, bukan Helper.

---

## 6. Hasil Pemeriksaan Terfokus (PART 01 Verification)

Pemeriksaan terfokus yang telah dijalankan pada branch `arena/daf49406-handyman-backend` setelah pemulihan commit `4a3bc7d` dan `a391a2e`:
1. `npm run typecheck` (`tsc --noEmit`): **PASS (0 errors)**
2. `npm run build` (`tsc`): **PASS (0 errors)**
3. `tests/handyman-contract-freeze-03-openapi.test.ts`: **PASS (13/13 tests, 280 Handyman operations at exact runtime parity)**
4. `tests/handyman-field-expense-reimbursement.test.ts` (Migrasi `0001..0471` pada disposable PostgreSQL 18.4): **PASS (3/3 subtests)**
5. `tests/handyman-helper-attendance-confirmation.test.ts` (Migrasi `0001..0471` pada disposable PostgreSQL 18.4): **PASS (3/3 subtests)**

---

## 7. Kesiapan PART 02 (PART 02 Readiness Checklist)

- [x] Commit `4a3bc7d` (Foto Nota & Reimbursement Petugas) dan `a391a2e` (Konfirmasi Kehadiran Helper) telah dipulihkan sebagai ancestor langsung dari `HEAD`.
- [x] Seluruh 5 permukaan (Assignment/Reassignment, Notifikasi `IN_APP`, Work Order Acknowledge, Mobile Feed, dan Status Operations) telah diaudit secara menyeluruh.
- [x] Kontrak eksisting `TERIMA` (`POST /api/v1/work-orders/:id/acknowledge`) dan gap `TIDAK_BISA` dengan alasan wajib telah teridentifikasi di ketiga jalur penugasan.
- [x] Aturan resolusi penerima notifikasi (Pekerja Individual vs Crew Lead `PIC_PEKERJAAN`) telah dipetakan secara presisi.
- [x] Desain migrasi `0472`, otorisasi `BE-02G`, state machine `PENDING -> TERIMA | TIDAK_BISA`, idempotency, dan penanganan race condition (`SELECT ... FOR UPDATE` + unique constraint) siap diimplementasikan pada **PART 02**.
