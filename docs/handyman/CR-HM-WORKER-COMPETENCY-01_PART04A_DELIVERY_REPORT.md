# CR-HM-WORKER-COMPETENCY-01 — PART 04A — Delivery Report

**Judul:** Backend Stabilization & Cross-App E2E Contracts (Operations + Mobile)
**Branch:** `arena/3df97f5e-handyman-backend` (basis `d4a7aa3` — PART 03B2E)
**Tanggal:** 2026-10-23
**Status:** selesai. Migrasi bersih, regresi blocking tertutup, E2E lintas aplikasi hijau,
dua handoff frontend diterbitkan, gap matrix lengkap. `typecheck` + `build` bersih.
Tidak ada PR, tidak ada merge, tidak ada deploy (Railway / Vercel / **Coolify Biznet tidak disentuh**),
tidak ada full-suite run.

---

## 1. Ringkasan eksekutif

PART 04A adalah pekerjaan **stabilisasi sebelum integrasi frontend**, bukan penambahan fitur bisnis.
Yang dilakukan:

1. **Audit migrasi** pada cluster PostgreSQL 18.4 sekali pakai: urutan kanonik, tabrakan nomor,
   idempotensi, upgrade dari representasi produksi (459 migrasi), fresh install, down/up, dan
   rollback guard. Hasil: **tanpa blocker**.
2. **Perbaikan regresi blocking**: enam kegagalan `work-order-register` diterangkan dan ditutup;
   semuanya **fixture/ekspektasi basi**, bukan bug runtime. Paritas OpenAPI direkonsiliasi terhadap
   **inventaris rute aktual** (bukan "memperbaiki" pin historis).
3. **E2E operasional lintas aplikasi** (HTTP murni, tanpa shortcut service) untuk rantai
   Tenant → Customer Care → Work Order → Klasifikasi → Assignment → Mobile → Bukti Foto → Selesai →
   QC → Tutup, ditambah varian kompetensi dan attendance: **17/17 hijau**.
4. **Dua handoff frontend terpisah**: Operations dan Mobile, memuat tabel kontrak, permission,
   bentuk payload, kode error, dan anti-pattern.
5. **Gap matrix** BLOCKER / NON-BLOCKER / DEFERRED beserta bukti, termasuk kesimpulan modul
   Foto Evidence (**tidak perlu modul baru**).

**Blocker rilis: tidak ada.**

---

## 2. Audit migrasi (PostgreSQL 18.4, cluster sekali pakai)

| Pemeriksaan | Hasil |
| --- | --- |
| Migrasi terdaftar | **466**, seluruhnya unik dan berurutan kanonik |
| Satu-satunya celah nomor | `0448 → 0450` (lubang historis, bukan tabrakan) |
| Tabrakan nomor / duplikat file | tidak ada |
| Fresh install pada database kosong | 466 diterapkan, schema terbentuk |
| Re-run `migrateUp` | **0** migrasi diterapkan (idempoten) |
| Upgrade dari representasi produksi (459 migrasi aktif di Biznet) | menerapkan **tepat `0461–0467`**, tidak ada lompatan/regresi |
| Fingerprint schema hasil fresh install vs upgrade | identik: `453 tables / 5866 columns / 8455 constraints / 2164 indexes / 187 triggers`, `sha256 = 59abc67a858e43c2959fe6ccea3189e8155f5aaaa08162239f015387a32ca4db` |
| Down/up | `466 → 465 → 464 → 466` OK |
| Rollback guard | `0466` menolak turun dengan pesan `cannot roll back 0466: DIRECT handyman provider contexts exist` (guard bekerja sesuai desain) |
| PostgreSQL 18 kompatibilitas | tidak ada `min(uuid)/max(uuid)` (dihapus di PG 18) — sudah diperbaiki pada PART 03B2C; tidak ada aggregate terlarang baru |

Catatan penting: **produksi Biznet tidak pernah disentuh.** Seluruh audit berjalan pada cluster
sementara (`/tmp`), dibuang setelah selesai.

