# CR-HM-WORKER-COMPETENCY-01 — PART 03B2D Delivery Report

**Judul:** Direct Handyman Workforce Assignment — pekerja tetap / kontrak / freelance ditugaskan langsung
oleh Operations tanpa vendor perusahaan.
**Branch:** `arena/3df97f5e-handyman-backend` (basis PART 03B2C `9d6da19`).
**Tanggal:** 2026-10-23.
**Status:** selesai; `typecheck` + `build` bersih; suite fokus PART 03B2D **20/20 hijau**; OpenAPI parity
**20/20 hijau**; suite terkait yang menyentuh jalur vendor/assignment tetap hijau; suite yang gagal
selalu dibuktikan gagal juga pada baseline `9d6da19` (lihat §8).
Tidak ada PR, tidak ada merge, tidak ada deploy (Railway / Vercel / Coolify Biznet), tidak ada full-suite run.

---

## 1. Ringkasan

Model bisnis Handyman adalah **penyedia jasa langsung**. Customer Care dan Operations adalah bagian dari
organisasi Handyman sendiri; pekerja lapangan bisa **tetap**, **kontrak**, atau **freelance**, dan seluruhnya
dikelola oleh Operations. Status freelance adalah **hubungan kerja**, bukan bentuk perusahaan — karena itu
tidak boleh memaksa pembuatan vendor.

Sebelum PART 03B2D jalur assignment Handyman **berakar pada vendor** di tiga titik keras:

| # | Lokasi | Gejala |
| --- | --- | --- |
| 1 | `handyman_provider_contexts.vendor_id UUID NOT NULL UNIQUE` (migrasi `0384`) | satu-satunya "pool" pekerja adalah pool milik vendor; tanpa vendor tidak ada wadah pekerja |
| 2 | `createHandymanWorkerContext` langkah 4 (`handyman-worker-context.service.ts`) | wajib ada `vendor_workforce_bindings` ACTIVE untuk vendor yang sama, jika tidak `HANDYMAN_WORKFORCE_BINDING_REQUIRED` |
| 3 | `findEligibleHandymanWorker` (`handyman-worker-eligibility.repository.ts`) | mensyaratkan `workforce_profiles.workforce_type='EXTERNAL'` **dan** binding vendor ACTIVE → pekerja tetap & kontrak **secara struktural tidak bisa** masuk crew |

Konsekuensi praktis: untuk menugaskan pekerja tetap atau freelance, Operations harus membuat vendor fiktif
(atau menandai pegawainya sendiri sebagai `EXTERNAL`). Keduanya adalah workaround yang dilarang oleh
business rule.

PART 03B2D **tidak** membuat jalur assignment kedua. Yang diubah hanya **siapa yang memiliki pekerja**
(provider context: `VENDOR` atau `DIRECT`) dan **kapan binding vendor relevan** (hanya untuk `VENDOR`).
Otoritas assignment tetap satu: `handyman-scope-assignment.service.ts` — lock yang sama, invarian satu
`ACTIVE`, riwayat yang sama, evaluator kompetensi yang sama, ledger keputusan yang sama.

---

## 2. PART A — Audit

### 2.1 Alur yang diperiksa

`workforce_profiles` → `handyman_worker_contexts` → `handyman_work_crews` / `handyman_crew_memberships` /
`handyman_crew_leads` → `handyman_provider_availability` → `handyman_scope_assignment (service)` →
`handyman-dispatch` → `handyman-field-feed` → Mobile (`listMobileAssignments`, worker profile).

### 2.2 Pemakaian `vendor` / provider-context / binding pada jalur Handyman

| Area | Ketergantungan vendor | Sifat |
| --- | --- | --- |
| `handyman_provider_contexts.vendor_id` (`0384`) | `NOT NULL` + `UNIQUE`, FK ke `vendors` | **teknis**, bukan bisnis — satu-satunya wadah pool pekerja |
| `handyman_worker_contexts` (`0385`) | tidak menyimpan vendor; hanya `handyman_provider_context_id` | tidak langsung |
| `handyman_work_crews` / memberships / leads (`0386`) | tidak menyimpan vendor | tidak langsung |
| `createHandymanWorkerContext` | binding vendor wajib per langkah 4 | **bisnis lama** yang salah untuk pekerja sendiri |
| `findEligibleHandymanWorker` | `workforce_type='EXTERNAL'` + binding vendor ACTIVE | **bisnis lama** yang salah |
| `handyman-inspector-assignment.service.ts:198` | `fp.workforce_type='EXTERNAL'` pada kandidat inspector | **bisnis lama** yang salah (assignment scope) |
| `handyman-worker-profile.service.ts` (`CORE_WORKER_SELECT`) | `INNER JOIN vendors` + `providerCode`/`vendorId`/`employmentType` dari vendor | **proyeksi teknis** yang membuat pekerja sendiri tak terlihat |
| `handyman-dispatch/*`, `handyman-field-feed` | **tidak ada** referensi vendor/`EXTERNAL` | aman, tidak disentuh |
| `vendor-*`, `vendor-workforce`, `external-workforce`, `permit-workers` | memang domain vendor | **legacy dependency sah** — tidak dihapus |

