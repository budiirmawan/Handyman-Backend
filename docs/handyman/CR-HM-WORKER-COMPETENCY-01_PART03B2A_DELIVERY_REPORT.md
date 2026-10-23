# CR-HM-WORKER-COMPETENCY-01 — PART 03B2A Delivery Report

**Judul:** Multi-Trade Handyman Work Order — klasifikasi trade Work Order yang dapat dikonfigurasi + penegakan
kompetensi pada assignment Work Order.
**Branch:** `arena/3df97f5e-handyman-backend` (basis PART 03B1 `e6845a7`).
**Tanggal:** 2026-10-23.
**Status:** implementasi selesai, `typecheck` + `build` bersih, 17/17 test fokus PART 03B2A hijau,
seluruh route runtime baru sudah terdokumentasi di `docs/api/openapi.yaml` (paritas 1:1).
Tidak ada PR, tidak ada merge, tidak ada deploy, tidak ada perubahan produksi.

---

## 1. Ringkasan satu paragraf

Handyman adalah platform **multi-trade** light repair, bukan layanan AC saja. Sebelum PART ini `work_orders`
tidak punya konsep trade/klasifikasi apa pun (`work_type` hanya teks bebas) sehingga requirement kompetensi
PART 03A hanya bisa melekat pada entri Service Catalog — padahal Work Order adalah jalur kerja yang paling
banyak dipakai. PART 03B2A menambahkan (a) **registry trade yang berupa data** (11 trade ter-seed, dapat
ditambah tanpa deploy), (b) **klasifikasi Work Order yang otoritatif** (trade + risk level + jejak siapa/kapan,
diputuskan Operations pada alur triage yang sudah ada), (c) **requirement kompetensi per trade per Client**
(memakai model requirement PART 03A yang sama, dua target: entri katalog atau trade), dan (d) **satu gerbang
kompetensi** yang dijalankan **di dalam transaksi assignment** pada jalur `work-order-assignments` yang sudah
ada — tanpa jalur assignment kedua. Sertifikasi tetap tidak pernah menjadi wajib global: hanya wajib bila
dikonfigurasi eksplisit (atau diminta aturan safety/regulasi yang nanti memetakan ke requirement yang sama).

---

## 2. Audit singkat kondisi sebelum PART 03B2A

| Area | Temuan | Konsekuensi |
| --- | --- | --- |
| `work_orders.work_type` (migrasi `0082`) | `TEXT` bebas, tanpa relasi ke `service_catalog` | Requirement katalog tidak pernah berlaku pada Work Order |
| Skema `work_orders` | Tidak ada kolom trade/kategori/risk level | Tidak ada dasar pemetaan skill/kebutuhan sertifikat |
| Assignment Work Order (`work-order-assignment.service.ts`) | 4 tipe assignee: `WORKFORCE`, `TEAM`, `VENDOR`, `VENDOR_WORKFORCE`; satu assignment `ACTIVE` per Work Order (partial unique index) | Satu-satunya titik penegakan yang benar; jangan diduplikasi |
| Transaksi assignment | `create` + `recordWorkOrderEvent` berjalan terpisah (pool) | Perlu dibungkus `withTransaction` agar rollback nyata |
| Triage/diagnosis | Ada pada `handyman-requests` (Customer Care) dan alur inspeksi Handyman; Work Order lahir dari konversi Service Request | Klasifikasi final harus menjadi keputusan Operations, bukan input Customer Care |
| Requirement kompetensi (`service_competency_requirements`, PART 03A) | Hanya target `service_catalog_id` | Perlu digeneralisasi menjadi dua target (XOR) |
| Evaluator (`worker-competency-eligibility`, PART 03A) | Berbasis crew (`handyman_work_crew`) | Perlu entry point baru berbasis **subject** (individu/anggota team) untuk Work Order, memakai aturan requirement yang sama |
| Ledger keputusan | `handyman_assignment_competency_evaluations` (PART 03B1) terikat pada execution scope | Work Order butuh ledger sendiri dengan bentuk data yang sama |

**Kesimpulan audit:** tidak ada jalur yang bisa dipakai ulang untuk Work Order tanpa generalisasi requirement +
entry point evaluator baru. Tidak ada jalur assignment kedua yang dibuat.

---

## 3. Keputusan desain (dan alasannya)

