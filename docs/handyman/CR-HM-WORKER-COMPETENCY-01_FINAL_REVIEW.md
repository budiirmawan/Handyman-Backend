# CR-HM-WORKER-COMPETENCY-01 — FINAL REVIEW

**Repository:** Handyman-Backend
**Branch:** `arena/3df97f5e-handyman-backend`
**Base:** `origin/main` @ `e8b94af` (Merge PR #54)
**Baseline sebelum FINAL REVIEW:** `225d91c`
**Tanggal:** 2026-10-23
**Cakupan:** PART 01, 02, 03A, 03B1, 03B2A, 03B2B, 03B2C, 03B2D, 03B2E, 04A

---

## 0. Verdict

| Aspek | Status |
| --- | --- |
| Kelengkapan fondasi PART 01–04A | **PASS** |
| Migrasi `0461–0467` (urutan, dependency, upgrade Biznet, down/up, guard) | **PASS** |
| Isolasi Client/Building & RBAC | **PASS** |
| Maker-checker sertifikasi | **PASS** |
| Direct workforce tanpa vendor | **PASS** |
| Multi-skill & tidak ada kewajiban sertifikat global | **PASS** |
| Alur utama Tenant → Customer Care → SR → WO → Ops → Mobile → Evidence → QC → Closure | **PASS** |
| Foto Evidence existing (bytes, authorization, integritas) | **PASS** |
| OpenAPI & handoff docs vs implementasi | **PASS** (3 koreksi dokumentasi + 2 penambahan metadata kontrak diterapkan di FINAL REVIEW) |
| Focused regression + typecheck + build | **PASS** |
| **Kesiapan merge terkontrol** | **PASS — siap merge, belum di-merge** |

Tidak ada blocker tersisa. Satu cacat **blocking** ditemukan dan diperbaiki pada FINAL REVIEW
(§9.1). Tidak ada PR merge, tidak ada deploy, tidak ada migrasi produksi.

---

## 1. Audit branch terhadap `main` terbaru

```
origin/main .. HEAD  = 11 commit, 105 berkas, +28.324 / -242
```

| Commit | Isi |
| --- | --- |
| `1597ac5` | PART 01 — fondasi sertifikasi pekerja (`0461`) |
| `558ba4d` | PART 02 — REST API sertifikasi + integrasi profil pekerja (`0462`) |
| `8c7e8ef` | PART 03A — penilaian kompetensi berbasis assignment (`0463`) |
| `f1dac0b`, `76eb66b`, `e6845a7` | PART 03B1 — riwayat keputusan + re-verifikasi (`0464`), laporan, backlog |
| `06933e4` | PART 03B2A — multi-trade Work Order + gate klasifikasi (`0465`) |
| `32f2ba7` | PART 03B2B — aturan multi-skill + advisory |
| `9d6da19` | PART 03B2C — perbaikan PG 18 (`MIN(uuid)`) pada feed assignment |
| `e81ccca` | PART 03B2D — direct Handyman workforce (`0466`) |
| `d4a7aa3` | PART 03B2E — finalisasi klasifikasi + revalidasi (`0467`) |
| `225d91c` | PART 04A — E2E operasional, rekonsiliasi paritas, handoff |

**Tidak ada perubahan hilang atau duplikat** akibat perpindahan sesi:

* Setiap deliverable PART 01–04A ada tepat satu kali di tree (modul, migrasi, route mount, test, laporan).
* `src/routes/index.ts`: 4 router baru (`worker-competency-eligibility`,
  `service-competency-requirements`, `work-order-trade-categories`, `workforce-certifications`)
  masing-masing di-mount **satu kali**.
* `src/database/migrations/index.ts`: 7 migrasi baru terdaftar berurutan; tidak ada nomor ganda.
* Tidak ada `TODO/FIXME/HACK/WIP` yang ditambahkan pada diff branch.
* Tidak ada berkas sementara yang tertinggal (`.dump_ops.mjs`, `tmp-*.ts` sudah dibersihkan).

---

## 2. Kelengkapan fondasi PART 01–04A

| PART | Deliverable | Bukti di tree |
| --- | --- | --- |
| 01 | `workforce_certifications` + dokumen + guard | `0461_create_workforce_certifications.ts` (209 baris, unique ACTIVE index, trigger) |
| 02 | REST API sertifikasi + permission namespace | `src/modules/workforce-certifications/*`, `0462`, seed foundation-access |
| 03A | Requirement kompetensi + evaluator tunggal | `src/modules/service-competency-requirements/*`, `src/modules/worker-competency-eligibility/*`, `0463` |
| 03B1 | Riwayat keputusan (append-only) + re-verifikasi | `0464` (2 tabel + trigger append-only), `workforce-certification-decision.repository.ts` |
| 03B2A | Multi-trade + gate klasifikasi + ledger gate | `0465`, `src/modules/work-order-trade-categories/*` |
| 03B2B | Multi-skill + advisory `RECOMMENDED` | `worker-competency-eligibility.service.ts` (rule ALL/ANY, advisory) |
| 03B2C | Perbaikan PG 18 | `mobile-assignment.service.ts` (tanpa `MIN(uuid)`) |
| 03B2D | Direct workforce (pool DIRECT, tanpa vendor) | `handyman-provider-context.service.ts`, `handyman-worker-eligibility.repository.ts`, `0466` |
| 03B2E | Klasifikasi wajib + revalidasi reklasifikasi | `work-order-classification` di `work-order-trade-category.service.ts`, `0467` |
| 04A | E2E lintas aplikasi + handoff + gap matrix | `tests/e2e-operational-lifecycle-04a.test.ts`, 3 dokumen handoff |

**Satu otoritas bisnis:** evaluator kompetensi hanya ada satu
(`worker-competency-eligibility.service.ts`), dipakai oleh **kedua** jalur assignment
(`handyman-scope-assignment.service.ts` untuk crew/execution scope, dan
`work-order-assignment.service.ts` untuk Work Order). Tidak ada evaluator kedua.

---

## 3. Migrasi `0461–0467` — dependency, registry, simulasi upgrade

### 3.1 Dependency order

```
0461 workforce_certifications
0462 permissions (seed, ON CONFLICT DO NOTHING)
0463 service_catalog_competency_requirements   → butuh 0025 skills, 0026 wsa, service_catalog
0464 workforce_certification_decisions + handyman_assignment_competency_evaluations
0465 work_order_trade_categories + kolom work_orders + generalisasi 0463 + ledger WO
0466 direct workforce: handyman_provider_contexts.vendor_id NULL, provider_type, unique DIRECT
0467 perluasan CHECK action ledger 0465 (RECLASSIFIED)
```

Tidak ada referensi maju (forward reference); `0465` meng-`ALTER` tabel buatan `0463`, `0467`
meng-`ALTER` tabel buatan `0465`. Seluruh seed memakai `ON CONFLICT` atau dijalankan sekali
dalam transaksi migrasi.

### 3.2 Simulasi pada PostgreSQL 18.4 (cluster sekali pakai)

| Skenario | Hasil |
| --- | --- |
| Fresh install (DB kosong) | **466** migrasi diterapkan |
| Re-run `migrateUp` | **0** diterapkan (idempoten) |
| Baseline representasi Biznet: 459 migrasi (sampai `0460`) | terbentuk sebagai baseline |
| Upgrade baseline → HEAD | menerapkan **tepat `0461, 0462, 0463, 0464, 0465, 0466, 0467`** |
| Fingerprint schema fresh vs upgrade | **identik** — `453 tables / 5.866 columns / 8.455 constraints / 2.164 indexes`, `sha256 = 018508cf63090e4fff5dc50cb9eb5dca19217f399da483b4cfcb3aafbc348d5a` |
| Down berurutan `0467 → 0461` | seluruh 7 migrasi turun bersih |
| Up ulang | menerapkan ulang `0461–0467`; fingerprint kembali identik |
| Guard rollback `0466` dengan data | **menolak**: `cannot roll back 0466: DIRECT handyman provider contexts exist`; migrasi tetap pada `0466` (atomik) |
| Seed hasil migrasi | 11 trade category (`AIR_CONDITIONING`, `CEILING`, `DOOR_LOCK`, `ELECTRICAL_MINOR`, `FURNITURE`, `GENERAL_REPAIR`, `INSTALLATION`, `PAINTING`, `PLUMBING`, `SANITARY`, `TILING`) + 3 permission `workforce_certification.*` |

**Migration impact:** aditif. Tidak ada `DROP`/rename kolom produksi, tidak ada backfill yang
mengubah data lama. `0466` melonggarkan `vendor_id NOT NULL` menjadi nullable dengan constraint
`provider_type ∈ {VENDOR, DIRECT}` + unique index DIRECT per Client.

---

## 4. Isolasi Client/Building, RBAC, maker-checker, rollback

| Kontrol | Implementasi | Bukti pengujian |
| --- | --- | --- |
| Scope per operasi | `assertBuildingAccess` / `assertBuildingScopedResourceAccess` pada setiap controller (klasifikasi, assignment, verifikasi, close, profil, sertifikasi) | `data-isolation` **15/15**; E2E stage 12 (`403` lintas Building) |
| Permission tidak melebar | 3 permission sertifikasi terpisah; verify ≠ manage; `requirePermission` per route | `config-perm-01-permission-registry` **13/13**; `workforce-certifications-http` **18/18** |
| Maker-checker | `verify` butuh `workforce_certification.verify`; verifikasi diri sendiri ditolak (`SELF_VERIFICATION_FORBIDDEN`); sertifikat INACTIVE/kedaluwarsa tidak bisa `VERIFIED` | `workforce-certifications` **6/6**, `workforce-certifications-http` **18/18** |
| Rollback transaksi | Penolakan gate terjadi **sebelum** tulisan; decision ledger + perubahan dalam satu transaksi | E2E stage 03 (0 assignment), stage 15 (0 assignment + 0 ledger), stage 16 (assignment lama tetap ACTIVE saat reassign ditolak) |
| Append-only history | Trigger `BEFORE UPDATE OR DELETE` pada `workforce_certification_decisions` dan `handyman_assignment_competency_evaluations` | `0464`, `0465`; `worker-competency-03b1` **14/14** |
| Audit trail | `operational_events` untuk klasifikasi, assignment, provider context | `work-order-register` **12/12**; E2E stage 11 |

---

## 5. Alur utama (Tenant → … → Closure)

Dibuktikan lewat HTTP murni pada `tests/e2e-operational-lifecycle-04a.test.ts` (17/17):

Tenant request **tanpa Service Catalog** dan **tanpa trade** (`AIR_KRAN_BOCOR`) → Customer Care
konversi ke Work Order (`classificationRequired = true`) → assignment ditolak `409`
`WORK_ORDER_CLASSIFICATION_REQUIRED` tanpa menulis apa pun → Operations klasifikasi
`PLUMBING`/`MEDIUM` → freelance DIRECT ditugaskan → Mobile feed `ACKNOWLEDGE` → `ASSIGNED` →
`IN_PROGRESS` → 2 bukti `PHOTO` (+ bytes nyata, SHA-256 server) → `COMPLETED` → QC `APPROVED` →
`CLOSED` (`closed_at` terisi) → WO tertutup menolak reassignment/complete/close ulang.

Attendance lapangan juga terbukti (stage 17): clock-in/clock-out + penolakan duplikat.

---

## 6. Pekerja tetap / kontrak / freelance tanpa vendor

| Fakta | Status |
| --- | --- |
| Pool DIRECT dibuat dengan `{ clientId }` pada `POST /handyman/provider-contexts` | ✅ `provider_type = DIRECT`, `vendor_id = NULL` |
| Tidak ada vendor fiktif | ✅ E2E stage 05: `SELECT COUNT(*) FROM vendors WHERE client_id = …` = **0** |
| Pekerja masuk pool tanpa `vendor_workforce_bindings` | ✅ `handyman-worker-context.service.ts` (langkah binding hanya untuk VENDOR) |
| Eligibility crew tidak lagi mensyaratkan `workforce_type = 'EXTERNAL'` | ✅ `handyman-worker-eligibility.repository.ts` |
| Legacy VENDOR tetap bekerja | ✅ `handyman-direct-workforce-03b2d` **20/20** |

---

## 7. Multi-skill & tidak ada kewajiban sertifikat global

| Fakta | Bukti |
| --- | --- |
| Sertifikat trade lain tidak memblokir/substitusi | E2E stage 13 (`PAINTING` job, pekerja bersertifikat `PLUMBING`, `satisfied = true`, `advisory = []`) |
| Hanya `MANDATORY` memblokir | E2E stage 14 (`RECOMMENDED` → 201 + advisory) vs stage 15 (`MANDATORY` → 409) |
| Tidak ada gate global | `evaluateCrews` fast-path ketika requirement = 0; gate WO hanya membaca requirement trade yang dikonfigurasi per Client |
| Rule per assignee | `WORKFORCE`/`TEAM` ⇒ `ALL`; `VENDOR` ⇒ `ANY` (teruji di `work-order-multitrade-03b2a` **17/17**, `work-order-multiskill-03b2b` **11/11`) |

---

## 8. Foto Evidence — cukup, tanpa modul baru

| Kebutuhan | Endpoint | Status |
| --- | --- | --- |
| Metadata bukti WO | `POST /work-orders/{id}/evidence` (`work_order.manage`) | ✅ |
| Upload bytes + integritas | `POST /evidence/{evidenceId}/file` (`evidence.manage`), SHA-256 **server-side**, MIME per tipe, ≤ 50 MB | ✅ E2E stage 08 (hash + unduh konten) |
| Requirement bukti | `GET /work-orders/{id}/evidence-requirements` | ✅ |
| Field evidence BEFORE/AFTER | presign → `PUT …/bytes` → `confirm` (≤ 15 MB, `idempotencyKey` wajib, signature diperiksa) | ✅ |
| Retensi & verifikasi integritas | `retention-hold`, `integrity-verification` | ✅ (pre-existing, tidak diubah) |

Batas kontrak yang terdokumentasi: `/mobile/evidence` **tidak** menerima `executionType = 'WORK_ORDER'`
(keputusan desain, bukan cacat). **Tidak ada modul bukti baru yang dibuat.**

---

## 9. Temuan FINAL REVIEW dan tindakan

### 9.1 BLOCKING — harness `handyman-crew-worker-admission` merah (diperbaiki)

**Gejala.** Suite `tests/handyman-crew-worker-admission.test.ts` gagal **8/26** pada branch,
sedangkan pada `origin/main` suite yang sama hijau 27/27.

**Diagnosis.** Bukan regresi produksi. Suite memakai harness **TEMP TABLE** minimal (tanpa migrasi),
sedangkan PART 03A menambahkan gate kompetensi pada jalur assignment execution scope yang membaca
`service_catalog`, `service_catalog_competency_requirements`, `skills`,
`workforce_skill_assignments`, `workforce_certifications`, dan menulis
`handyman_assignment_competency_evaluations`. Tabel-tabel itu tidak ada di harness ⇒
`42P01 relation "service_catalog" does not exist` pada 8 test. Pada skema nyata semua tabel ada
(`handyman_service_requests.service_catalog_id` bahkan `NOT NULL` + FK), sehingga **tidak ada
perubahan perilaku produksi**.

**Tindakan.** Harness dilengkapi tabel + rantai katalog (katalog ACTIVE, request terikat katalog,
tanpa requirement). Hasil: **26/26 hijau**. Jumlah test turun 27 → 26 karena satu kasus
("non-external workforce harus ditolak") **memang dihapus** oleh koreksi bisnis PART 03B2D — pekerja
INTERNAL/CONTRACT/FREELANCE kini sah, dan padanan fail-closed-nya (binding vendor hilang/kedaluwarsa,
status pekerja nonaktif) tetap diuji pada suite yang sama.

**Justifikasi cakupan.** Ini cacat *blocking pada kesehatan test* yang **disebabkan branch ini**
(bukan warisan `main`), jadi wajib diperbaiki sebelum merge. Perilaku yang diuji tidak diubah:
default fixture tidak mengonfigurasi requirement, sehingga seluruh aturan admission/assignment lama
tetap bermakna; gate kompetensi sendiri diuji tuntas di `worker-competency-03b1` dan
`handyman-competency-assignment` terhadap skema nyata.

### 9.2 Koreksi dokumentasi handoff (bukan perubahan kode)

| # | Temuan | Koreksi |
| --- | --- | --- |
| D1 | Mobile handoff menyebut respons profil `data.*` | Sebenarnya `{ data: { profile: { … } } }` — diperbaiki |
| D2 | Mobile handoff menyebut profil butuh `tenant_company.read` | Sebenarnya **authentication saja** (profil diturunkan dari sesi) — diperbaiki |
| D3 | Operations handoff menyebut `GET /workforce?…` untuk daftar pekerja | Endpoint itu tidak ada; diganti `GET /organizations/{organizationId}/workforce-profiles` (+ varian departemen/tim, `workforce.read`) |

Verifikasi otomatis: **22 referensi path** di kedua handoff, **0** yang tidak ada di
`docs/api/openapi.yaml` (setelah normalisasi nama parameter).

### 9.3 Penambahan metadata kontrak OpenAPI

`POST /work-orders/{workOrderId}/assignments` dan
`PATCH /work-orders/{workOrderId}/assignments/{assignmentId}` kini memuat `x-error-codes`
yang benar-benar dilempar implementasi (`WORK_ORDER_CLASSIFICATION_REQUIRED`,
`WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED`, `WORK_ORDER_CLASSIFICATION_CONFLICT`,
`WORK_ORDER_ASSIGNMENT_ALREADY_ASSIGNED`, dst). Tidak ada rute/operasi baru; jumlah operasi
OpenAPI tidak berubah (paritas tetap 1.945/1.946).

### 9.4 Temuan di luar cakupan (TIDAK diubah, dilaporkan)

`tests/mobile-security-contract.test.ts` — 1 subtest gagal (`does not invent a checkpoint,
occurrence, or patrol-engine surface`). Penyebab: assertion memeriksa **seluruh** spec dengan regex
`/occurrences/`, sedangkan dua path yang terdeteksi
(`/form-instances/{id}/sections/{sectionId}/occurrences/{groupId}` dan
`/schedules/{scheduleId}/occurrences`) **sudah ada di `origin/main`** dan bertag
`Dynamic Forms` / `Schedules` — bukan permukaan Security yang "diciptakan". Test ini karena itu
sudah gagal sebelum branch ini; **bukan regresi** dan tidak menyentuh CR ini. Tidak diubah agar
tidak melemahkan sinyal keamanan di luar scope; direkomendasikan tiket terpisah (batasi regex ke
operasi bertag `Security`).

---

## 10. Hasil pengujian FINAL REVIEW (focused, PostgreSQL 18.4 sekali pakai)

| Suite | Hasil |
| --- | --- |
| `e2e-operational-lifecycle-04a` | **17/17** |
| `work-order-register` | **12/12** |
| `work-order-classification-03b2e` | **19/19** |
| `work-order-multitrade-03b2a` | **17/17** |
| `work-order-multiskill-03b2b` | **11/11** |
| `work-order-pg18-03b2c` | **6/6** |
| `handyman-direct-workforce-03b2d` | **20/20** |
| `worker-competency-03b1` | **14/14** |
| `handyman-competency-assignment` | **11/11** |
| `workforce-certifications` | **6/6** |
| `workforce-certifications-http` | **18/18** |
| `handyman-crew-worker-admission` (setelah perbaikan §9.1) | **26/26** |
| `handyman-visit-booking-authority` | **7/7** |
| `handyman-inspector-authority` | **32/32** |
| `data-isolation` (security check) | **15/15** |
| `config-perm-01-permission-registry` | **13/13** |
| `openapi-operational-final-parity` | **7/7** |
| `openapi-saas-route-parity` | **15/15** |
| `openapi-operational-structural-closure` | **8/8** |
| `openapi-contract` | **7/7** |
| `handyman-contract-freeze-03-openapi` | **13/13** |
| `npm run typecheck` | bersih |
| `npm run build` | bersih |
| Full suite | **tidak dijalankan** (sesuai instruksi) |

---

## 11. Breaking changes

**Tidak ada breaking change pada kontrak HTTP.** Seluruh perubahan bersifat aditif:

| Perubahan | Sifat |
| --- | --- |
| 7 migrasi baru | aditif; `0466` melonggarkan `vendor_id` (bukan menghapus) |
| 3 permission baru `workforce_certification.*` | aditif |
| Route baru (klasifikasi, trade category, requirement, sertifikasi, eligibility) | aditif |
| Profil pekerja: `individualCertifications` + `individualCertificateNumberModeled: true` | aditif (field lama tetap) |
| `POST /handyman/provider-contexts` menerima `clientId` | aditif (kontrak `vendorId` tetap) |
| Gate klasifikasi pada assignment WO Customer Care | **perubahan perilaku yang disengaja** oleh CR (409 jelas + dokumentasi) |
| Penghapusan syarat `workforce_type = 'EXTERNAL'` pada eligibility crew | **perubahan perilaku yang disengaja** (koreksi bisnis 03B2D) |
| `PATCH /work-orders/{id}/assignments/{assignmentId}` | tidak berubah bentuk body |

---

## 12. Risiko sisa

| # | Risiko | Tingkat | Mitigasi |
| --- | --- | --- | --- |
| R1 | Frontend belum memetakan `409` gate (klasifikasi/kompetensi) | Sedang | Handoff Operations §2–3 memuat seluruh kode + bentuk `details[]` |
| R2 | Role lapangan tanpa `evidence.manage` gagal di langkah bytes | Sedang | Bundel permission di handoff Mobile §6; tindakan konfigurasi, bukan kode |
| R3 | Belum ada `GET /handyman/provider-contexts/by-client/{clientId}` | Rendah | Simpan `id` dari respons 201; tercatat NON-BLOCKER pada gap matrix 04A |
| R4 | `mobile-security-contract` 1 subtest merah (pre-existing) | Rendah | Tidak terkait CR; tiket terpisah (§9.4) |
| R5 | Requirement `MANDATORY` yang salah konfigurasi dapat memblokir pekerjaan nyata | Sedang | Advisory + ledger keputusan + revalidasi; pelatihan Operations |
| R6 | Sertifikat kedaluwarsa di lapangan | Rendah | `certifications/expiring` + `isValid` pada profil |

---

## 13. Readiness integrasi frontend

| Tim | Kesiapan | Dokumen |
| --- | --- | --- |
| Operations | **SIAP** — klasifikasi, pemilihan pekerja, advisory, direct workforce, skill & sertifikat | `…PART04A_OPERATIONS_HANDOFF.md` |
| Mobile | **SIAP** — profil, feed assignment, eksekusi, bukti foto, attendance | `…PART04A_MOBILE_HANDOFF.md` |
| Backend | **SIAP MERGE TERKONTROL** — tidak ada blocker; migrasi dapat dijalankan sebagai satu langkah 459 → 466 | laporan ini |

**Urutan rilis yang disarankan:** jalankan migrasi (`0461–0467`) → deploy backend → aktifkan
permission `workforce_certification.*` pada role yang berwenang → integrasi Operations → integrasi
Mobile. Migrasi produksi **belum** dijalankan dan menjadi keputusan terpisah.
