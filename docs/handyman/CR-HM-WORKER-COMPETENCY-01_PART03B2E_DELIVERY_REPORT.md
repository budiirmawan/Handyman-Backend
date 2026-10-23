# CR-HM-WORKER-COMPETENCY-01 — PART 03B2E Delivery Report

**Judul:** Work Order Classification Finalization — klasifikasi wajib sebelum assignment baru,
reklasifikasi aman, dan penutupan gap **G4**.

**Branch:** `arena/3df97f5e-handyman-backend` (lanjutan dari `e81ccca`, PART 03B2D).
**Basis:** PART 01, 02, 03A, 03B1, 03B2A, 03B2B, 03B2C, dan 03B2D (tidak diulang, tidak diubah).

**Status:** selesai — kode, migrasi, OpenAPI, test fokus, typecheck, build, dan parity check hijau.

---

## 1. Ringkasan

Pada PART 03B2A, klasifikasi trade sebuah Work Order bersifat **opsional**: Work Order yang belum
diklasifikasi tetap bisa di-assign, dan gate kompetensi hanya "tidak menemukan requirement apa pun".
Secara teknis itu bukan penolakan, tetapi juga bukan keputusan — hasilnya adalah **lolos tanpa verdict**.
Untuk Work Order yang lahir dari Customer Care (Service Request dengan `work_type` bebas ketikan, tanpa
Service Catalog), ini adalah lubang: pekerja bisa ditugaskan ke pekerjaan yang trade-nya belum pernah
diputuskan Operations.

PART 03B2E menutup lubang tersebut tanpa membuat otoritas kedua:

1. **`classificationRequired` adalah turunan, bukan kolom baru.** Work Order dianggap bagian siklus
   Handyman bila ada baris `tenant_service_requests` yang menunjuk ke sana (langsung lewat `work_order_id`
   atau lewat `work_request_id` bersama). Hanya Work Order seperti itu yang **wajib** diklasifikasikan.
   Work Order dari domain lain (Engineering/breakdown, `workType: 'REPAIR'`) tetap opsional — itulah sebabnya
   21 berkas test lama tetap hijau tanpa diubah.
2. **Penolakan eksplisit sebelum ada tulisan apa pun.** `assignWorkOrder()` dan `reassignWorkOrder()`
   memanggil `assertClassificationPresent()` sebelum transaksi dimulai ⇒ 409
   `WORK_ORDER_CLASSIFICATION_REQUIRED`, dengan pesan yang menyebut tindakan yang benar
   (`PATCH /work-orders/{id}/classification`, dan `GENERAL_REPAIR` sebagai pilihan eksplisit).
3. **Tidak ada auto-klasifikasi.** `GENERAL_REPAIR` adalah kategori yang sudah di-seed dan hanya dipakai bila
   Operations memilihnya. Tidak ada pemetaan `work_type` → trade, tidak ada tebakan dari judul/deskripsi SR.
4. **Reklasifikasi aman.** `classifyWorkOrder()` mengunci baris Work Order (`SELECT … FOR UPDATE`), membaca
   klasifikasi sebelumnya, lalu — bila trade/risk berubah dan ada assignment `ACTIVE` — memvalidasi ulang
   assignment tersebut dengan **evaluator yang sama** di dalam **transaksi yang sama**. Gap `MANDATORY`
   ⇒ 409 `WORK_ORDER_CLASSIFICATION_CONFLICT` + rollback penuh; selain itu keputusan dicatat di ledger
   sebagai aksi baru `RECLASSIFIED`.
5. **Tidak ada jalur assignment kedua, tidak ada evaluator kedua.** Semua reuse: `resolveAssignmentSubjects()`
   + `evaluateWorkOrderCompetency()` + `recordWorkOrderCompetencyDecision()` milik PART 03B2A.

---

## 2. PART A — Audit (ringkas)