### 2.3 Apakah tetap/kontrak/freelance sudah bisa didaftarkan dan ditugaskan?

Sebelum PART ini: **tidak**. `workforce_profiles.workforce_type` hanya mengizinkan
`INTERNAL | OUTSOURCED | CONTRACT | EXTERNAL` (migrasi `0024`/`0031`) sehingga "freelance" tidak punya
kosakata; dan walau profil `INTERNAL`/`CONTRACT` bisa dibuat, gerbang #3 membuatnya **mustahil ditugaskan**.

### 2.4 Gap matrix (existing / reuse / fix / new)

| Kebutuhan | Status | Tindakan |
| --- | --- | --- |
| Master orang (identitas, kontak, status) | **existing** | `workforce_profiles` + `users` — dipakai apa adanya |
| Skill multi-trade | **existing** | `workforce_skills` — tidak diubah |
| Sertifikat individual opsional | **existing** | `workforce_certifications` (PART 02) — tidak diubah |
| Penempatan Building | **existing** | `workforce_building_assignments` + `user_building_assignments` — tetap syarat admission |
| Crew, membership, lead append-only | **existing** | `0386`, tanpa perubahan skema |
| Otoritas assignment tunggal | **existing** | `handyman-scope-assignment.service.ts` — **dipakai ulang**, tidak diduplikasi |
| Evaluator kompetensi MANDATORY/RECOMMENDED | **existing** | `worker-competency-eligibility` — **dipakai ulang** |
| Ledger keputusan | **existing** | `handyman_assignment_competency_evaluations` (PART 03B1) — tetap append-only |
| Feed/dispatch Mobile | **existing** | sudah vendor-free — tidak diubah |
| Pool pekerja milik Handyman | **fix** | `provider_type` (`VENDOR`/`DIRECT`) + `vendor_id` nullable + 1 pool DIRECT per Client |
| Registrasi pekerja tanpa vendor | **fix** | binding hanya wajib untuk `VENDOR` |
| Admission pekerja tetap/kontrak/freelance | **fix** | predikat `workforce_type` diganti predikat **provider kind** |
| Kosakata "freelance" | **new** | nilai `FREELANCE` pada `workforce_type` |
| Proyeksi profil pekerja | **fix** | `LEFT JOIN vendors`, `providerType`, field vendor nullable |
| Kandidat inspector | **fix** | filter `workforce_type='EXTERNAL'` dihapus (admission tetap lewat satu gerbang) |

---

## 3. PART B — Implementasi

### 3.1 Migrasi `0466_direct_handyman_workforce` (aditif, backward compatible)

```
handyman_provider_contexts.provider_type TEXT NOT NULL DEFAULT 'VENDOR'   -- VENDOR | DIRECT
handyman_provider_contexts.vendor_id     -> DROP NOT NULL
CHECK  (provider_type='VENDOR' AND vendor_id IS NOT NULL)
    OR (provider_type='DIRECT' AND vendor_id IS NULL)
UNIQUE INDEX handyman_provider_contexts_direct_client_unique (client_id)
    WHERE provider_type='DIRECT'
workforce_profiles_workforce_type_check -> IN (INTERNAL, OUTSOURCED, CONTRACT, EXTERNAL, FREELANCE)
```

* Baris lama otomatis `VENDOR` → semantiknya **identik** dengan sebelum PART ini.
* `UNIQUE (vendor_id)` lama tetap ada; karena NULL boleh berulang, ia tetap membuktikan "satu context per
  vendor asli" tanpa memblokir baris `DIRECT`.
* CHECK identitas mencegah dua arah kesalahan sekaligus: vendor nyata tanpa `vendor_id`, dan pekerja sendiri
  yang "menempel" ke vendor palsu.