**Kesimpulan: NO BLOCKER.**

---

## 3. Perbaikan regresi blocking

### 3.1 `tests/work-order-register.test.ts` — 6 gagal → **12/12**

Keenam kegagalan diperiksa satu per satu; **semuanya berasal dari ekspektasi/fixture yang basi**,
bukan dari perilaku runtime. Tidak ada perubahan business authority.

| # | Gejala | Diagnosis | Perbaikan |
| --- | --- | --- | --- |
| 1 | `historyCount` 5 ≠ 3 | Service authoritative kini juga menulis `WORK_ORDER_CREATED` dan `WORK_ORDER_ASSIGNED`; seed mem-pin 3 baris | Ekspektasi diubah menjadi **cermin ledger**: `historyCount === COUNT(operational_events)` + `>= 3` |
| 2 | `historyAvailable` `false` untuk WO polos | Pembuatan WO **adalah** event operasional | Ekspektasi menjadi `historyAvailable === (ledger > 0)` |
| 3 | `ids.length === 3` | Suite berbagi satu database; setiap `it` men-seed Client baru | Diubah menjadi relatif: satu baris per WO **yang dibuat seed ini** (selisih sebelum/sesudah) |
| 4 | `buildingScope` exact-set | Rollup mencakup Building dari seed lain di database yang sama | Diubah menjadi keanggotaan: A & B ada, C (terlarang) tidak ada |
| 5 | Hitungan filter absolut (status/workType/priority/BAST/asset/assignee/team/vendor/verification/tanggal) | Sama: kueri tak ter-scope ke Building seed | Semua kueri filter di-scope `buildingId` seed + assert keanggotaan WO yang diharapkan |
| 6 | `err.code === 'VALIDATION'` | Kode kanonik `AppError.validation()` adalah **`VALIDATION_ERROR`** | Assert diperbaiki; ekspektasi "array param melempar" diganti dengan **konvensi nyata** `readSingleParam` (array diabaikan), ditambah kasus baru tanggal kalender mustahil (`2026-13-01`) yang memang ditolak |

### 3.2 Paritas OpenAPI — rekonsiliasi terhadap rute aktual

Inventaris rute runtime dipin ulang (bukan "memperbaiki" angka lama):

| Metrik | Nilai |
| --- | --- |
| Rute runtime | **2.016** = 1.946 operasional + 1 root (`GET /`) + 69 `/platform` |
| Operasional terdokumentasi | **1.945** |
| Platform terdokumentasi | **69** |
| Total OpenAPI | **2.014** |
| Operasi runtime tak terdokumentasi | **0** |
| Operasi OpenAPI spekulatif | **0** |
| `operationId` duplikat | **0** |
| Selisih aritmetika tersisa | **1** — duplikat mount `GET /tasks/:id` (menyatu jadi satu operasi OpenAPI) |

Perubahan konkret:

* **22 operasi terautentikasi** yang belum mendokumentasikan `401` kini memilikinya
  (`docs/api/openapi.yaml`). Operasi dengan `security: []` **tidak** diberi `401`.
* `openapi-operational-structural-closure` (8/8) dan `openapi-operational-final-parity` (7/7):
  pin angka di-refresh + dua perbaikan cakupan nyata:
  – router Express dengan **array path** (`router.get(['/a','/a/:id'])`) sebelumnya dihitung sebagai
    satu rute sehingga operasi sah tampak "spekulatif" → sekarang tiap path dihitung;
  – `POST /invitations/validate` dan `POST /handyman/requests/care` masuk daftar `security: []`
    (tanpa sesi, jadi `401` bukan bagian kontraknya).
* `openapi-saas-route-parity` **15/15**; `openapi-contract` **7/7**;
  `handyman-contract-freeze-03-openapi` **13/13**.

### 3.3 Re-audit PART 03B2E (12/12 kriteria)

