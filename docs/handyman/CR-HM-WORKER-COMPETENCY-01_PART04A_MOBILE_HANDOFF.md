# CR-HM-WORKER-COMPETENCY-01 — PART 04A — Handoff Frontend **Mobile** (Field Worker)

**Branch:** `arena/3df97f5e-handyman-backend`
**Basis runtime:** `d4a7aa3` (PART 03B2E) + perubahan PART 04A
**Tanggal:** 2026-10-23
**Sifat dokumen:** kontrak integrasi aplikasi Mobile. Semua endpoint sudah ada di runtime dan
diverifikasi lewat HTTP pada `tests/e2e-operational-lifecycle-04a.test.ts` (17/17), termasuk
acceptance → start → evidence → complete → attendance.

---

## 0. Peta perjalanan pekerja (yang sudah terbukti E2E)

```
Login
  │  GET  /handyman/field/me/profile               → identitas, provider, skill, sertifikat
  ├─▶ GET  /mobile/assignments                     → daftar pekerjaan (assignment id!)
  │     item.availableActions = ['ACKNOWLEDGE', …]
  ├─▶ POST /work-orders/{workOrderId}/acknowledge  → ASSIGNED
  ├─▶ POST /work-orders/{workOrderId}/start        → IN_PROGRESS
  ├─▶ POST /work-orders/{workOrderId}/evidence     → metadata foto (PHOTO/DOCUMENT/SIGNATURE)
  │   POST /evidence/{evidenceId}/file             → bytes + SHA-256 server-side
  │   GET  /work-orders/{workOrderId}/evidence-requirements → checklist bukti
  ├─▶ POST /work-orders/{workOrderId}/complete     → COMPLETED
  └─▶ (QC oleh Operations) → CLOSED
```

Attendance berdiri sendiri dan tidak menggerakkan status Work Order:
`POST /attendance/clock-in` → `GET /attendance/current` → `POST /attendance/clock-out`.

---

## 1. Identitas pekerja & kompetensi

### `GET /handyman/field/me/profile`

Profil pekerja yang login (resolusi dari sesi, bukan dari parameter).
**Otorisasi: authentication saja** (tanpa permission khusus) — profil diturunkan dari worker context
milik pemanggil; `404 HANDYMAN_WORKER_PROFILE_NOT_FOUND` bila pemanggil bukan pekerja lapangan.

Bentuk respons: `{ "data": { "profile": { … } } }` — **semua grup di bawah berada di dalam
`data.profile`**, bukan langsung di `data`.

| Grup | Field |
| --- | --- |
| `workerIdentity` | `userId`, `workforceProfileId`, `workerContextId`, `workerCode`, `employeeCode`, `fullName`, `email`, `phone`, `workforceType` (`INTERNAL`/`CONTRACT`/`FREELANCE`/`OUTSOURCED`/`EXTERNAL`), `employmentType`, `workerStatus` |
| `providerAssociation` | `clientId`, `providerContextId`, `providerType` (`DIRECT`/`VENDOR`), `providerCode`, `providerStatus`, `vendorId` (**`null` untuk DIRECT**), `vendorStatus`, `organizationId/Code/Name`, `bindingStatus`, `bindingEffectiveFrom/Until` |
| `roleAndAssignmentContext` | `authorizedRoles`, `crewMemberships[]` (`crewId`, `crewCode`, `isCrewLead`, `membershipStatus`, `joinedAt`), `buildingAssignments[]` (`buildingId`, `buildingCode`, `buildingName`, `assignmentRole`, `isPrimary`, `status`) |
| `skillsAndCategories` | `serviceCategories[]`, `effectiveSkills[]` (`skillId`, `code`, `name`, `category`, `proficiencyLevel`, `validFrom`, `validUntil`) |
| `certificationsAndExpiry` | `individualCertificateNumberModeled`, `individualCertifications[]`, `skillValidityWindows[]`, `providerLicensesAndCertifications[]` |
| `workHistorySummary` | `assignedExecutionScopesCount`, `activeWorkSessionsCount`, `completedWorkSessionsCount`, `activeInspectionsCount`, `completedInspectionsCount`, `recentWorkOrders[]` |