* `down()` menolak rollback bila sudah ada baris `DIRECT` (tidak menghapus data workforce secara diam-diam);
  diverifikasi: `provider_type` hilang setelah `migrateDown`, dan `vendor_id` kembali `NOT NULL`.

### 3.2 Pembuatan pool (`handyman-provider-context.service.ts`)

`createDirectHandymanProviderContext({ clientId })` membuat pool `DIRECT` untuk satu Client:
`clientId` diambil dari caller (tidak ada vendor untuk diturunkan), tetapi **akses Client diverifikasi**
lewat `contextAccessService.canAccessClient` — permission luas tidak pernah memperluas akses.
Satu pool per Client (409 `HANDYMAN_PROVIDER_CONTEXT_ALREADY_EXISTS`).

### 3.3 Registrasi pekerja (`handyman-worker-context.service.ts`)

Langkah 1–3 (provider ACTIVE, profil ACTIVE, rantai Client lewat organisasi) **tidak berubah**.
Langkah 4 dijalankan **hanya** bila `providerType === 'VENDOR'`; untuk `DIRECT` tidak ada binding yang diminta
karena memang tidak ada vendor. Jalur vendor tetap menolak tanpa binding.

### 3.4 Admission crew (`handyman-worker-eligibility.repository.ts`)

Predikat `fp.workforce_type='EXTERNAL'` **dihapus** dan diganti predikat kepemilikan:

```
pc.provider_type='DIRECT'
  OR (pc.provider_type='VENDOR' AND vendor ACTIVE dan binding vendor ACTIVE + efektif)
```

Semua syarat operasional lain dipertahankan: profil ACTIVE, organisasi se-Client, worker context ACTIVE,
penempatan Building ACTIVE + efektif, dan login + akses Building ACTIVE untuk Lead. Hasilnya satu aturan
admission untuk kedua jenis pool, bukan dua jalur paralel.

### 3.5 Proyeksi profil pekerja (`handyman-worker-profile.service.ts`)

`INNER JOIN vendors` → `LEFT JOIN`, ditambah `providerType`; `providerCode`, `vendorId`, `vendorStatus`
menjadi **nullable** untuk `DIRECT` (tidak ada kode yang dikarang). `employmentType` kini juga memetakan
`FREELANCE → FREELANCE`.

### 3.6 Kandidat inspector

Filter `fp.workforce_type='EXTERNAL'` dihapus dari daftar kandidat; admission tetap diputuskan satu gerbang
`findEligibleHandymanWorker`, sehingga pekerja tetap/kontrak/freelance bisa menjadi inspector tanpa aturan
kedua.

### 3.7 Yang **tidak** diubah

Modul `vendor-*`, `vendor-workforce`, `external-workforce`, `permit-workers` tetap utuh (legacy dependency sah;
`vendor_workforce_bindings` masih mensyaratkan profil `EXTERNAL` — itu kontrak vendor, bukan kontrak Handyman).
Dispatch, field feed, Mobile, RBAC, dan invarian assignment tidak disentuh.

---

## 4. Perubahan API

**Tidak ada operasi/route baru** (surface tetap 272 operasi Handyman; parity terjaga).

| Endpoint | Perubahan | Kompatibilitas |
| --- | --- | --- |
| `POST /handyman/provider-contexts` | body menerima **tepat satu** dari `vendorId` (VENDOR, perilaku lama) atau `clientId` (DIRECT). Keduanya/kosong → `VALIDATION_ERROR` | aditif; pemanggil lama hanya mengirim `vendorId` |
| `GET /handyman/provider-contexts/by-vendor/:vendorId` | tidak berubah | — |
| `POST /handyman/worker-contexts` | binding hanya wajib untuk pool VENDOR | pelonggaran terkontrol; dokumen OpenAPI diperbarui |
| `GET /handyman/field/me/profile`, `.../workers/:id/profile` | `providerAssociation.providerType` (baru), `providerCode`/`vendorId`/`vendorStatus` nullable | aditif |
| `GET /handyman/provider-availability?clientId=` | ikut menampilkan pool `DIRECT` beserta crew & lead | aditif (sumber data sama) |

`docs/api/openapi.yaml` diperbarui: `CreateHandymanProviderContextRequest`,
`HandymanProviderContextRecord`, provider association profil pekerja, deskripsi `CreateHandymanWorkerContextRequest`,
dan kosakata `employmentType`.