Gate klasifikasi diverifikasi ulang pada database bersih: hanya WO berasal Customer Care yang
`classificationRequired = true`; penolakan terjadi **sebelum** penulisan (409
`WORK_ORDER_CLASSIFICATION_REQUIRED`, nol baris assignment); reklasifikasi direvalidasi terhadap
assignee aktif dan di-rollback bila melanggar `MANDATORY`. Test E4-5 ditambahkan (assignee level user
dengan Building assignment) → suite **19/19**.

---

## 4. E2E operasional lintas aplikasi — `tests/e2e-operational-lifecycle-04a.test.ts` (17/17)

Suite mandiri: menyalakan PostgreSQL embedded sendiri (`/tmp/hm-e2e-04a-pg`, port 55667),
`migrateUp`, lalu seluruh alur lewat **HTTP murni**.

### 4.1 Rantai utama (stage 01–12)

| Stage | Yang dibuktikan |
| --- | --- |
| 01 | Tenant request diterima **tanpa Service Catalog** (`SELECT COUNT(*) FROM service_catalog = 0`) dan **tanpa trade** — `requestType` bebas `AIR_KRAN_BOCOR`, tersimpan verbatim sebagai `work_orders.work_type` |
| 02 | Customer Care mengonversi SR → Work Order; `GET classification` → `tradeCategoryId = null`, `classificationRequired = true` |
| 03 | Assignment ditolak `409 WORK_ORDER_CLASSIFICATION_REQUIRED`; **nol** baris `work_order_assignments` |
| 04 | Operations mengklasifikasi `PLUMBING` / `MEDIUM` |
| 05 | Freelance worker (DIRECT, `vendorId: null`) ditugaskan lewat otoritas assignment yang sama; **tidak ada vendor yang dibuat** (`vendors = 0`) |
| 06 | Mobile feed menampilkan `ACKNOWLEDGE`; acknowledge → `ASSIGNED` |
| 07 | start → `IN_PROGRESS` |
| 08 | 2 bukti `PHOTO` + `evidence-requirements`; bytes nyata diunggah lewat `/evidence/{id}/file` dan **SHA-256 dihitung server**; konten dapat diunduh |
| 09 | complete → `COMPLETED` |
| 10 | QC `POST /verification` → `APPROVED` |
| 11 | `POST /close` → `CLOSED`, `closed_at` terisi; feed WO tertutup tidak lagi menawarkan aksi |
| 12 | **Tidak ada bypass**: WO tertutup menolak reassignment / complete ulang / close ulang; ledger keputusan kompetensi kosong untuk trade tanpa requirement; sesi Building lain ditolak `403` |

### 4.2 Varian kompetensi & keamanan perubahan (stage 13–16)

| Stage | Yang dibuktikan |
| --- | --- |
| 13 | **Multi-skill**: pekerja pemegang sertifikat PLUMBING tetap bisa ditugaskan ke pekerjaan PAINTING (201, `satisfied = true`, `advisory = []`); identitas sertifikat tidak menyempit |
| 14 | Requirement `RECOMMENDED` → **warning saja**: 201 + `advisory[]` `reason: SKILL_MISSING`, `satisfied = true` |
| 15 | Requirement `MANDATORY` sertifikat → `409 WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED` (`CERTIFICATION_UNVERIFIED`), **tanpa** assignment parsial dan **tanpa** baris ledger; setelah verifikasi Operations → 201 dan ledger `ASSIGNED` + `evidence_verification_status = VERIFIED` |
| 16 | **Reklasifikasi aman**: reklasifikasi ke trade yang tidak dipenuhi assignee aktif → `409 WORK_ORDER_CLASSIFICATION_CONFLICT` dan klasifikasi lama tidak berubah; reklasifikasi ke trade yang dipenuhi → 200 + ledger `RECLASSIFIED`; **reassign** ke pekerja tanpa sertifikat ditolak (assignment lama tetap `ACTIVE`), setelah sertifikat diverifikasi → 200, tepat **satu** assignment `ACTIVE`, yang lama `INACTIVE` |