Catatan UI:

* Worker **multi-skill**: `effectiveSkills` berisi seluruh trade yang dikuasai. Jangan memfilter
  pekerjaan berdasarkan satu trade.
* Sertifikat bersifat individual (nomor, penerbit, masa berlaku, status verifikasi). Sertifikat
  `PENDING` belum memenuhi requirement `MANDATORY` — tampilkan sebagai "menunggu verifikasi".
* `providerType = 'DIRECT'` + `vendorId = null` adalah kondisi **normal** untuk pekerja Handyman
  (tetap/kontrak/freelance). Jangan menampilkan "vendor belum terdaftar".
* 404 `HANDYMAN_WORKER_PROFILE_NOT_FOUND` = user ini bukan pekerja lapangan.

Endpoint pelengkap: `GET /handyman/field/workers/{workerContextId}/profile` (profil rekan kerja;
authentication saja, visibilitas ditegakkan server-side dari worker context + assignment pemanggil),
`GET /workforce/{workforceId}/skills/effective` (`skill.read`),
`GET /workforce/{workforceId}/certifications` (`workforce_certification.read`).

---

## 2. Feed pekerjaan — `GET /mobile/assignments`

Query: `page`, `pageSize`, `shift` (`current` = hanya pekerjaan di Building shift aktif; nilai lain
`400 VALIDATION_ERROR`). Permission: **`task.read` + `work_order.read`** (keduanya).

Setiap item (`MobileAssignmentFeedItem`):

| Field | Arti |
| --- | --- |
| `id` | **id assignment** (`task_assignments` / `work_order_assignments`) — bukan id Work Order |
| `type` | `TASK` \| `WORK_ORDER` \| … |
| `status` | status authoritative pekerjaan (`OPEN`, `ASSIGNED`, `IN_PROGRESS`, …) |
| `assignee` | `assigneeType`, `workforceProfileId`, `teamId`, `assignedByUserId`, `assignedAt`, `assignmentStatus` |
| `context` | `clientId`, `buildingId/Code/Name`, `locations[]` |
| `schedule` | `occurrenceAt`, `dueAt` (selalu `null` untuk Work Order — belum ada SLA) |
| `reference` | untuk Work Order: **`reference.workOrderId`** |
| `availableActions` | aksi yang boleh dilakukan **sekarang** (dihitung backend, gated permission) |
| `shift` | konteks shift saat ini bila Building pekerjaan = Building shift aktif, jika tidak `null` |

> **Jebakan integrasi yang sudah terbukti:** id Work Order ada di `reference.workOrderId`, **bukan**
> `item.id`. Mencocokkan `item.id` dengan id Work Order menyebabkan pekerjaan tidak pernah ditemukan.

Nilai `availableActions` untuk Work Order: `ACKNOWLEDGE`, `START`, `HOLD`, `RESUME`, `ADD_NOTE`,
`CANCEL`, plus `COMPLETE` saat `IN_PROGRESS`, plus `CLOSE` hanya bila seluruh aturan penutupan
terpenuhi (dan `CLOSE` bukan pengganti `COMPLETE`).

**Aturan UI:** render tombol **hanya** dari `availableActions`. Jangan menghitung status sendiri;
status Work Order dipakai untuk label, bukan untuk mengaktifkan aksi.

---

## 3. Aksi eksekusi Work Order

| Method & path | Permission | Efek status | Catatan |
| --- | --- | --- | --- |
| `POST /work-orders/{workOrderId}/acknowledge` | `work_order.manage` | `OPEN` → `ASSIGNED` | body boleh kosong/`{}`; 201 |
| `POST /work-orders/{workOrderId}/start` | `work_order.manage` | `ASSIGNED` → `IN_PROGRESS` | 201 |
| `POST /work-orders/{workOrderId}/complete` | `work_order.manage` | `IN_PROGRESS` → `COMPLETED` | 201; tidak menutup WO |
| `POST /work-orders/{workOrderId}/hold` / `resume` / `cancel` / `notes` | `work_order.manage` | sesuai ACTION_RULES | tersedia bila ada di `availableActions` |
| `POST /work-orders/{id}/verification` | `work_order.manage` | QC | **Operations**, bukan Mobile |
| `POST /work-orders/{id}/close` | `work_order.manage` | `COMPLETED` → `CLOSED` | hanya setelah verifikasi `APPROVED` + BAST ready |