1. **Trade adalah data, bukan enum.** `work_order_trade_categories` disimpan di database dan ter-seed 11 trade
   (AC, plumbing, electrical minor, sanitary, door/lock, furniture, painting, ceiling, tiling, installation,
   generic repair). Menambah "pool equipment" adalah operasi konfigurasi (`POST`), bukan deploy.
2. **Klasifikasi opsional secara konstruksi.** Work Order tanpa klasifikasi tetap assignable persis seperti
   sebelum PART ini. Ini menjaga requirements 8 dan 10 (tidak ada regresi, tidak ada blokir baru).
3. **Satu tabel requirement, dua target.** `service_catalog_id` menjadi NULLABLE dan ditambah
   `trade_category_id`, dengan CHECK XOR. Model, validasi, dan evaluator PART 03A dipakai ulang; tidak ada
   tabel atau aturan requirement kedua.
4. **Requirement per trade bersifat per Client.** Registry trade bersifat platform-wide, requirement-nya
   milik Client dan diverifikasi lewat `canAccessClient` milik pemanggil. Client A tidak bisa memblokir
   assignment Client B pada trade yang sama.
5. **Gerbang dijalankan di dalam transaksi assignment.** Assignment, event history, dan baris ledger keputusan
   commit bersama; refusal (409) me-rollback ketiganya. Tidak ada assignment "setengah jadi".
6. **Aturan ALL/ANY mengikuti bentuk assignee.** `WORKFORCE`, `VENDOR_WORKFORCE`, `TEAM` → **ALL** (setiap
   subjek harus memenuhi, sama dengan aturan crew PART 03A). `VENDOR` (perusahaan) → **ANY** (minimal satu
   worker terikat yang memenuhi), karena penugasan tingkat perusahaan tidak menunjuk orang tertentu.
7. **RECOMMENDED hanya saran.** Hanya `MANDATORY` yang memblokir; `RECOMMENDED` tercatat di ledger dan di
   metadata event sebagai advisory.
8. **Risk level deskriptif, bukan mesin aturan.** `risk_level` (LOW/MEDIUM/HIGH) melekat pada trade dan dapat
   di-override Operations per Work Order. Ia belum otomatis menurunkan requirement — pemetaan itu tetap
   eksplisit (lihat §8 gap G3).
9. **Ledger tanpa data sensitif.** Hanya id sertifikat opaque, status verifikasi, tanggal kedaluwarsa, dan
   level proficiency. Tidak ada nomor sertifikat, document id, storage key, atau isi dokumen.

---

## 4. Perubahan yang dikirim

### 4.1 Migrasi `0465_work_order_multitrade_classification`

Terdaftar di `src/database/migrations/index.ts` (import + array). Isi:

1. `work_order_trade_categories` — `code` unik (regex `^[A-Z][A-Z0-9_]{1,39}$`), `name` ≤120, `description`
   ≤500, `risk_level` (LOW/MEDIUM/HIGH, default LOW), `handyman_discipline_id` (FK ke registry F9),
   `status` (ACTIVE/INACTIVE), `created_by_user_id`, timestamps, index `(status, code)`.
2. Seed 11 trade multi-trade (AIR_CONDITIONING/MEDIUM, PLUMBING/MEDIUM, ELECTRICAL_MINOR/HIGH, SANITARY/MEDIUM,
   DOOR_LOCK/LOW, FURNITURE/LOW, PAINTING/LOW, CEILING/MEDIUM, TILING/MEDIUM, INSTALLATION/LOW,
   GENERAL_REPAIR/LOW) — idempoten (`ON CONFLICT (code) DO NOTHING`).
3. `work_orders` + `trade_category_id`, `trade_category_code`, `risk_level`, `classified_at`,
   `classified_by_user_id`; CHECK pasangan (dua-duanya atau tidak sama sekali), CHECK risk, index
   `(trade_category_id, status, created_at)`.
4. `service_competency_requirements` digeneralisasi: `service_catalog_id` NULLABLE + `trade_category_id`,
   CHECK XOR, unique partial index per (trade, skill) dan (trade, certificate), dan `_scope_guard()` yang
   memvalidasi kecocokan Client katalog **atau** keberadaan trade.
5. `work_order_assignment_competency_decisions` — 24 kolom, append-only (trigger
   `work_order_competency_history_block_mutation()` menolak UPDATE/DELETE), CHECK outcome, 3 index.