### 4.3 Attendance (stage 17)

`clock-in` → 201 `CLOCKED_IN`; `GET /attendance/current` konsisten; clock-in ganda →
`409 ATTENDANCE_ACTIVE_ALREADY_EXISTS`; `clock-out` → 200 `CLOCKED_OUT`; clock-out ulang →
`409 ATTENDANCE_NOT_ACTIVE`.

### 4.4 Matriks kriteria penerimaan PART 04A

| Kriteria | Status | Bukti |
| --- | --- | --- |
| Request Tenant diterima tanpa Service Catalog | ✅ | stage 01 (`service_catalog = 0`) |
| Pekerja tetap/kontrak/freelance bisa ditugaskan langsung | ✅ | stage 05 + 13 (freelance DIRECT, `vendorId: null`) |
| Multi-skill hold | ✅ | stage 13 (sertifikat trade lain tidak memblokir) |
| Sertifikat wajib hanya pada `MANDATORY` | ✅ | stage 14 (warning) vs 15 (block) |
| WO Customer Care wajib klasifikasi sebelum assignment | ✅ | stage 02 + 03 (409, nol tulisan) |
| Reklasifikasi & reassignment aman | ✅ | stage 16 (conflict rollback, satu ACTIVE) |
| Tidak ada bypass lewat endpoint alternatif | ✅ | stage 12 |
| Client/Building isolation | ✅ | stage 12 (`403` lintas Building) + stage 16 (scope per operasi) |
| Bukti foto cukup dengan modul yang ada | ✅ | stage 08 (metadata + bytes + hash) |

---

## 5. Handoff frontend

Dua dokumen terpisah (bukan satu dokumen gabungan):

1. **`docs/handyman/CR-HM-WORKER-COMPETENCY-01_PART04A_OPERATIONS_HANDOFF.md`**
   Alur layar klasifikasi → pemilihan pekerja → assignment; kontrak
   `/work-order-trade-categories` (termasuk `competency-requirements`),
   `/work-orders/{id}/classification`, `/work-orders/{id}/assignments` (+ `current`, riwayat,
   `competency-decisions`), pool DIRECT/VENDOR (`/handyman/provider-contexts`),
   `/handyman/worker-contexts`, skills & sertifikat workforce, aturan rule `ALL`/`ANY`,
   seluruh `reason` penolakan, dan anti-pattern UI.
2. **`docs/handyman/CR-HM-WORKER-COMPETENCY-01_PART04A_MOBILE_HANDOFF.md`**
   Profil pekerja (`/handyman/field/me/profile`), feed `/mobile/assignments` (termasuk jebakan
   `item.id` vs `reference.workOrderId`), aksi eksekusi, dua jalur bukti (Work Order evidence dan
   field-evidence presign→bytes→confirm), attendance, bundle permission peran lapangan, anti-pattern.

Keduanya menyebut secara eksplisit bahwa **tidak ada modul bukti baru** dan bahwa
`/mobile/evidence` tidak menerima `executionType = 'WORK_ORDER'`.

---

## 6. Kesimpulan Foto Evidence

Audit kapabilitas yang ada (tanpa menulis kode bukti baru):

| Kebutuhan lapangan | Modul yang dipakai | Cukup? |
| --- | --- | --- |
| Foto BEFORE / PROGRESS / AFTER terikat pekerjaan | `handyman-field-evidence` (`purpose = BEFORE_AFTER_WORK`, presign → PUT bytes → confirm, ≤ 15 MB, `idempotencyKey` wajib) | ✅ |
| Foto terikat Work Order untuk QC/penutupan | `work-order-evidence` (`PHOTO`/`DOCUMENT`/`SIGNATURE`, ≤ 50 MB) + `evidence` file route (SHA-256 server-side) | ✅ |
| Metadata (nama file, MIME, ukuran, waktu kamera) | `POST /work-orders/{id}/evidence` (`capturedAt`) dan field-evidence (`originalFileName`, `mimeType`, `declaredByteSize`, `notes`) | ✅ |
| Status & requirement bukti | `GET /work-orders/{id}/evidence-requirements`, `GET /work-orders/{id}/evidence` | ✅ |
| Integritas & retensi | hash server-side, `integrity-verification`, `retention-*` | ✅ |
| Geotag/koordinat | tidak ada di kontrak | ⚠️ DEFERRED (tidak wajib Go-Live) |