| Temuan audit | Dampak | Tindakan |
|---|---|---|
| Work Order tanpa klasifikasi tetap assignable; gate mengembalikan `satisfied=true` karena tidak ada requirement | **Lolos tanpa verdict** — persis yang dilarang acceptance criteria | Ditutup dengan 409 `WORK_ORDER_CLASSIFICATION_REQUIRED` |
| `classifyWorkOrder()` menulis klasifikasi tanpa memeriksa assignment yang sedang berjalan | Reklasifikasi bisa membuat pekerjaan berjalan melanggar `MANDATORY` secara diam-diam | Lock + revalidasi in-transaction |
| Menghapus klasifikasi (`tradeCategoryId = null`) tidak diperiksa | Work Order aktif bisa kembali ke jalur tanpa gate | 409 `WORK_ORDER_CLASSIFICATION_CONFLICT` |
| Ledger hanya mengenal `ASSIGNED` / `REASSIGNED` | Revalidasi tidak punya jejak audit | Migrasi `0467` menambah `RECLASSIFIED` |
| Registry trade `GENERAL_REPAIR` sudah ada dan di-seed `LOW` | Tidak perlu kategori baru | Dipakai apa adanya |

Tidak ditemukan kebutuhan endpoint baru: klasifikasi sudah punya resource sendiri sejak PART 03B2A
(`GET`/`PATCH /work-orders/{id}/classification`) dan ledger sudah bisa dibaca
(`GET /work-orders/{id}/assignments/competency-decisions`).

---

## 3. PART B — Implementasi

### 3.1 Migrasi `0467_work_order_reclassification_decision` (aditif)

- `work_order_assignment_competency_decisions.action` — CHECK di-drop lalu dibuat ulang menjadi
  `('ASSIGNED', 'REASSIGNED', 'RECLASSIFIED')`.
- `down()` **menolak** rollback bila sudah ada baris `RECLASSIFIED` (ledger bersifat append-only dan
  triggernya menolak DELETE), sehingga rollback tidak pernah menghapus jejak keputusan.
- Terdaftar di `src/database/migrations/index.ts`.

### 3.2 `classificationRequired` (turunan)

`work-order-trade-category.repository.ts`:

```sql
EXISTS (
  SELECT 1 FROM tenant_service_requests tsr
   WHERE tsr.work_order_id = wo.id
      OR (wo.work_request_id IS NOT NULL AND tsr.work_request_id = wo.work_request_id)
) AS classification_required
```

Konsekuensi yang disengaja dan diuji:

- Work Order hasil konversi Customer Care ⇒ `classificationRequired = true`.
- Work Order yang dibuat langsung oleh Operations/Engineering ⇒ `false` (perilaku pra-03B2E dipertahankan).
- Nilai ini **tidak** bisa ditulis lewat API; ia selalu dihitung dari data, sehingga tidak ada dua sumber
  kebenaran untuk "apakah Work Order ini wajib klasifikasi".

### 3.3 Gate klasifikasi pada assignment

`work-order-assignment.service.ts`:

- `AssignableWorkOrder.classificationRequired: boolean`.
- `assertClassificationPresent(workOrder)` — satu fungsi, dipakai `assignWorkOrder()` **dan**
  `reassignWorkOrder()`, dipanggil **sebelum** `withTransaction()` sehingga penolakan tidak meninggalkan
  assignment, event, atau baris ledger.
- Error domain baru: `WORK_ORDER_CLASSIFICATION_REQUIRED` (409) dengan pesan
  *"Work order must be classified before it can be assigned. Choose the trade category with
  PATCH /work-orders/{workOrderId}/classification — GENERAL_REPAIR for a generic minor repair — and retry."*
- Deaktivasi assignment (`PATCH` tanpa assignee baru) **tidak** digerbangi: menghentikan penugasan tidak
  pernah butuh klasifikasi.

### 3.4 Revalidasi reklasifikasi (intinya PART ini)

`revalidateActiveAssignmentForClassification(executor, input)` — diekspor dari
`src/modules/work-order-assignments/index.ts`:

| Kondisi | Hasil |
|---|---|
| Tidak ada assignment `ACTIVE` | tidak ada yang divalidasi; klasifikasi murni berlaku untuk masa depan |
| Ada assignment `ACTIVE`, semua requirement `MANDATORY` terpenuhi | baris ledger `RECLASSIFIED`; assignment tetap `ACTIVE` dan **tidak** dibuat ulang |
| Ada assignment `ACTIVE`, gap `MANDATORY` | 409 `WORK_ORDER_CLASSIFICATION_CONFLICT` + `details[]` (orang × requirement × alasan × rule), seluruh perubahan klasifikasi rollback |
| Gap hanya `RECOMMENDED` | klasifikasi tetap; gap tercatat sebagai baris ledger `RECOMMENDED` yang tidak memblokir |