6. Rollback (`down`) lengkap dan simetris.

### 4.2 Modul baru `src/modules/work-order-trade-categories`

`repository`, `service`, `controller`, `routes`, `validation`, `types`, `index`. Endpoint yang di-mount di
`src/routes/index.ts`:

| Method + path | Permission | Keterangan |
| --- | --- | --- |
| `GET /work-order-trade-categories` | `work_order.read` | filter `status`, `riskLevel`, `handymanDisciplineId` |
| `POST /work-order-trade-categories` | `work_order.manage` | 201; duplikat → 409 `WORK_ORDER_TRADE_CATEGORY_ALREADY_EXISTS` |
| `GET /work-order-trade-categories/:tradeCategoryId` | `work_order.read` | 404 `WORK_ORDER_TRADE_CATEGORY_NOT_FOUND` |
| `PATCH /work-order-trade-categories/:tradeCategoryId` | `work_order.manage` | `code` immutable (400) |
| `POST /work-order-trade-categories/:tradeCategoryId/deactivate` | `work_order.manage` | `status = INACTIVE`, tidak menghapus baris |
| `GET /work-orders/:id/classification` | `work_order.read` | + Building access Work Order |
| `PATCH /work-orders/:id/classification` | `work_order.manage` | + Building access; `tradeCategoryId: null` = clear; menulis event `WORK_ORDER_CLASSIFIED` |

### 4.3 Requirement kompetensi dua target

`service-competency-requirements` diperluas tanpa endpoint lama berubah perilaku:

| Method + path | Permission / scope |
| --- | --- |
| `GET/POST /work-order-trade-categories/:tradeCategoryId/competency-requirements` | `work_order.read` / `work_order.manage` + `clientId` eksplisit yang benar-benar dapat diakses pemanggil |
| `GET/PATCH/POST .../:requirementId(/deactivate)` | idem |

`clientId` wajib dan diverifikasi (`403 BUILDING_ACCESS_DENIED` bila di luar jangkauan); skill milik Client lain
ditolak `400 SERVICE_COMPETENCY_REQUIREMENT_SKILL_MISMATCH`.

### 4.4 Evaluator & ledger Work Order (`worker-competency-eligibility`)

Tambahan (tanpa mengubah fungsi PART 03A yang sudah dipakai execution scope):

- `evaluateWorkOrderCompetency(executor, { clientId, tradeCategoryId, tradeCategoryCode, subjects, rule })`
  → `WorkOrderCompetencyDecision { summary, rule, satisfied, blocking[], advisory[], rows[] }`.
  Trade tanpa requirement ACTIVE (atau Work Order tanpa klasifikasi) menghasilkan `satisfied: true`, `rows: []`
  dan **tidak menulis apa pun**.
- `recordWorkOrderCompetencyDecision(executor, {...})` → menulis baris ledger di transaksi yang sama, satu
  `decision_group_id` per keputusan.
- `listWorkOrderAssignmentCompetencyHistory` → read model paginasi.
- `workOrderCompetencyService` sebagai facade + type publik (`WorkOrderCompetencySubject`,
  `WorkOrderCompetencyDecisionRow`, `WorkOrderCompetencyHistoryItem`, dll).
- Repository baru `work-order-competency-decision.repository.ts` (append-only, 24 kolom).

### 4.5 Penegakan pada jalur assignment Work Order

`work-order-assignment.service.ts`:

- `loadAssignableWorkOrder` sekarang juga memuat klasifikasi (`tradeCategoryId`, `tradeCategoryCode`,
  `riskLevel`).
- `resolveAssignmentSubjects` memetakan assignee → subjek: `WORKFORCE`/`VENDOR_WORKFORCE` (1 subjek, ALL),
  `TEAM` (semua anggota ACTIVE, ALL), `VENDOR` (semua workforce ACTIVE yang terikat dan satu Client dengan
  Work Order, ANY).
- `applyCompetencyGate` memanggil evaluator, melempar `409 WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED` dengan
  `details[]` lengkap, atau menulis ledger dan mengembalikan ringkasan.
- `assignWorkOrder` dan `reassignWorkOrder` dibungkus `withTransaction`: assignment + event + ledger commit
  bersama; deaktivasi assignment lama pada reassignment juga ikut rollback.