**Keputusan: modul bukti baru TIDAK dibuat.** Yang ditambahkan hanya jalur pemakaian yang terbukti
(stage 08) dan dokumentasi batas kontrak.

---

## 7. Gap matrix

### 7.1 BLOCKER (harus selesai sebelum Go-Live)

| # | Item | Status |
| --- | --- | --- |
| — | **Tidak ada blocker.** Seluruh rantai operasional, gate kompetensi, isolasi Client/Building, dan penutupan terbukti hijau. | — |

### 7.2 NON-BLOCKER (mengganggu ergonomi, ada workaround)

| # | Item | Dampak | Workaround / rekomendasi |
| --- | --- | --- | --- |
| N1 | Tidak ada `GET /handyman/provider-contexts/by-client/{clientId}` | Setelah `409` "pool DIRECT sudah ada", UI tidak bisa membaca ulang `id` pool dari API | Simpan `id` dari respons `201`; `GET /handyman/worker-contexts/{id}` juga mengembalikan `providerContextId`. Tambah endpoint baca pada PART berikutnya |
| N2 | `/mobile/evidence` tidak menerima `executionType = 'WORK_ORDER'` | Developer Mobile bisa salah pilih endpoint | Sudah didokumentasikan di handoff §4.3; gunakan `/work-orders/{id}/evidence` atau field-evidence |
| N3 | Bytes foto butuh `evidence.manage`, sedangkan metadata cukup `work_order.manage` | Role lapangan tanpa `evidence.manage` gagal di langkah unggah (`403`) setelah metadata dibuat | Bundle permission di handoff §6; lengkapi role lapangan sebelum UAT |
| N4 | Riwayat Work Order tidak punya endpoint publik (`/work-orders/{id}/history` tidak ada) | Audit UI harus memakai ledger keputusan + register | Ledger `competency-decisions` tersedia; audit internal memakai `operational_events` |
| N5 | `schedule.dueAt` selalu `null` untuk Work Order | UI tidak bisa menampilkan tenggat | Sesuai desain (belum ada SLA authoritative); jangan menghitung due date di klien |
| N6 | Verifikasi sertifikat diri sendiri dilarang | Operator tunggal di Client kecil bisa terhalang | Siapkan dua akun verifikator per Client |

### 7.3 DEFERRED (disetujui ditunda, tidak menghalangi integrasi)

| # | Item | Alasan ditunda |
| --- | --- | --- |
| D1 | Auto-classification / saran trade otomatis | Butuh data historis; keputusan trade tetap milik Operations |
| D2 | Geotagging + watermark foto | Menambah kontrak bukti; tidak wajib Go-Live |
| D3 | Notifikasi assignment ke pekerja (push/WA/email) | Di luar scope stabilization |
| D4 | Dashboard gap kompetensi per trade | Konsumsi read model, bukan blocker integrasi |
| D5 | Offline queue Mobile | Sisi klien; backend sudah idempoten (`idempotencyKey`) |
| D6 | Endpoint baca pool DIRECT (N1) | Perubahan kontrak; dijadwalkan bersama penambahan rute |

---

## 8. Hasil pengujian

Semua perintah dijalankan pada database **sekali pakai** (bukan Biznet).