`classifyWorkOrder()` (`work-order-trade-category.service.ts`):

1. `lockWorkOrder(tx, workOrderId)` — `SELECT … FOR UPDATE` (serialisasi terhadap otoritas assignment).
2. Baca klasifikasi sebelumnya (`tradeCategoryId`, `riskLevel`, `classificationRequired`).
3. Bila `tradeCategoryId = null` **dan** `classificationRequired` **dan** ada assignment `ACTIVE` ⇒ 409
   (`details[0].reason = 'ACTIVE_ASSIGNMENT_REQUIRES_CLASSIFICATION'`).
4. Tulis klasifikasi baru.
5. Bila trade atau risk berubah **dan** klasifikasi tidak dikosongkan ⇒ revalidasi (tabel di atas).
6. Catat event operasional `WORK_ORDER_CLASSIFIED` / `WORK_ORDER_CLASSIFICATION_CLEARED` dengan metadata
   `previousTradeCategoryId`, `previousRiskLevel`, dan `revalidation` (`assignmentId`, `satisfied`,
   `mandatoryRequirementCount`, `advisoryCount`) — audit bisa menjawab "mengapa assignment yang berjalan
   masih valid di bawah trade baru?".

Menyimpan klasifikasi yang **sama** (trade + risk identik) adalah **no-op** untuk ledger: tidak ada baris
`RECLASSIFIED` palsu.

### 3.5 Kosakata keputusan

- `WorkOrderCompetencyDecisionAction = 'ASSIGNED' | 'REASSIGNED' | 'RECLASSIFIED'`
  (`worker-competency-eligibility.types.ts`, diekspor dari index modul).
- Filter ledger `GET /work-orders/{id}/assignments/competency-decisions?action=` menerima `RECLASSIFIED`;
  nilai tak dikenal tetap **400** (bukan halaman kosong yang menyesatkan).
- Filter pada endpoint execution-scope (`…/execution-scopes/{id}/competency/history`) **tidak** diubah:
  ledger tersebut tidak pernah menulis `RECLASSIFIED`.

### 3.6 Yang **tidak** diubah

- Tidak ada endpoint baru, tidak ada operasi OpenAPI baru (parity 2.014 operasi tetap 20/20).
- Tidak ada evaluator kedua, tidak ada jalur assignment kedua.
- Aturan MULTI-SKILL (03B2B) dan model pekerja langsung/freelance (03B2D) tetap utuh: tidak ada perbandingan
  trade pekerja vs trade Work Order, tidak ada sertifikasi wajib global, `RECOMMENDED` tetap warning.
- Super User, password, dan data produksi tidak disentuh.

---

## 4. Perubahan API (`docs/api/openapi.yaml`)

| Lokasi | Perubahan |
|---|---|
| `POST /work-orders/{id}/assignments` | response `409` + deskripsi 03B2E (klasifikasi wajib) |
| `PATCH /work-orders/{id}/assignments/{assignmentId}` | deskripsi reassign memakai gate yang sama + response `409` |
| `PATCH /work-orders/{id}/classification` | deskripsi reklasifikasi aman + `x-error-codes` ditambah `WORK_ORDER_CLASSIFICATION_CONFLICT`; arti `tradeCategoryId: null` diperjelas |
| `components.schemas.WorkOrderClassification` | `classificationRequired` (boolean, wajib) + `required[]` + deskripsi |
| `components.schemas.WorkOrderAssignmentCompetencyDecision.action` | `enum: [ASSIGNED, REASSIGNED, RECLASSIFIED]` + deskripsi |
| Query `action` pada `…/competency-decisions` | `enum` ditambah `RECLASSIFIED` |

---

## 5. PART C — Pengujian

Suite baru: **`tests/work-order-classification-03b2e.test.ts`** — **18/18 lulus**
(embedded PostgreSQL, port 55666, data dir dihapus setiap run).