- Event history `WORK_ORDER_ASSIGNED` / `WORK_ORDER_REASSIGNED` sekarang membawa metadata
  `tradeCategoryId`, `tradeCategoryCode`, `riskLevel`, dan `competency` (ringkasan evaluasi).
- Endpoint baru `GET /work-orders/:id/assignments/competency-decisions` (`work_order.read` + Building access),
  filter `action|assignmentId|workforceProfileId|satisfied|enforcementLevel`, paginasi opsional
  (`page`/`pageSize`); tanpa parameter paginasi `meta` = `{}` mengikuti kontrak list standalone yang berlaku.

### 4.6 Kode error baru (`src/shared/errors.ts`)

`WORK_ORDER_TRADE_CATEGORY_NOT_FOUND`, `WORK_ORDER_TRADE_CATEGORY_ALREADY_EXISTS`,
`WORK_ORDER_TRADE_CATEGORY_INVALID_STATE`, `WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED`.

### 4.7 OpenAPI

`docs/api/openapi.yaml` +13 operasi, seluruhnya sudah ada di runtime (paritas kanonik 1:1, hanya `GET /`
infrastruktur yang dikecualikan seperti sebelumnya): 8 operasi registry/klasifikasi/ledger + 5 operasi
requirement per trade. Skema baru: `WorkOrderTradeCategory`, `CreateWorkOrderTradeCategoryRequest`,
`UpdateWorkOrderTradeCategoryRequest`, `ClassifyWorkOrderRequest`, `WorkOrderClassification`,
`WorkOrderAssignmentCompetencyDecision`; parameter `TradeCategoryIdPath`; `ServiceCompetencyRequirement`
diperluas (`tradeCategoryId`, `serviceCatalogId` nullable). Tidak ada `operationId` duplikat, tidak ada `$ref`
lokal yang rusak.

---

## 5. Bukti pengujian

### 5.1 Suite baru `tests/work-order-multitrade-03b2a.test.ts` — 17 test, 16 describe (T1–T16)

Cluster PostgreSQL embedded sendiri (`/tmp/hm-multitrade-03b2a-pg`, port `55662`, database `asentra_test`),
migrasi penuh dijalankan dari nol, **tanpa TRUNCATE** agar seed migrasi tidak hilang.

| # | Fokus | Pemetaan requirement |
| --- | --- | --- |
| T1 | Registry multi-trade: 11 seed ada, tambah trade baru 201, duplikat 409, `code` immutable 400, deactivate 200, trade INACTIVE tidak bisa mengklasifikasi (409) | 4 |
| T2 | Klasifikasi: default risk dari trade, override risk, clear dengan `null`, event `WORK_ORDER_CLASSIFIED`, isolasi lintas Building, Work Order terminal ditolak | 3, 5, 11 |
| T3 | AC: requirement SKILL MANDATORY memblokir worker tanpa skill, ledger ditulis saat lolos, rollback penuh saat ditolak | 6, 7, 10, 11 |
| T4 | Plumbing: sertifikat wajib **hanya karena dikonfigurasi** (bukan global) | 7, 9 |
| T5 | Electrical minor: sertifikat kedaluwarsa ditolak (`CERTIFICATION_EXPIRED`) | 7 |
| T6 | Door repair & painting: trade tanpa requirement tetap assignable, gap RECOMMENDED hanya saran | 8, 9 |
| T7 | Generic miscellaneous repair: team tanpa requirement tetap assignable | 8, 12 |
| T8 | Multi-worker crew: setiap anggota ACTIVE harus memenuhi (rule ALL) | 6 |
| T9 | Vendor: minimal satu worker terikat memenuhi (rule ANY), bukan semua | 6, 10 |
| T10 | Reassignment: ditolak bila tidak memenuhi, assignment ACTIVE lama tetap utuh | 6, 11 |
| T11 | Integritas ledger: hanya bukti minimum, UPDATE/DELETE ditolak trigger append-only | 11 |
| T12 | Endpoint ledger: auth, Building-scoped, filter, paginasi, 403 untuk Building asing | 11 |
| T13 | Backward compatibility: Work Order tanpa klasifikasi berperilaku persis seperti sebelumnya | 8, 10 |
| T14 | Tenant → Customer Care → Service Request → Work Order → klasifikasi → assignment, **tanpa Service Catalog** (`service_catalog` 0 baris) | 1, 2, 13 |
| T15 | Isolasi konfigurasi antar Client (requirement Client lain tidak berlaku) | 11 |
| T16 | RBAC: `work_order.read`/`work_order.manage`, permission lebih luas tidak menggantikan | 11 |