| Suite | Hasil |
| --- | --- |
| `tests/e2e-operational-lifecycle-04a.test.ts` | **17/17** |
| `tests/work-order-register.test.ts` | **12/12** |
| `tests/work-order-classification-03b2e.test.ts` | **19/19** |
| `tests/work-order-multitrade-03b2a.test.ts` | **17/17** |
| `tests/work-order-multiskill-03b2b.test.ts` | **11/11** |
| `tests/handyman-direct-workforce-03b2d.test.ts` | **20/20** |
| `tests/openapi-operational-final-parity.test.ts` | **7/7** |
| `tests/openapi-saas-route-parity.test.ts` | **15/15** |
| `tests/openapi-operational-structural-closure.test.ts` | **8/8** |
| `tests/openapi-contract.test.ts` | **7/7** |
| `tests/handyman-contract-freeze-03-openapi.test.ts` | **13/13** |
| `npm run typecheck` | bersih |
| `npm run build` | bersih |

Perintah E2E (mandiri, tanpa env DB eksternal):

```bash
rm -rf /tmp/hm-e2e-04a-pg
NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1 \
  tests/e2e-operational-lifecycle-04a.test.ts
```

Suite fokus lainnya memakai cluster sementara:

```bash
DB_HOST=127.0.0.1 DB_PORT=55670 DB_USER=postgres DB_PASSWORD='' \
DB_NAME=asentra_test DB_SSL=false npx tsx --test --test-concurrency=1 <file>
```

Full suite **tidak** dijalankan (sesuai instruksi).

---

## 9. Kesiapan FINAL REVIEW

| Aspek | Status |
| --- | --- |
| Migrasi & kompatibilitas PG 18 | ✅ siap (466 kanonik, upgrade 459→466 bersih, fingerprint identik) |
| Gate klasifikasi & kompetensi | ✅ siap (block `MANDATORY`, warn `RECOMMENDED`, multi-skill aman) |
| Direct workforce tanpa vendor | ✅ siap (DIRECT pool, `vendorId: null`, tanpa vendor fiktif) |
| Rantai operasional end-to-end | ✅ siap (17 stage hijau lewat HTTP) |
| Isolasi Client/Building | ✅ siap (403 lintas Building pada seluruh operasi yang diuji) |
| Kontrak frontend Operations & Mobile | ✅ terbit (dua dokumen handoff) |
| OpenAPI parity | ✅ 1.945/1.946 operasional, 0 tak terdokumentasi, 0 spekulatif |
| Blocker rilis | ✅ tidak ada |
| Backward compatibility | ✅ tidak ada perubahan kontrak yang memutus; perubahan hanya aditif |

**Rekomendasi:** lanjut ke FINAL REVIEW dengan catatan N1–N6 sebagai backlog integrasi (bukan
penghalang), dan D1–D6 sebagai backlog produk.

---

## 10. Berkas yang berubah pada PART 04A

| Berkas | Sifat |
| --- | --- |
| `tests/e2e-operational-lifecycle-04a.test.ts` | **baru** — E2E lintas aplikasi 17 stage |
| `tests/work-order-register.test.ts` | fixture/ekspektasi direkonsiliasi (6 → 0 gagal) |
| `tests/work-order-classification-03b2e.test.ts` | + test E4-5 (assignee level user) |
| `tests/helpers/access.ts` | + `createSessionWithPermissionsForUser` |
| `tests/openapi-operational-final-parity.test.ts` | pin angka + array-path + `security: []` |
| `tests/openapi-operational-structural-closure.test.ts` | pin angka direkonsiliasi |
| `tests/openapi-saas-route-parity.test.ts` | pin angka direkonsiliasi |
| `docs/api/openapi.yaml` | + `401` pada 22 operasi terautentikasi |
| `docs/handyman/…PART03B2E_DELIVERY_REPORT.md` | + §9 re-audit |
| `docs/handyman/…PART04A_OPERATIONS_HANDOFF.md` | **baru** |
| `docs/handyman/…PART04A_MOBILE_HANDOFF.md` | **baru** |
| `docs/handyman/…PART04A_DELIVERY_REPORT.md` | **baru** (dokumen ini) |

Tidak ada perubahan pada skema database, RBAC, role Super User, maupun password pada PART 04A.