| Grup | Test | Yang dibuktikan |
|---|---|---|
| E1 | free-text Customer Care ⇒ Work Order tanpa klasifikasi | `requestType` bebas ketikan jadi `work_type`, `tradeCategoryId = null`, `classificationRequired = true` |
| E1 | assignment baru ditolak saat belum diklasifikasi | 409 `WORK_ORDER_CLASSIFICATION_REQUIRED`; tabel assignment **dan** ledger tetap kosong |
| E1 | reassignment ditolak saat belum diklasifikasi | 409; assignment lama tetap `ACTIVE` pada orang yang sama |
| E1 | `GENERAL_REPAIR` eksplisit | tidak ada klasifikasi otomatis; setelah dipilih, assignment berhasil, ledger tetap kosong (kategori tanpa requirement) |
| E2 | pekerja bersertifikat AC mengambil pekerjaan plumbing | multi-skill utuh — sertifikat/trade lain tidak pernah menolak |
| E2 | `RECOMMENDED` tidak terpenuhi | assignment **berhasil** + `competency.advisory` berisi 1 item (`SKILL_MISSING`) |
| E2 | pekerja `FREELANCE` | ditugaskan lewat gate yang sama, tanpa vendor |
| E3 | reklasifikasi yang membuka gap `MANDATORY` | 409 `WORK_ORDER_CLASSIFICATION_CONFLICT` + `details[]`; klasifikasi, assignment, dan ledger **identik** dengan sebelum percobaan (rollback) |
| E3 | reklasifikasi yang tetap terpenuhi | assignment tidak dibuat ulang, tetap `ACTIVE`; tepat 1 baris ledger `RECLASSIFIED` dengan trade baru; metadata event berisi `previousTradeCategoryId` + `revalidation.assignmentId` |
| E3 | reklasifikasi dengan gap `RECOMMENDED` | klasifikasi berhasil, baris `RECLASSIFIED` `satisfied = false` (`SKILL_MISSING`), tidak memblokir |
| E3 | menghapus klasifikasi Work Order wajib yang masih aktif | 409 `WORK_ORDER_CLASSIFICATION_CONFLICT` |
| E3 | reklasifikasi tanpa assignment aktif / penghapusan klasifikasi | tidak ada baris ledger; penghapusan diizinkan |
| E4 | Work Order non-Customer-Care | `classificationRequired = false`, assignment tanpa klasifikasi tetap berhasil |
| E4 | Work Order lama yang sudah assigned | tetap terbaca (`…/assignments/current`, ledger); menyimpan klasifikasi identik tidak menulis ledger |
| E4 | filter `action=BOGUS` / `action=RECLASSIFIED` | 400 untuk nilai tak dikenal, 1 baris `RECLASSIFIED` untuk nilai baru |
| E5 | aktor ber-permission tetapi di luar Building scope | 403 pada klasifikasi **dan** assignment; tidak ada perubahan data |
| E5 | hanya `work_order.read` | 403 pada klasifikasi |

### Regression fokus (dijalankan ulang, semuanya hijau)

| Suite | Hasil |
|---|---|
| `tests/work-order-multitrade-03b2a.test.ts` | 17/17 |
| `tests/work-order-multiskill-03b2b.test.ts` | 11/11 |
| `tests/handyman-direct-workforce-03b2d.test.ts` | 20/20 |
| `tests/openapi-contract.test.ts` | 7/7 |
| `tests/handyman-contract-freeze-03-openapi.test.ts` | 13/13 |

### Gate statis

- `npm run typecheck` ⇒ **0 error**
- `npm run build` ⇒ **0 error**
- `docs/api/openapi.yaml` ⇒ parse YAML OK; parity OpenAPI **20/20**

---

## 6. Berkas yang berubah