Perintah:

```bash
NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1 tests/work-order-multitrade-03b2a.test.ts
# # tests 17   # pass 17   # fail 0
```

### 5.2 Regresi terfokus (dijalankan pada PostgreSQL embedded disposable)

| Suite | Hasil |
| --- | --- |
| `tests/work-order-assignment.test.ts` | 20/20 lulus |
| `tests/work-order-context.test.ts` | 16/16 lulus |
| `tests/tenant-service-requests.test.ts` | lulus (bagian dari 80 test grup) |
| `tests/work-order-history.test.ts`, `tests/work-order-lifecycle.test.ts`, `tests/work-requests.test.ts`, `tests/work-order-evidence.test.ts`, `tests/work-order-verification.test.ts` | lulus |
| `tests/openapi-contract.test.ts` | 7/7 lulus (semua path terdokumentasi terdaftar di router, tidak ada 404) |

Kegagalan yang **sudah ada sebelumnya** dan tidak diperbaiki di PART ini (di luar cakupan, tidak disebabkan
perubahan ini):

- `tests/work-order-register.test.ts` — 6 test (asumsi jumlah baris/kolom register yang lebih tua).
- `tests/work-order-action.test.ts`, `tests/work-order-completion.test.ts`,
  `tests/work-order-bast-closure-part04.test.ts` — gagal karena bug lama di
  `mobile-assignment.service.ts` (`function min(uuid) does not exist` pada PostgreSQL 18).
- `tests/openapi-operational-final-parity.test.ts`, `tests/openapi-operational-structural-closure.test.ts`,
  `tests/handyman-contract-freeze-03-openapi.test.ts` — pin sensus lama (`1,687`/`1,617`/`272`) yang sudah
  tidak cocok dengan ukuran repo saat ini (runtime nyata 2.014 operasi). Pin sengaja **tidak** diperbarui
  agar tidak menyamarkan drift lama.

### 5.3 Gerbang kualitas

```bash
npm run typecheck   # exit 0
npm run build       # exit 0
```

---

## 6. Keamanan & isolasi

- **Client/Building**: setiap operasi baru menurunkan Client/Building dari baris Work Order atau memverifikasi
  `clientId` eksplisit lewat `contextAccessService.canAccessClient`. Permission luas (`work_order.manage`)
  tidak pernah memperlebar jangkauan.
- **RBAC**: hanya vocabulary `work_order.read` / `work_order.manage`. Tidak ada permission baru, tidak ada
  role berubah, tidak ada password berubah.
- **Append-only**: ledger keputusan menolak UPDATE/DELETE pada level trigger database.
- **Rollback**: refusal kompetensi terjadi di dalam `withTransaction`, sehingga tidak ada assignment, event,
  atau baris ledger yang tertinggal (dibuktikan T3 dan T10).
- **Tidak ada sertifikasi global**: tidak ada requirement default; trade tanpa requirement tetap assignable.

---

## 7. Kompatibilitas

- Endpoint Work Order lama tidak berubah bentuk: klasifikasi berada pada resource terpisah, sehingga payload
  `WorkOrder` publik tetap sama.
- `service_competency_requirements` tetap kompatibel: baris lama (`service_catalog_id` terisi) tetap valid dan
  tetap dievaluasi pada jalur katalog/execution scope.
- Work Order tanpa klasifikasi → jalur assignment identik dengan sebelum PART ini (T13).

---

## 8. Gap lifecycle yang masih tersisa (bukan bagian PART 03B2A)

**G1 — Penugasan tingkat VENDOR (perusahaan) belum dinilai per orang.** Assignment `VENDOR` hanya menunjuk
perusahaan; gate memakai aturan ANY atas worker yang terikat. Bila perusahaan mengirim orang yang tidak
memenuhi requirement, penegakan baru terjadi pada jalur penugasan per-orang (crew/`VENDOR_WORKFORCE`).
Butuh keputusan governance: apakah vendor harus mendeklarasikan worker sebelum mulai, atau dispatch tetap
bebas dan diverifikasi di lapangan.

**G2 — Requirement belum bisa berbeda per Building.** Sama seperti PART 03A: requirement melekat pada trade
(Client-wide). Kebutuhan "Building A mewajibkan sertifikat tambahan" belum didukung.