Aktor eksekusi harus **user pemilik assignment** (`workforce_profiles.user_id`) **dan** sesi punya
user-level Building assignment. Token admin/Operations **tidak** bisa mengeksekusi aksi lapangan —
ini disengaja, bukan bug. UI Mobile: bila `403`, tampilkan "pekerjaan ini bukan milik Anda".

Penolakan status tidak sah (mis. `start` saat `OPEN`) menghasilkan `409` dengan kode status action;
muat ulang feed setelah setiap `409`.

---

## 4. Foto / bukti lapangan

Ada **dua** jalur yang sudah ada; **tidak ada modul bukti baru** dan Mobile tidak boleh membuatnya.

### 4.1 Bukti terikat Work Order (dipakai pada E2E PART 04A)

| Endpoint | Permission | Isi |
| --- | --- | --- |
| `GET /work-orders/{workOrderId}/evidence-requirements` | `work_order.read` | requirement bukti (`evidenceType`, `required`, `minimumCount`, `maximumCount`, `description`) |
| `GET /work-orders/{workOrderId}/evidence` | `work_order.read` | bukti yang sudah terikat |
| `POST /work-orders/{workOrderId}/evidence` | `work_order.manage` | **metadata** bukti (201) |
| `PATCH /work-orders/{workOrderId}/evidence/{evidenceId}` | `work_order.manage` | soft remove |
| `POST /evidence/{evidenceId}/file` | **`evidence.manage`** | upload bytes (multipart `file`, maks 50 MB) |
| `GET /evidence/{evidenceId}/file/content` | `evidence.read` | unduh bytes |

Body `POST /work-orders/{id}/evidence`:

```json
{
  "evidenceType": "PHOTO",
  "fileReference": "field/before-<uuid>.jpg",
  "originalFileName": "before.jpg",
  "mimeType": "image/jpeg",
  "fileSize": 204800,
  "capturedAt": "2026-10-23T03:00:00.000Z"
}
```

`evidenceType`: `PHOTO` \| `DOCUMENT` \| `SIGNATURE`. `capturedAt` = waktu kamera (bukan waktu server).
Setelah metadata dibuat, unggah bytes ke `/evidence/{evidenceId}/file`; server menghitung
`contentSha256` sendiri (hash dari klien **tidak** diterima) dan mengembalikan metadata integritas.

> **Wajib diperhatikan:** peran lapangan harus memegang `work_order.manage` **dan** `evidence.manage`
> (plus `evidence.read` untuk pratinjau). Tanpa `evidence.manage`, metadata foto berhasil dibuat tetapi
> unggahan bytes ditolak `403`.

### 4.2 Field evidence (BEFORE / PROGRESS / AFTER dalam satu alur presign)

| Endpoint | Tujuan |
| --- | --- |
| `POST /handyman/field/evidence/presign` | buat intent + `uploadUrl` + `confirmUrl` |
| `PUT /handyman/field/evidence/{evidenceId}/bytes` | kirim bytes (≤ 15 MB) |
| `POST /handyman/field/evidence/{evidenceId}/confirm` | finalisasi |
| `GET /handyman/field/evidence/{evidenceId}` | metadata |
| `GET /handyman/field/evidence/{evidenceId}/content` | isi file |

`POST` presign (wajib: `purpose`, `originalFileName`, `mimeType`, `declaredByteSize`,
`idempotencyKey`; pilih **satu** parent: `executionScopeId` | `handymanRequestId` | `variationId` |
`materialPurchaseRecordId`):