| Berkas | Perubahan |
|---|---|
| `src/database/migrations/0467_work_order_reclassification_decision.ts` | **baru** — CHECK `action` + guarded `down()` |
| `src/database/migrations/index.ts` | registrasi `0467` |
| `src/shared/errors.ts` | `WORK_ORDER_CLASSIFICATION_REQUIRED`, `WORK_ORDER_CLASSIFICATION_CONFLICT` |
| `src/modules/work-order-assignments/work-order-assignment.errors.ts` | dua factory error baru (409) |
| `src/modules/work-order-assignments/work-order-assignment.service.ts` | `classificationRequired`, `assertClassificationPresent()`, `AssignmentSubjectTarget`, `CompetencyGateWorkOrder`, `revalidateActiveAssignmentForClassification()` |
| `src/modules/work-order-assignments/work-order-assignment.validation.ts` | filter `action` menerima `RECLASSIFIED` |
| `src/modules/work-order-assignments/index.ts` | ekspor fungsi revalidasi |
| `src/modules/work-order-trade-categories/work-order-trade-category.types.ts` | `WorkOrderClassificationRecord.classificationRequired` |
| `src/modules/work-order-trade-categories/work-order-trade-category.repository.ts` | `classification_required` turunan + `lockWorkOrder()` |
| `src/modules/work-order-trade-categories/work-order-trade-category.errors.ts` | `workOrderClassificationClearBlockedError()` |
| `src/modules/work-order-trade-categories/work-order-trade-category.service.ts` | `classifyWorkOrder()`: lock, klasifikasi sebelumnya, blokir penghapusan, revalidasi, metadata audit |
| `src/modules/worker-competency-eligibility/*` | `WorkOrderCompetencyDecisionAction` (types, repository, service, index) |
| `docs/api/openapi.yaml` | schema klasifikasi, enum ledger, 409 + deskripsi assign/reassign/classify |
| `docs/handyman/CR-HM-WORKER-COMPETENCY-01_PART03B_BACKLOG.md` | item 13 / **G4** ditutup + catatan 03B2E |
| `tests/work-order-classification-03b2e.test.ts` | **baru** — 18 test |

Tidak ada perubahan pada layar Mobile, payroll, fee, absensi, evidence, atau completion: audit menunjukkan
tidak ada regresi pada lingkup tersebut, dan tidak ada kode di sana yang bergantung pada klasifikasi.

---

## 7. Catatan kegagalan yang **bukan** regresi PART 03B2E

- `tests/handyman-crew-worker-admission.test.ts` (8 kegagalan, `service_catalog` tidak ada pada fixture) dan
  `tests/handyman-visit-booking-authority.test.ts` (0/7) sudah gagal sebelum PART ini — di luar lingkup.
- Pin/`openapi-operational-*`, `deployment-cors-production`, `r08-*`, `handyman-scope-assignments-api`
  (t10), `openapi-saas-route-parity` (t15) adalah pin usang yang tidak diperbaiki di PART ini; gate nyata
  adalah dua suite OpenAPI di atas.

---

## 8. Aturan yang harus dipertahankan setelah PART ini

1. Jangan pernah menyimpulkan trade dari `work_type` bebas ketikan Customer Care, dari judul, atau dari
   deskripsi Service Request — klasifikasi adalah keputusan Operations.
2. Jangan pernah membiarkan gate kompetensi "lulus" untuk Work Order yang belum diklasifikasi; penolakan
   harus terjadi **sebelum** tulisan apa pun.
3. Jangan menjadikan klasifikasi wajib untuk Work Order di luar siklus Handyman (Engineering/breakdown):
   `classificationRequired` tetap turunan dari `tenant_service_requests`.
4. Setiap perubahan klasifikasi pada Work Order yang punya assignment `ACTIVE` wajib divalidasi ulang dengan
   **evaluator yang sama**, di transaksi yang sama, dan harus rollback bila ada gap `MANDATORY`.
5. Ledger tetap append-only; jangan pernah menambah UPDATE/DELETE atau "koreksi" baris historis.
6. Tetap satu otoritas assignment (`work-order-assignment.service.ts` + `handyman-scope-assignment.service.ts`)
   dan satu evaluator (`worker-competency-eligibility`).

---

## 9. Audit ulang independen (verifikasi PART 03B2E yang sudah ada)

Bagian ini ditambahkan saat PART 03B2E diaudit ulang terhadap daftar acceptance criteria, dengan
`d4a7aa3` sebagai titik masuk. Hasilnya: seluruh kriteria sudah terpenuhi oleh implementasi yang ada —
**tidak ada perubahan aturan bisnis baru** yang diperlukan. Satu kekurangan *bukti* ditemukan dan ditutup
(lihat butir 10).