**G3 — `risk_level` belum menjadi mesin kebijakan.** Risk level saat ini deskriptif dan tersimpan; ia belum
otomatis menurunkan requirement minimum. Pemetaan risk → requirement masih manual.

**G4 — Klasifikasi belum wajib.** Work Order boleh tetap tanpa klasifikasi (memang disengaja agar tidak ada
regresi), sehingga ada kemungkinan Work Order berisiko tinggi lolos tanpa gate bila Operations lupa
mengklasifikasi. Usulan: laporan/aging "unclassified Work Order" atau kewajiban klasifikasi untuk
`work_type` tertentu di PART berikutnya.

**G5 — Belum ada jalur exception/override ber-approval.** Saat ini penolakan bersifat final. Bila lapangan
butuh "assign sekarang, lengkapi sertifikat besok", diperlukan mekanisme override dengan alasan + approver
terpisah dan jejak audit — belum ada.

**G6 — Bulk konfigurasi requirement per trade dan handoff UI.** Impor CSV/JSON (preview → validate → commit)
serta halaman konfigurasi + indikator gap pada modal assign/reassign belum dibuat; kontrak DTO sudah tersedia
di `docs/api/openapi.yaml`.

**G7 — Retensi/arsip ledger Work Order.** `work_order_assignment_competency_decisions` tumbuh monoton dan
menolak UPDATE/DELETE. Bila volume menuntut, arsipkan lewat ekspor + partisi, bukan DELETE.

**G8 — Sweeper kedaluwarsa sertifikat** (warisan PART 02/03B) masih belum ada; status `EXPIRED` dihitung saat
dibaca. Tidak ada gap fungsional pada evaluator, hanya observability.

**G9 — Read model "kandidat" untuk Work Order belum ada.** PART 03A punya `.../competency/candidates` untuk
execution scope; untuk Work Order, UI assign belum punya endpoint kandidat yang menampilkan siapa memenuhi
requirement trade tersebut. Kandidat saat ini harus disimpulkan dari 409 refusal.

---

## 9. Checklist acceptance criteria PART 03B2A

| # | Requirement | Status | Bukti |
| --- | --- | --- | --- |
| 1 | Audit lifecycle Customer Care SR → Work Order → assignment | Selesai | §2 |
| 2 | Deskripsi/foto/jenis pekerjaan bebas tetap didukung, Service Catalog tidak wajib | Selesai | T14 (0 baris `service_catalog`) |
| 3 | Audit klasifikasi pekerjaan yang ada; Work Order menjadi otoritas klasifikasi | Selesai | §2, §3.2, T2 |
| 4 | Kategori multi-trade yang dapat dikonfigurasi, tidak AC-hardcoded | Selesai | T1, seed 11 trade |
| 5 | Operations menentukan klasifikasi, risk level, kebutuhan skill/sertifikat lewat alur triage existing | Selesai | T2 + CRUD requirement |
| 6 | Reuse evaluator PART 03A untuk assignment/reassignment termasuk crew multi-worker | Selesai | T3, T8, T9, T10 |
| 7 | Skill + proficiency dapat wajib; sertifikat hanya bila dikonfigurasi/aturan | Selesai | T4, T5 |
| 8 | Work Order tanpa requirement tetap assignable | Selesai | T6, T7, T13 |
| 9 | Tidak ada sertifikasi wajib global | Selesai | T4, T6, T7 |
| 10 | Semua jalur assignment terlindungi tanpa alur paralel | Selesai | gate di `work-order-assignment.service.ts`; T3/T8/T9/T13 |
| 11 | Isolasi Client/Building, RBAC, ledger keputusan, rollback transaksi | Selesai | T2, T10, T11, T12, T15, T16 |
| 12 | Regression test AC, plumbing, electrical minor, perbaikan pintu, pengecatan, perbaikan umum | Selesai | T3, T4, T5, T6, T7 |
| 13 | Uji SR (Customer Care) → Work Order → assignment tanpa Service Catalog | Selesai | T14 |

---

## 10. Cara mereproduksi

```bash
cd /home/user/Handyman-Backend
npm run typecheck
npm run build
NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1 tests/work-order-multitrade-03b2a.test.ts
```

Suite membuat cluster PostgreSQL embedded sendiri; tidak menyentuh `asentra` maupun database pengembangan.