```json
{
  "executionScopeId": "<uuid>",
  "purpose": "BEFORE_AFTER_WORK",
  "originalFileName": "before.jpg",
  "mimeType": "image/jpeg",
  "declaredByteSize": 204800,
  "notes": "Kondisi keran sebelum dikerjakan",
  "idempotencyKey": "<uuid-v4>"
}
```

* `purpose`: `VARIATION_FINDING` \| `MATERIAL_RECEIPT` \| `INSPECTION_EVIDENCE` \|
  `BEFORE_AFTER_WORK` \| `QC_EVIDENCE`.
* `mimeType`: `image/jpeg` \| `image/png` \| `image/webp` \| `application/pdf`.
* Bytes dikirim **apa adanya** (non-empty, signature file harus cocok). `idempotencyKey` wajib dan
  unik per unggahan; pengulangan dengan key sama = replay, bukan duplikat.
* `replayed: true` pada respons berarti intent sudah pernah dibuat — lanjutkan ke `uploadUrl`.
* Tidak ada `geotag`/koordinat di kontrak saat ini (lihat gap matrix PART 04A: NON-BLOCKER).

### 4.3 Batas kontrak yang perlu diketahui

`POST /mobile/evidence` (multipart) **tidak** menerima `executionType = 'WORK_ORDER'`. Nilai yang
sah: `FORM_INSTANCE`, `CHECKLIST_EXECUTION`, `FINDING`, `FINDING_REWORK`, `FINDING_VERIFICATION`,
`UTILITY_METER_READING`, `DAILY_CLEANING`. Foto Work Order **wajib** lewat 4.1 atau 4.2.

---

## 5. Attendance (sudah terbukti E2E)

| Endpoint | Permission | Body | Hasil |
| --- | --- | --- | --- |
| `POST /attendance/clock-in` | `attendance.manage` | `{ "buildingId": "<uuid>" }` | 201, `status = 'CLOCKED_IN'` |
| `GET /attendance/current` | `attendance.read` | – | 200, record terbuka |
| `POST /attendance/clock-out` | `attendance.manage` | – | 200, `status = 'CLOCKED_OUT'` |

* Profil pekerja diambil **dari sesi**; tidak ada `userId`/`workforceProfileId` di body.
* Clock-in ganda → `409 ATTENDANCE_ACTIVE_ALREADY_EXISTS`.
* Clock-out tanpa record terbuka → `409 ATTENDANCE_NOT_ACTIVE`.
* `clockInAt`/`clockOutAt` = waktu database; jam perangkat tidak pernah dipercaya.
* User tanpa workforce profile → `404 WORKFORCE_PROFILE_NOT_FOUND`.
* Building di luar scope → `403`; Building milik Client lain → `409 ATTENDANCE_BUILDING_CLIENT_MISMATCH`.

---

## 6. Permission minimum peran lapangan (bundle yang disarankan)

| Kebutuhan | Permission |
| --- | --- |
| Melihat daftar pekerjaan | `task.read`, `work_order.read` |
| Eksekusi (acknowledge/start/hold/resume/complete/notes) | `work_order.manage` |
| Metadata bukti Work Order | `work_order.manage` |
| Bytes bukti | `evidence.manage`, `evidence.read` |
| Field evidence presign/bytes/confirm | (diotorisasi konteks assignment, bukan permission terpisah) |
| Attendance | `attendance.manage`, `attendance.read` |
| Profil pekerja (milik sendiri / rekan dalam scope) | *authentication saja* — tanpa permission khusus |

---

## 7. Anti-pattern Mobile

1. Memakai `item.id` sebagai id Work Order (harus `reference.workOrderId`).
2. Menghitung/menebak `availableActions` dari `status` lokal.
3. Mengunggah foto lewat `/mobile/evidence` untuk pekerjaan Work Order.
4. Mengirim `contentSha256` dari klien (diabaikan/ditolak; server menghitung).
5. Menyimpan `clockInAt` dari jam perangkat.
6. Memblokir pekerja dari pekerjaan karena sertifikat trade lain (multi-skill).
7. Menampilkan error `409 WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED` sebagai kegagalan Mobile —
   itu keputusan Operations sebelum pekerjaan sampai ke Mobile.