| # | Acceptance criterion | Bukti di kode | Bukti di test |
|---|---|---|---|
| 1 | Audit klasifikasi + gate kompetensi | `work-order-trade-category.service.ts`, `work-order-assignment.service.ts` | E1–E5 |
| 2 | Service Request tanpa trade teknis tetap diterima | `requestType` bebas → `work_type` (`tenant-service-request.service.ts` L248) | E1-1 |
| 3 | Klasifikasi wajib sebelum assignment **baru** | `assertClassificationPresent()` dipanggil sebelum `withTransaction()` di `assignWorkOrder` (L559) dan `reassignWorkOrder` (L685) | E1-2, E1-3 |
| 4 | Tidak boleh lolos gate secara diam-diam | 409 `WORK_ORDER_CLASSIFICATION_REQUIRED`, tanpa tulisan apa pun | E1-2 (assignment + ledger tetap kosong) |
| 5 | `GENERAL_REPAIR` hanya bila dipilih Operations | registry trade di-seed; tidak ada pemetaan otomatis dari `work_type` | E1-4 |
| 6 | Tanpa pembatasan trade pekerja vs trade WO | tidak ada perbandingan trade; 03B2B dipertahankan | E2-1 |
| 7 | Hanya `MANDATORY` memblokir, `RECOMMENDED` peringatan | `applyCompetencyGate` + `advisory[]` | E2-2 |
| 8 | Perubahan klasifikasi saat assignment `ACTIVE` aman | `lockWorkOrder` + `revalidateActiveAssignmentForClassification()` | E3-1 (rollback), E3-2 (`RECLASSIFIED`), E3-3 (advisory) |
| 9 | Reuse direct workforce (03B2D) + evaluator 03A | `resolveAssignmentSubjects` + `evaluateWorkOrderCompetency` | E2-3 |
| 10 | Isolasi Client/Building, transaksi, ledger, kompatibilitas historis | klausa `EXISTS` pada `classificationRequired`; lock + satu transaksi | E4-*, E5-*, **E4-5 (baru)** |
| 11 | Regression test fokus | — | 19 test di `work-order-classification-03b2e.test.ts` |
| 12 | typecheck / build / test fokus | `tsc --noEmit`, `tsc` | 0 error / 0 error |

### 9.1 Bukti tambahan: kompatibilitas Work Order historis (E4-5)

Sebelumnya kompatibilitas historis hanya dibuktikan secara tidak langsung (assignment lama tetap terbaca).
Ditambahkan satu test yang membuktikan batas aturan secara eksplisit:

1. Work Order Customer Care diklasifikasi, lalu di-assign (assignment `ACTIVE`).
2. Klasifikasi dihapus langsung di database — merepresentasikan data lama yang dibuat **sebelum** PART ini.
3. **Keputusan assignment baru tetap ditolak** (409 `WORK_ORDER_CLASSIFICATION_REQUIRED`).
4. **Pekerjaan yang sudah berjalan tetap dapat dieksekusi penuh**: `acknowledge` → `start` → unggah evidence
   `PHOTO` → `complete`, dan status akhir `COMPLETED`.

Aturan ini dengan demikian bersifat **maju (forward-only)**: ia menggerbangi keputusan penugasan baru, tidak
pernah membalikkan pekerjaan yang sedang berjalan.

### 9.2 Hasil verifikasi ulang (2026-10-23, PostgreSQL 18.4 disposable)

| Gate | Hasil |
|---|---|
| `tests/work-order-classification-03b2e.test.ts` | **19/19** (sebelumnya 18; +1 test kompatibilitas) |
| `tests/work-order-multitrade-03b2a.test.ts` | 17/17 |
| `tests/work-order-multiskill-03b2b.test.ts` | 11/11 |
| `tests/handyman-direct-workforce-03b2d.test.ts` | 20/20 |
| `tests/openapi-contract.test.ts` + `handyman-contract-freeze-03-openapi.test.ts` | 20/20 |
| `npm run typecheck` / `npm run build` | 0 error / 0 error |

### 9.3 Batas yang disengaja (bukan gap)

- Kewajiban klasifikasi hanya berlaku untuk Work Order yang berasal dari Customer Care
  (`tenant_service_requests`). Work Order Engineering/breakdown tidak memakai registry trade Handyman,
  sehingga klasifikasinya tetap opsional. Ini keputusan kompatibilitas yang eksplisit, bukan kelalaian.
- Endpoint eksekusi (`acknowledge`/`start`/`evidence`/`complete`) sengaja **tidak** memeriksa klasifikasi:
  satu-satunya gerbang adalah keputusan penugasan. Lihat E4-5.