---

## 5. PART C — Pengujian

Suite baru: **`tests/handyman-direct-workforce-03b2d.test.ts`** (PostgreSQL embedded sekali pakai,
`/tmp/hm-direct-03b2d-pg`, port 55665) — **20/20 pass**.

| Grup | Kasus | Hasil |
| --- | --- | --- |
| D1 | pool DIRECT dibuat tanpa baris vendor | ✅ |
| D1 | pool DIRECT kedua untuk Client sama ditolak (409) | ✅ |
| D1 | pekerja `INTERNAL`/`CONTRACT`/`FREELANCE` terdaftar tanpa binding | ✅ |
| D1 | jalur VENDOR tetap ketat: tanpa binding ditolak | ✅ |
| D2 | Operations menugaskan crew pekerja **tetap** langsung | ✅ |
| D2 | menugaskan crew **freelance** tanpa vendor perusahaan (jumlah `vendors` tidak berubah) | ✅ |
| D2 | crew multi-pekerja (Lead + 2 anggota) dalam satu assignment ACTIVE | ✅ |
| D2 | Mobile menerima assignment yang benar (field feed Lead) | ✅ |
| D2 | profil pekerja DIRECT terproyeksi (`providerType=DIRECT`, vendor null, `employmentType=FREELANCE`) | ✅ |
| D3 | pekerja multi-skill lintas jenis pekerjaan | ✅ |
| D3 | MANDATORY terpenuhi → lolos; MANDATORY gagal → ditolak, **tidak ada** assignment/riwayat tertulis | ✅ |
| D3 | RECOMMENDED gagal → **warning**, assignment tetap ACTIVE | ✅ |
| D4 | penggantian pekerja: assignment lama SUPERSEDED, satu ACTIVE, riwayat `ASSIGNED`→`REASSIGNED`, ledger ASSIGNED/REASSIGNED | ✅ |
| D4 | pekerja INACTIVE ditolak (rantai Lead gagal lebih dulu — fail closed) | ✅ |
| D4 | pekerja tanpa penempatan Building ditolak | ✅ |
| D4 | isolasi Client: pool Client lain ditolak (`..._CONTEXT_MISMATCH`) | ✅ |
| D4 | rollback penuh saat target reassignment tidak valid (versi & riwayat utuh) | ✅ |
| D4 | data legacy VENDOR tetap bisa ditugaskan end-to-end | ✅ |
| D5 | parser body: tepat satu owner; keduanya/kosong/uuid salah → `VALIDATION_ERROR` | ✅ |

Perintah dan hasil:

```
npx tsx --test tests/handyman-direct-workforce-03b2d.test.ts      -> 20/20 pass
npm run typecheck                                                 -> exit 0
npm run build                                                     -> exit 0
npx tsx --test tests/openapi-contract.test.ts \
               tests/handyman-contract-freeze-03-openapi.test.ts  -> 20/20 pass (272 operasi, tidak berubah)
```

Suite terkait (regresi jalur vendor/assignment/profil):

| Suite | Hasil |
| --- | --- |
| `handyman-execution-scope-assignment-service.test.ts` | 10/10 ✅ |
| `handyman-competency-assignment.test.ts` | 11/11 ✅ |
| `handyman-inspector-authority.test.ts` | 32/32 ✅ |
| `handyman-worker-profile.test.ts` + `-schema-regression` | 9/9 ✅ |
| `handyman-execution-scope-assignments.test.ts` | 10/10 ✅ |
| `handyman-dispatch-authority.test.ts` | 10/10 ✅ |
| `handyman-provider-availability.test.ts` | 1 pass, 3 skip (tanpa DB) |

---

## 6. Penyesuaian fixture/tes lama (bukan perubahan perilaku)

| File | Alasan |
| --- | --- |
| `tests/handyman-worker-profile.test.ts` | DDL fixtur buatan tangan untuk `handyman_provider_contexts` belum punya `provider_type`/`vendor_id` nullable (proyeksi baru membacanya) |
| `tests/handyman-crew-worker-admission.test.ts`, `tests/handyman-inspector-authority.test.ts`, `tests/handyman-visit-booking-authority.test.ts` | TEMP TABLE fixture ditambah kolom `provider_type` (default `VENDOR`) agar sesuai skema hasil migrasi `0466` |
| `tests/handyman-inspector-authority.test.ts` | kasus "non-external workforce" dihapus: itu justru aturan yang dikoreksi PART 03B2D. Diganti kasus fail-closed lain yang setara (`user_id` profil dihapus) |
| `tests/handyman-crew-worker-admission.test.ts` | entri loop "non-external workforce" dihapus dengan komentar penunjuk ke suite 03B2D |

---

## 7. Konsekuensi di luar lingkup assignment (audit, tidak diubah)

| Area | Temuan |
| --- | --- |
| Payroll / fee freelance | tidak ada gerbang vendor pada perhitungan fee; fee tidak membaca `provider_type`. Tidak perlu perubahan |
| Attendance / work session | vendor-free; hanya membaca crew/lead/worker context |
| Evidence / QC / completion | vendor-free; tidak membaca provider context |
| Dispatch release | vendor-free (diverifikasi dengan pembacaan SQL + `handyman-dispatch-authority` 10/10) |
| Sertifikasi wajib | tetap opt-in per requirement; tidak ada sertifikasi wajib global |

---

## 8. Catatan kegagalan yang **bukan** regresi PART 03B2D

| Suite | Status |
| --- | --- |
| `handyman-crew-worker-admission.test.ts` | 8 kasus gagal dengan `relation "service_catalog" does not exist` — TEMP fixture suite ini tidak pernah ditambah tabel competency sejak PART 03A. Di luar perubahan PART ini (tidak ada query competency yang disentuh) |
| `handyman-visit-booking-authority.test.ts` | gagal 7/7 juga pada baseline `9d6da19` (dibuktikan dengan `git stash` + run ulang) |
| `handyman-worker-context.test.ts`, `handyman-provider-api.test.ts` | seluruh kasus skip karena tidak ada PostgreSQL eksternal di sandbox |
| `work-order-register` dan pin OpenAPI lama | sudah tercatat sebagai stale/pre-existing pada PART sebelumnya; tidak dikejar |

---

## 9. Berkas yang berubah

```
src/database/migrations/0466_direct_handyman_workforce.ts          (baru)
src/database/migrations/index.ts
src/modules/handyman-providers/handyman-provider-context.types.ts
src/modules/handyman-providers/handyman-provider-context.repository.ts
src/modules/handyman-providers/handyman-provider-context.service.ts
src/modules/handyman-providers/handyman-worker-context.service.ts
src/modules/handyman-providers/handyman-worker-eligibility.repository.ts
src/modules/handyman-providers/index.ts
src/modules/handyman-provider-api/handyman-provider-api.validation.ts
src/modules/handyman-provider-api/handyman-provider-api.controller.ts
src/modules/handyman-inspector-assignments/handyman-inspector-assignment.service.ts
src/modules/handyman-worker-profile/handyman-worker-profile.types.ts
src/modules/handyman-worker-profile/handyman-worker-profile.service.ts
src/modules/workforce/workforce.types.ts
docs/api/openapi.yaml
tests/handyman-direct-workforce-03b2d.test.ts                      (baru)
tests/handyman-worker-profile.test.ts
tests/handyman-crew-worker-admission.test.ts
tests/handyman-inspector-authority.test.ts
tests/handyman-visit-booking-authority.test.ts
docs/handyman/CR-HM-WORKER-COMPETENCY-01_PART03B2D_DELIVERY_REPORT.md (baru)
docs/handyman/CR-HM-WORKER-COMPETENCY-01_PART03B_BACKLOG.md
```

## 10. Aturan yang harus dipertahankan setelah PART ini

1. **Jangan** membuat vendor untuk pekerja freelance/tetap/kontrak, dan **jangan** menandai pegawai sendiri
   sebagai `EXTERNAL` hanya agar bisa ditugaskan.
2. Kepemilikan pekerja ditentukan oleh `provider_type` pool, **bukan** oleh `workforce_type` orang.
3. Binding vendor hanya relevan untuk pool `VENDOR`; pool `DIRECT` tidak pernah meminta binding.
4. Satu pool `DIRECT` per Client — jangan menambah pool kedua sebagai "workaround".
5. Assignment tetap lewat `handyman-scope-assignment.service.ts` (satu otoritas, satu invarian satu-ACTIVE).
6. MANDATORY memblokir; RECOMMENDED hanya warning; jangan menambah sertifikasi wajib global atau aturan
   "trade pekerja == trade pekerjaan".
7. Jangan menghapus modul `vendor-*` selama masih ada data/workflow vendor yang sah.
