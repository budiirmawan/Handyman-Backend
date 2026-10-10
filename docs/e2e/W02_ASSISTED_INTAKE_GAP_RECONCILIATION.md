# W02 Assisted Intake — Gap Reconciliation (Pre-Coding)

Status: **review dan dokumentasi saja**. Dokumen ini tidak mengubah API, schema, business logic, atau frontend.

- Authority: Handyman Business Journey v1.3 (FROZEN).
- Branch: `arena/c6fc25e1-handyman-backend`. Baseline: `7817a11` (W02 PART 01).
- Cakupan: journey assisted request intake dari Tenant/PIC yang datang ke Customer Care sampai request masuk Operations untuk triage.
- Di luar cakupan: audit W01 (tidak diulang), security audit yang sudah selesai, Work Order, QC, BAST, CLOSE, payment engine, dan frontend.
- Frontend tidak ada di repo ini. Setiap klaim tentang frontend ditandai **UNVERIFIED**. Tidak ada klaim E2E lintas repo.
- Tidak ada bukti runtime baru dalam dokumen ini. Setiap status EXISTING atau PARTIAL berasal dari pembacaan source, route, dan OpenAPI. Bukti runtime hanya ada untuk PART 01 di `docs/e2e/W02_ASSISTED_REQUEST_INTAKE.md`.

Legenda status: **EXISTING** (implementasi ada dan dipakai), **PARTIAL** (ada sebagian, celah tercatat), **MISSING** (tidak ditemukan setelah pencarian di source, schema, route, dan OpenAPI), **UNVERIFIED** (perlu bukti runtime atau berada di repo lain).

Legenda severity: **P0** memblokir closure W02 atau menyangkut authz, otoritas, atau data akses. **P1** diperlukan agar journey lengkap. **P2** perbaikan lanjutan.

Rekomendasi: **REUSE** (pakai apa adanya), **FIX** (perbaiki yang ada), **EXTEND** (perluas yang ada), **NEW** (buat baru, hanya setelah keputusan disetujui).

---

## 1. Evidence Matrix

Setiap baris memuat status, bukti (file, fungsi, route, atau tabel), dampak bisnis dan security, kategori, severity, dan rekomendasi.

| ID | Area | Status | Evidence | Dampak bisnis / security | Kategori | Sev | Rek. |
|---|---|---|---|---|---|---|---|
| G01 | Customer Care admission, session, dan revoke | EXISTING | `src/modules/handyman-care-workspace/care-workspace.routes.ts` (admit, `revokeCareWorkspaceSession` pada `DELETE`). OpenAPI `/handyman/care/session` (post, delete). Test `handyman-care-workspace-admission*.test.ts`. | Sesi CC terikat actor. Revoke tersedia. Kontrol throttle ada di test admission. | Backend | — | REUSE |
| G02 | Provisioning dan revoke permission care actor | EXISTING | `src/modules/handyman-care-actors/handyman-care-actor-permission.service.ts` (REVOKED, audit). PART 06 menambah grant `handyman.payment.report` dengan audit `HANDYMAN_CARE_ACTOR_PERMISSION_GRANTED` / `_REVOKED`. Trigger guard memblokir DELETE pada grant. | Grant tidak otomatis. Revoke lewat UPDATE status. | Backend | — | REUSE |
| G03 | Pemilihan Tenant Company | EXISTING | OpenAPI `GET /handyman/care/properties/{propertyId}/tenant-companies`. Repository `care-workspace-tenants.repository.ts`. Test `handyman-care-workspace-tenants.test.ts`. | Tenant dipilih dalam scope property CC. | Backend | — | REUSE |
| G04 | Property, building, space, occupancy | EXISTING | OpenAPI `GET .../occupancies`, `GET .../spaces`. Body create-exchange: `buildingId`, `spaceId?`. Tabel `handyman_service_requests` memiliki `building_id`, `space_id`. | Lokasi request terikat building dan unit. | Backend | — | REUSE |
| G05 | Actual reporter (siapa yang melapor) | MISSING | Migration 0378 (`handyman_service_requests`) tidak punya kolom reporter. Body `POST /handyman/requests/care` (`parseCreateCareHandymanServiceRequestBody`, `handyman-api.validation.ts`) hanya menerima `exchangeToken`, `serviceCatalogId`, `serviceVariantId`, `description`. Field lain ditolak. | Tanpa reporter, Operations tidak tahu siapa yang meminta. Keputusan bisnis D1 diperlukan. | Keputusan bisnis + backend | **P0** | NEW (setelah D1) |
| G06 | Contact person dan fallback kontak | PARTIAL | Tabel `tenant_companies` (0144) punya email dan phone. Tabel `tenant_pics` (0145) punya `pic_name`, `email`, `phone`, `is_primary`. Tidak ada snapshot kontak per request. | Kontak sumber ada, tetapi tidak tercatat di request. | Keputusan bisnis + backend | P1 | EXTEND (setelah D3) |
| G07 | Link PIC di request | PARTIAL | Kolom `tenant_pic_id` (nullable) di 0378. `POST /handyman/requests/care` mengisinya `null`. Create workspace menolak `tenantPicId` di body (400). Assertion BM mengisi dari klaim. | Request dari CC tidak punya PIC. Beneficiary dan approver belum terpisah. | Backend + keputusan | P1 | Keputusan D1, D2 |
| G08 | Otoritas approval quotation oleh tenant PIC | MISSING | `POST /handyman/quotation-versions/:id/decision` dikerjakan User lokal dengan `assertQuotationThreadBuildingAccess`. `GET /handyman/requests/:id/quotation/presented` hanya read. Tidak ada jalur approval dari PIC yang terverifikasi. | Quotation tidak bisa disetujui tenant. Ini kebutuhan bisnis yang belum punya mekanisme. | Keputusan bisnis + backend | **P0** | NEW (setelah D2) |
| G09 | Otoritas read request berbasis occupancy | EXISTING | `customerRequestReadScope` di `handyman-service-request.repository.ts` (sekitar baris 184). Mensyaratkan link PIC aktif atau PLATFORM_ADMIN dan occupancy efektif. Wall C6 tidak dilonggarkan. | Dinding per baris. Tidak ada shortcut satu client. | Backend | — | REUSE |
| G10 | Service category dan variant | EXISTING | Kolom `service_catalog_id`, `service_variant_id` di 0378. Body care: `serviceCatalogId` wajib, `serviceVariantId` opsional. Catalogue: `care-workspace-catalogue.service.ts`. | Kategori layanan tervalidasi. | Backend | — | REUSE |
| G11 | Deskripsi masalah | EXISTING | Kolom `description` (1–1000 karakter) di 0378. Validasi di parser body care. | Deskripsi wajib ada dan dibatasi panjangnya. | Backend | — | REUSE |
| G12 | Priority atau urgency | MISSING | Grep `priority\|urgen` di `src/modules/handyman-*` tidak menemukan kolom atau field intake. Modul legacy `tenant-service-requests` punya `priority`, tetapi itu jalur Work Order. | Operations tidak bisa membedakan urgensi. Perlu keputusan apakah Handyman membutuhkannya (D7). | Keputusan bisnis + backend | P1 | NEW (setelah D7), jangan duplikasi dari legacy tanpa keputusan |
| G13 | Foto dan attachment saat intake | PARTIAL | `GET/POST /handyman/requests/:id/intake-evidence` (modul `handyman-evidence`, PHOTO dan VIDEO bounded). POST memakai `tenant_company.manage`. Route ini tidak ada di route workspace CC. | Foto hanya bisa diunggah User lokal. CC tidak bisa melampirkan bukti saat assisted intake tanpa jalur baru. | Backend | P1 | EXTEND atau FIX (setelah D8) |
| G14 | Create-exchange dan assisted create | EXISTING | `POST /handyman/care/properties/:propertyId/create-exchanges` (201, CARE_CREATE, single-use, TTL maks 120 detik). `POST /handyman/requests/care` (201, INTAKE, `createdByUserId` null, attribution `CUSTOMER_CARE`). Service `care-create-exchange.service.ts`. Test `handyman-care-workspace-create-exchange.test.ts` (describe W02 PART 01, 5 test). | Alur create tervalidasi dan token tidak bisa dipakai ulang. | Backend | — | REUSE |
| G15 | Request ID atau nomor request | PARTIAL | Hanya UUID `id`. Tidak ada nomor yang bisa dibaca manusia. Grep `request_number\|requestNumber` tidak menemukan hasil. | Referensi lisan CC–Operations sulit. | Keputusan bisnis (D8) | P2 | Keputusan D8 |
| G16 | Idempotency dan replay create | PARTIAL | Exchange token single-use (sudah diuji di PART 01). Pola `Idempotency-Key` ada di quotation decision. Idempotency pada create request belum terbukti. | Double-submit dari CC belum terbukti tertangani di level request. | Backend | P1 | VERIFY lalu EXTEND |
| G17 | Kebijakan duplicate request | MISSING | Tidak ditemukan cek duplicate pada `createHandymanServiceRequest` atau create care. Grep di modul Handyman tidak menemukan logika dedupe. | Request ganda masuk ke Operations. Keputusan bisnis D4. | Keputusan bisnis + backend | P1 | NEW (setelah D4) |
| G18 | Readback list dan detail CC | EXISTING | OpenAPI `GET /handyman/care/requests` dan `GET /handyman/care/requests/{requestId}`. Test `handyman-care-workspace-requests.test.ts` dan `request-detail.test.ts`. Scope `care-workspace-requests.service.ts`. | CC bisa membaca request yang boleh dilihat. | Backend | — | REUSE |
| G19 | Historical ownership setelah occupancy turnover | PARTIAL | `customerRequestReadScope` mensyaratkan occupancy efektif. Setelah turnover, tenant lama kehilangan akses baca. PLATFORM_ADMIN tetap bisa membaca historis di building yang di-assign. Tidak ada aturan tertulis untuk ownership historis. | Visibilitas historis belum punya keputusan. Mengubah wall tanpa keputusan dilarang. | Keputusan bisnis + backend | P1 | Keputusan D5 |
| G20 | Handoff ke Operations queue | MISSING | Route inventory `handyman-api.routes.ts` dan `handyman-lifecycle-api.routes.ts` tidak memiliki endpoint queue untuk Operations. `GET /handyman/requests` memakai `customerRequestReadScope`, sehingga queue hanya terlihat PIC atau PLATFORM_ADMIN. Triage (`POST /handyman/requests/:id/triage`) memakai `tenant_company.manage` dan `assertBuildingScopedResourceAccess`, tetapi tidak menyediakan daftar. | Operations tidak punya antrean intake. Ini celah utama journey. | Backend | **P0** | NEW (building-scoped queue, setelah D6) |
| G21 | Triage, referral, dan assignment | EXISTING | `handyman-request-triage.service.ts` (INTAKE menuju TRIAGE, audit `HANDYMAN_REQUEST_TRIAGED` di baris 167). Referral (`handyman-request-referral.service.ts`, event `HANDYMAN_REFERRAL_CREATED`). Crew Lead designation (`HANDYMAN_CREW_LEAD_DESIGNATED`). | Triage tersedia setelah request ditemukan. Penemuan request tetap bergantung pada G20. | Backend | — | REUSE |
| G22 | Notifikasi Operations saat intake | MISSING | Kontrak notifikasi punya `HANDYMAN_REQUEST_TRIAGED` dan `HANDYMAN_REFERRAL_CREATED`, tetapi tidak ada emitter di luar modul kontrak. Tidak ada `HANDYMAN_REQUEST_CREATED`. | Operations tidak diberi tahu saat request baru masuk. | Backend | P1 | NEW (event dan emitter) |
| G23 | Audit dan provenance create | PARTIAL | Provenance tersimpan: attribution `CUSTOMER_CARE`, assertion receipt, exchange row. Audit operasional hanya ada di triage, diagnosis, inspection, referral. Create request tidak menulis event operasional. | Provenance ada. Jejak audit create belum ada. | Backend | P1 | EXTEND |
| G24 | Pembatalan atau withdrawal request | MISSING | Vocabulary status di 0378, 0380, 0382: INTAKE, TRIAGE, INSPECTION_REQUIRED, DIAGNOSIS, READY_FOR_NEXT_STEP, REFERRED. Tidak ada cancel. Komentar di `handyman-api.controller.ts` (baris 33) menyebut cancellation hanya INTAKE yang ada. | Request salah input tidak bisa dibatalkan dari CC. Frozen journey membatasi ini. Keputusan D7. | Keputusan bisnis | P1 | Keputusan D7 |
| G25 | Kontrak OpenAPI | EXISTING | Semua path di atas terdaftar di `docs/api/openapi.yaml`: `/handyman/requests/care`, `/handyman/care/*`, `/handyman/requests/{id}/intake-evidence`, `/triage`, `/quotation/presented`, `/status-visibility`. | Kontrak tersedia. Respons skema belum dibandingkan dengan frontend. | Backend | — | REUSE |
| G26 | Frontend Customer Care | UNVERIFIED | Tidak ada di repo ini. | Tidak bisa dinyatakan siap. | Frontend (repo lain) | — | VERIFY di repo CC |
| G27 | Frontend Operations queue | UNVERIFIED | Tidak ada di repo ini. Queue backend sendiri MISSING (G20). | Tidak bisa dinyatakan siap. | Frontend (repo lain) | — | VERIFY setelah G20 |
| G28 | Intake Work Order legacy (`tenant-service-requests`) | EXISTING (di luar Handyman) | `POST /tenant-companies/:id/service-requests` memiliki `reporterName`, `reporterPhone`, `reporterEmail`, `priority`, dan `tenantPicId` wajib. Route building: `GET /buildings/:buildingId/tenant-service-requests`. Jalur Work Order. | Tidak boleh diduplikasi ke Handyman tanpa keputusan. Tidak dipakai W02. | Backend | — | Jangan dipakai untuk W02 |
| G29 | Runtime visibility queue untuk Operations (local User tanpa PIC) | UNVERIFIED | Dinding `customerRequestReadScope` secara source hanya mengizinkan PIC atau PLATFORM_ADMIN. Belum ada run runtime yang membuktikan bahwa User Operations biasa tidak melihat request. | Jika benar, Operations tidak bisa menemukan request. Jika salah, ada celah atau kontrak berbeda. | Backend (verifikasi) | **P0** | VERIFY runtime sebelum PART 08 |

### Ringkasan status

| Status | Jumlah | ID |
|---|---|---|
| EXISTING | 12 | G01, G02, G03, G04, G09, G10, G11, G14, G18, G21, G25, G28 |
| PARTIAL | 7 | G06, G07, G13, G15, G16, G19, G23 |
| MISSING | 7 | G05, G08, G12, G17, G20, G22, G24 |
| UNVERIFIED | 3 | G26, G27, G29 |
| **Total** | **29** | |

Daftar P0: **G05** (actual reporter), **G08** (otoritas approval quotation oleh PIC), **G20** (queue Operations), **G29** (verifikasi runtime visibility queue).

---

## 2. Journey Gap Map

Journey dibaca dari kiri ke kanan. Setiap tahap memuat status keseluruhan dan gap yang terkait.

| Tahap | Deskripsi | Status | Gap |
|---|---|---|---|
| S0 | Tenant/PIC menghubungi CC, identitas pelapor dicatat | MISSING | G05, G06 |
| S1 | CC admission dan sesi | EXISTING | G01, G02 |
| S2 | Pilih Tenant Company, property, building, space, occupancy | EXISTING | G03, G04 |
| S3 | Create-exchange (token single-use) | EXISTING | G14 |
| S4 | Assisted create: kategori, deskripsi, request masuk sebagai INTAKE | EXISTING (kecuali priority) | G10, G11, G12, G14, G16 |
| S5 | Duplicate check dan idempotency | MISSING / PARTIAL | G16, G17 |
| S6 | Lampiran foto dan bukti | PARTIAL | G13 |
| S7 | Readback CC (list dan detail) | EXISTING | G09, G18 |
| S8 | Notifikasi dan audit create | MISSING / PARTIAL | G22, G23 |
| S9 | Handoff ke Operations queue | MISSING | G20, G29 |
| S10 | Triage, referral, assignment | EXISTING | G21 |
| S11 | Approval quotation oleh tenant PIC | MISSING | G07, G08 |
| S12 | Visibilitas historis setelah turnover | PARTIAL | G19 |
| S13 | Pembatalan atau koreksi request | MISSING | G24 |
| — | Frontend CC dan Operations | UNVERIFIED | G26, G27 |

Titik putus utama: S0 (reporter), S9 (queue Operations), dan S11 (approval PIC). S9 bergantung pada verifikasi G29.

---

## 3. Backend and Frontend Contract

### 3.1 Backend (sudah ada, hanya REUSE kecuali dinyatakan lain)

| Endpoint | Auth dan authz | Body atau query | Respons | Catatan |
|---|---|---|---|---|
| `POST /api/v1/handyman/care/session` | Admission CC | Credential assertion | Sesi | Revoke lewat `DELETE` |
| `DELETE /api/v1/handyman/care/session` | Sesi CC | — | — | Revoke sesi |
| `GET /api/v1/handyman/care/properties/:propertyId/tenant-companies` | Sesi CC, scope property | — | Daftar tenant | G03 |
| `GET /api/v1/handyman/care/properties/:propertyId/occupancies` | Sesi CC, scope property | — | Daftar occupancy | G04 |
| `GET /api/v1/handyman/care/properties/:propertyId/spaces` | Sesi CC, scope property | — | Daftar space | G04 |
| `POST /api/v1/handyman/care/properties/:propertyId/create-exchanges` | Sesi CC, `tenantCompanyId`, `buildingId`, `spaceId?` | `{tenantCompanyId, buildingId, spaceId?}` | 201, exchange CARE_CREATE, TTL maks 120 detik, single-use | G14 |
| `POST /api/v1/handyman/requests/care` | Exchange token | `{exchangeToken, serviceCatalogId, serviceVariantId?, description}`. Field lain ditolak (400). `tenantPicId` ditolak. | 201, status INTAKE, `tenantPicId` null, `createdByUserId` null, attribution `CUSTOMER_CARE` | G14, G05, G07 |
| `GET /api/v1/handyman/care/requests` | Sesi CC, `customerRequestReadScope` | `status`, `channelAttributionId`, `limit`, `cursor` | Daftar | G18 |
| `GET /api/v1/handyman/care/requests/:requestId` | Sesi CC, `customerRequestReadScope` | — | Detail | G18 |
| `GET /api/v1/handyman/requests` | `customerRequestReadScope` (PIC atau PLATFORM_ADMIN) | — | Daftar | G29. Bukan queue Operations. |
| `GET /api/v1/handyman/requests/:id` | Building scope | — | Detail | Ada, tetapi dibatasi scope |
| `GET/POST /api/v1/handyman/requests/:id/intake-evidence` | `tenant_company.read` / `tenant_company.manage` | Foto atau video | Daftar atau 201 | G13 |
| `POST /api/v1/handyman/requests/:id/triage` | `handyman.operations.request.triage`, building scope (W02 PART 04A; sebelumnya `tenant_company.manage`) | Keputusan triage | — | G21 |
| `GET /api/v1/handyman/requests/:id/status-visibility` | Ada (sla-status-api) | — | Status | Belum diverifikasi lebih lanjut |
| `GET /api/v1/handyman/requests/:id/quotation/presented` | `tenant_company.read` | — | Versi yang disajikan | Read only (G08) |
| `POST /api/v1/handyman/quotation-versions/:id/decision` | User lokal, building access | Keputusan dan `Idempotency-Key` | — | Bukan PIC (G08) |

### 3.2 Backend yang perlu ditambahkan (NEW, setelah keputusan)

Tidak ada endpoint baru dibuat dalam dokumen ini. Kandidat kontrak berikut hanya rancangan dan memerlukan persetujuan.

| Kandidat | Gap | Keputusan prasyarat |
|---|---|---|
| Queue Operations: `GET /api/v1/handyman/requests?status=INTAKE&buildingId=` dengan scope building (bukan `customerRequestReadScope`) | G20 | D6 |
| Snapshot reporter pada create care (`reportedBy: {name, phone, email}`, opsional, dicatat CC) | G05 | D1, D3 |
| Event `HANDYMAN_REQUEST_CREATED` dan emitter-nya | G22 | Disetujui |
| Upload evidence dari sesi CC (jika disetujui) | G13 | D8 |
| Approval quotation oleh PIC terverifikasi | G08 | D2 |

Tidak ada duplikasi endpoint untuk tiga frontend yang sudah ada.

### 3.3 Frontend contract (UNVERIFIED)

- **Customer Care**: harus memanggil alur admission, property, create-exchange, lalu `POST /handyman/requests/care` dalam satu transaksi logis. Token exchange hanya dipakai sekali. Respons 400 `tenantPicId` harus ditangani. **UNVERIFIED**: implementasi frontend tidak ada di repo ini.
- **Operations**: harus membaca queue INTAKE setelah G20 tersedia. Saat ini frontend tidak punya endpoint queue yang valid untuk User biasa. **UNVERIFIED**.
- **Lintas repo**: tidak ada klaim E2E lintas repo dalam dokumen ini.

---

## 4. Security Invariants

Invariant berikut harus tetap benar pada semua PART. Setiap PART wajib menyertakan test negatif untuk invariant yang relevan.

| ID | Invariant | Bukti yang ada | Status |
|---|---|---|---|
| SI-01 | Sesi CC hanya bisa membuat request untuk tenant, building, dan space di dalam scope property grant | create-exchange scope (`care-create-exchange.scope.ts`), test create-exchange | EXISTING |
| SI-02 | Exchange token single-use dan kedaluwarsa dalam 120 detik | W02 PART 01 test, `care-create-exchange.service.ts` | EXISTING |
| SI-03 | CC tidak bisa menetapkan `tenantPicId`, `createdByUserId`, status, atau priority dari body | Parser body care menolak field lain (400) | EXISTING (priority belum ada, G12) |
| SI-04 | Read request memakai `customerRequestReadScope` tanpa shortcut satu client, dan tidak dilonggarkan | `handyman-service-request.repository.ts` | EXISTING |
| SI-05 | PLATFORM_ADMIN hanya membaca historis pada building yang di-assign | Komentar dan SQL `customerRequestReadScope` | EXISTING |
| SI-06 | Operations queue tidak boleh menampilkan request lintas building | Belum ada queue. Wajib `assertBuildingScopedResourceAccess` | **MISSING** (G20) |
| SI-07 | Approval quotation hanya oleh otoritas yang terverifikasi, bukan CC dan bukan User lokal yang tanpa scope | Saat ini User lokal dengan building access. Belum ada PIC approval | **PARTIAL** (G08) |
| SI-08 | Permission `tenant_company.manage` tidak diberikan secara implisit kepada CC melalui workspace | Evidence write hanya di route manage | EXISTING, pantau bila G13 diubah |
| SI-09 | Tidak ada pelemahan constraint DB untuk memperbaiki fixture | Aturan proyek | EXISTING |
| SI-10 | Tidak ada role name sebagai authority; permission dari RBAC | Aturan PART 05 dan 06 | EXISTING |
| SI-11 | Pelapor tidak boleh memverifikasi transaksinya sendiri (maker-checker) | Aturan PART 04 untuk payment | Berlaku untuk approval PIC (D2) |
| SI-12 | Frozen journey tidak diubah diam-diam | Authority v1.3 | Berlaku untuk semua keputusan |

---

## 5. Decision Register

Setiap keputusan memuat rekomendasi. Tidak ada aturan frozen yang diubah dalam dokumen ini. Semua keputusan membutuhkan persetujuan.

| ID | Pertanyaan | Opsi | Rekomendasi | Dampak jika tidak diputuskan |
|---|---|---|---|---|
| D1 | Actual reporter vs tenant beneficiary vs PIC approver | (a) Pisahkan: reporter sebagai snapshot teks, beneficiary = tenant company, approver = PIC. (b) Gunakan `tenant_pic_id` sebagai reporter. | **(a)**. Snapshot reporter (nama, telepon, email, opsional) dicatat CC. Beneficiary tetap tenant. Approver adalah PIC terverifikasi (D2). | G05 tetap P0. Tidak bisa mulai PART 09. |
| D2 | Sumber otoritas PIC | (a) `tenant_pics.is_primary` dan `user_id` yang aktif. (b) Penunjukan per request. | **(a)**, dengan approval hanya dari sesi PIC yang terautentikasi dan memiliki link aktif ke tenant. CC tidak boleh menyetujui atas nama PIC. | G08 tetap P0. |
| D3 | Fallback kontak | Urutan: reporter snapshot, lalu PIC primary, lalu email atau phone tenant company. | Urutan tersebut. Setiap nilai diberi sumber agar bisa diaudit. | G06 tetap P1. |
| D4 | Kebijakan duplicate | (a) Blokir otomatis. (b) Peringatan dan konfirmasi eksplisit CC. (c) Merge diam-diam. | **(b)**. Cocok berdasarkan tenant, space atau building, kategori, dan request INTAKE atau TRIAGE terbuka dalam 7 hari. Tidak ada merge diam-diam. | G17 tetap P1. Risiko request ganda. |
| D5 | Visibilitas historis setelah occupancy turnover | (a) Pertahankan wall C6 (tenant lama kehilangan akses). (b) Beri akses historis terbatas untuk request yang dibuat tenant tersebut. | **(a)** sebagai default. Wall tidak dilonggarkan. Akses historis hanya lewat keputusan eksplisit. Operations tetap melihat via building scope. | G19 tetap P1. |
| D6 | Otoritas handoff dan queue Operations | (a) Scope building untuk pengguna dengan `tenant_company.read` atau `manage` yang di-assign ke building. (b) Perluas `customerRequestReadScope` agar mencakup Operations. | **(a)**, scope baru yang eksplisit, dengan `assertBuildingScopedResourceAccess`. **(b) ditolak** karena melonggarkan dinding C6. | G20 dan G29 tetap P0. |
| D7 | Priority, cancel, dan koreksi request | (a) Tambah priority dan cancel. (b) Tunda ke fase lanjutan. | **(b)** untuk W02. Journey frozen hanya mengizinkan INTAKE. Jika bisnis membutuhkannya, buat keputusan terpisah dan jangan menduplikasi legacy. | G12 dan G24 tetap P1. |
| D8 | Lampiran dari sesi CC | (a) Route evidence baru untuk CC dengan permission baru. (b) Tidak ada, CC meminta lampiran lewat Operations. (c) Route yang sama dengan permission `tenant_company.manage` untuk CC. | **(a)** hanya jika disetujui. Permission baru harus dinamai dan diberikan lewat RBAC, bukan role. **(c)** ditolak (SI-08). | G13 tetap P1. |
| D9 | Nomor request yang bisa dibaca manusia | (a) Tambah kolom nomor. (b) Pakai UUID saja. | **(b)** untuk W02. Tambah nomor hanya bila ada kebutuhan referensi lisan yang disetujui. | G15 tetap P2. |

---

## 6. PART Breakdown (berdasarkan dependency dan severity)

Urutan berikut mengikuti dependency. Tidak ada PART yang dimulai sebelum prasyarat disetujui.

| PART | Judul | Sev | Kategori | Dependency | Isi singkat | Batas |
|---|---|---|---|---|---|---|
| W02-PART-07 | Gate keputusan | P0 | Keputusan bisnis | — | Persetujuan D1 sampai D9 | Dokumen dan keputusan saja |
| W02-PART-08 | Verifikasi runtime visibility queue (G29) | P0 | Backend (verifikasi) | PART-07 | Test runtime User Operations tanpa PIC terhadap `GET /handyman/requests` | Tanpa perubahan kode produksi |
| W02-PART-09 | Queue Operations berbasis building (G20) | P0 | Backend | PART-07 (D6), PART-08 | Endpoint list INTAKE dengan building scope, test lintas building negatif | Wall C6 tidak diubah |
| W02-PART-10 | Snapshot reporter dan fallback kontak (G05, G06) | P0 | Backend + migrasi | PART-07 (D1, D3) | Kolom snapshot opsional, validasi, test | Tanpa melemahkan constraint DB |
| W02-PART-11 | Approval quotation oleh PIC (G08) | P0 | Backend | PART-07 (D2), PART-10 | Jalur approval PIC terautentikasi, test negatif CC dan User lokal | Tidak mengubah quotation engine |
| W02-PART-12 | Event dan audit create request (G22, G23) | P1 | Backend | PART-09 | `HANDYMAN_REQUEST_CREATED`, emitter, audit create | Tanpa perubahan triage |
| W02-PART-13 | Idempotency dan duplicate warning (G16, G17) | P1 | Backend | PART-07 (D4) | Peringatan duplicate, replay create | Tidak ada merge otomatis |
| W02-PART-14 | Lampiran dari CC (G13) | P1 | Backend | PART-07 (D8) | Route evidence sesuai D8 | Tanpa permission default |
| W02-PART-15 | Visibilitas historis (G19) | P1 | Backend + test | PART-07 (D5) | Test turnover, keputusan D5 | Wall tidak dilonggarkan |
| W02-PART-16 | Priority, cancel, nomor (G12, G15, G24) | P2 | Keputusan + backend | PART-07 (D7, D9) | Hanya jika disetujui | Tidak duplikasi legacy |
| W02-FE-TRACK | Verifikasi frontend CC dan Operations (G26, G27) | P1 | Frontend (repo lain) | PART-09 | Verifikasi kontrak, bukan implementasi di repo ini | Tidak ada klaim E2E sebelum bukti runtime |

Urutan eksekusi: PART-07, lalu PART-08 dan PART-10 secara paralel, lalu PART-09 dan PART-11, lalu PART-12 sampai PART-15, lalu PART-16 bila disetujui.

---

## 7. Acceptance Criteria untuk Closure W02

W02 dianggap selesai hanya jika seluruh kriteria berikut terpenuhi dengan bukti yang bisa diulang. Bukti runtime wajib, bukan hanya source.

| AC | Kriteria | Bukti yang diminta | Status saat ini |
|---|---|---|---|
| AC-01 | CC login, memilih tenant dan property, lalu membuat request INTAKE | Test runtime create-exchange dan `POST /handyman/requests/care`, 201 | PART 01 sudah ada (`7817a11`) |
| AC-02 | Request mencatat tenant, building, space, kategori, deskripsi, dan provenance | Test readback detail, field sesuai | Sebagian (G18). Provenance ada (G23 PARTIAL) |
| AC-03 | Reporter tercatat sesuai D1 | Test create dengan snapshot dan tanpa snapshot | **Belum** (G05) |
| AC-04 | PIC tidak bisa disisipkan dari CC, dan approval quotation hanya oleh PIC terverifikasi | Test negatif CC, test positif PIC, test negatif User lokal | **Belum** (G08) |
| AC-05 | Operations melihat request INTAKE di building yang di-assign, dan tidak melihat request lintas building | Test runtime queue, test negatif lintas building | **Belum** (G20, G29) |
| AC-06 | Triage tetap berfungsi setelah request ditemukan | Test triage existing tetap hijau | EXISTING, perlu dijalankan ulang |
| AC-07 | Create request menghasilkan audit dan notifikasi Operations | Test event `HANDYMAN_REQUEST_CREATED` dan audit | **Belum** (G22, G23) |
| AC-08 | Duplicate dan replay ditangani sesuai D4 | Test peringatan duplicate dan replay idempotency | **Belum** (G16, G17) |
| AC-09 | Lampiran foto diatur sesuai D8 | Test upload dan authz | **Belum** (G13) |
| AC-10 | Visibilitas historis setelah turnover sesuai D5, wall C6 tidak dilonggarkan | Test turnover | **Belum** (G19) |
| AC-11 | Kontrak OpenAPI sesuai route yang ada | Validasi kontrak untuk semua endpoint baru | Sebagian (G25) |
| AC-12 | Frontend CC dan Operations diverifikasi di repo masing-masing | Bukti dari repo frontend | **UNVERIFIED** (G26, G27) |
| AC-13 | E2E lintas repo dan runtime | Bukti E2E dari kedua sisi | **Belum ada, tidak diklaim** |

Syarat minimum closure: AC-01 sampai AC-11 terpenuhi, AC-12 dan AC-13 diverifikasi sebelum klaim E2E. Typecheck dan subset test Handyman saja. Tidak perlu full suite.

---

## Catatan metodologi

- Pencarian source dilakukan pada `src/modules/handyman-*`, route inventory, migration 0144, 0145, 0378, 0380, 0382, dan OpenAPI `docs/api/openapi.yaml`.
- Status MISSING hanya diberikan setelah pencarian lintas source, route, dan schema. Jika ada bukti baru, status harus diperbarui.
- Tidak ada perubahan kode, schema, API, atau frontend dalam PART ini.

---

## Pembaruan status setelah W02 PART 02

Bagian di atas adalah snapshot pra-coding dan tidak diubah. Pembaruan berikut mengacu ke `docs/e2e/W02_OPERATIONS_QUEUE_HANDOFF.md`.

| ID | Status sebelumnya | Status sekarang | Bukti |
|---|---|---|---|
| G20 Handoff ke Operations queue | MISSING | **EXISTING (backend, runtime PASS)** untuk list dan detail Building-scoped. Notifikasi tetap MISSING (G22). | `GET /handyman/operations/requests[/:id]`, `tests/handyman-operations-queue.test.ts` 15/15 PASS |
| G29 Visibilitas queue untuk Operations (UNVERIFIED) | UNVERIFIED | **EXISTING (terverifikasi runtime)**. User tanpa PIC dan tanpa assignment tidak melihat request di `GET /handyman/requests` (C6) dan di queue baru hanya melihat Building yang di-assign. | Test 9, 11, 12 pada `tests/handyman-operations-queue.test.ts` |
| D6 | Keputusan | Diterapkan sebagai scope Building baru. `customerRequestReadScope` tidak dilonggarkan. Tambahan: fail-closed untuk identitas tenant PIC (OQ-3). | `W02_OPERATIONS_QUEUE_HANDOFF.md` §2 |

Daftar P0 yang tersisa: **G05** (reporter), **G08** (approval PIC). G20 dan G29 tidak lagi P0. Keputusan R-2 (operator building melihat semua tenant di building) perlu persetujuan.

## Pembaruan authority setelah W02 PART 02A

- Authority Operations Queue sekarang: permission `handyman.operations.request.read` (unassigned by default) **dan** ACTIVE Building assignment. `tenant_company.read` bukan lagi authority queue.
- Blanket exclusion PIC ACTIVE dihapus. Dual-role (PIC + permission Operations + assignment) diizinkan. PIC tanpa permission ditolak 403.
- User dengan permission tetapi tanpa assignment: 403 `BUILDING_ACCESS_DENIED`.
- Provisioning role Operations produksi belum diputuskan (tidak ada grant dari kode). Lihat `W02_OPERATIONS_QUEUE_HANDOFF.md` §2 dan R-3.
- C6 (`customerRequestReadScope`, route generic) tidak berubah.
- R-2 (operator building melihat semua tenant di building) tetap menunggu persetujuan.

## PART 02B — Permission Registry Reconciliation

- `handyman.payment.report` dan `handyman.payment.verify` didaftarkan di `FOUNDATION_PERMISSIONS` dan `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` (nama sama dengan migration 0432). Tanpa default grant.
- `handyman.payment.report` tetap hanya untuk Care Actor sesuai allowlist CHECK 0432. `handyman.payment.verify` hanya lewat User RBAC dan maker-checker.
- PLATFORM_ADMIN tidak menerima kedua kode secara otomatis (dibuktikan oleh `tests/handyman-payment-permission-registry.test.ts`).
- Runtime authorization, route, controller, payment workflow, dan C6 tidak berubah.
- Detail, hasil test, dan residual: `docs/e2e/W02_VERIFICATION_DEBT.md`.

## PART 03 — Reporter identity, contact & request provenance

- Reporter dan contact person disimpan sebagai snapshot append-only di `handyman_service_request_contacts` (migration 0435), 1:1 dengan request, dengan provenans `captured_by_care_actor_id` dan `captured_at`.
- Data ini tidak memberi permission, PIC link, User, atau approval authority. Tenant PIC dan aturan approval quotation tidak diubah.
- Ditulis dalam transaksi yang sama dengan konsumsi exchange, attribution, dan request. Input tidak valid ditolak sebelum exchange dikonsumsi.
- Operations queue menampilkan `contact` untuk triage. C6 Customer Care tidak mengeksposnya.
- Detail, hasil test, dan residual: `docs/e2e/W02_VERIFICATION_DEBT.md` §5.

## PART 04 — Intake → Operations triage runtime journey

- Journey runtime terbukti: Customer Care intake (INTAKE + snapshot reporter) → Operations queue/detail → triage existing → status projection, queue filter, audit event. Lihat `W02_VERIFICATION_DEBT.md` §6.
- Tidak ada perubahan source. Gap yang ditemukan adalah keputusan authority, bukan bug runtime: triage memakai `tenant_company.manage` (bukan permission queue Operations). Tidak diubah tanpa keputusan.
- Negative, replay, dan concurrency terbukti: cross-building, cross-client, assignment dicabut, care token ditolak, transisi tidak valid ditolak, triage ganda menghasilkan satu decision dan satu event.

---

## 8. FINAL RECONCILIATION — W02 Assisted Intake (review only, 2026-10-10)

Baseline pembuktian: branch `arena/44e8ce22-handyman-backend`, HEAD `308f3b0`, ancestry `main`@`9602991` → 18 ahead / 0 behind (fast-forward, tidak ada rewrite). Working tree bersih. Rentang perubahan W02 saja: `f6b1419..HEAD` = 36 file, +4615/−34.

Legenda status akhir: **CLOSED** (implementasi ada, dibatasi scope-nya, dan ada bukti runtime pada HEAD ini) · **PARTIAL** (sebagian tertutup, sisa tercatat) · **BLOCKED_BY_POLICY** (kode siap, tetapi tidak diaktifkan karena keputusan policy belum ada) · **UNVERIFIED** (bukti berada di luar repo ini) · **DEFERRED** (sengaja tidak dikerjakan di W02, menunggu keputusan atau week lain).

### 8.1 Capability matrix (29 baris, final)

| ID | Capability | Status akhir | Bukti di HEAD ini | Sisa / catatan |
|---|---|---|---|---|
| G01 | Customer Care admission, sesi, revoke | **CLOSED** | `care-workspace.routes.ts`; `tests/handyman-care-workspace-admission.test.ts` (15 test); jalur admission dilalui ulang oleh journey PART 04 (27/27 PASS di run 168) | — |
| G02 | Provisioning & revoke permission care actor | **CLOSED** | `handyman-care-actor-permission.service.ts`; `tests/handyman-care-admin-provisioning.test.ts`; modul ini 0-diff pada rentang W02 | Bukti runtime berasal dari run W01 (PART 06), tidak diulang di batch 168 |
| G03 | Pemilihan Tenant Company | **CLOSED** | `care-workspace-tenants.repository.ts`; `tests/handyman-care-workspace-tenants.test.ts`; OpenAPI `.../tenant-companies` | — |
| G04 | Property, building, space, occupancy | **CLOSED** | `care-create-exchange.scope.ts` + body `buildingId`/`spaceId?`; `tests/handyman-care-workspace-spaces.test.ts`; exchange dibatasi `min(120s, config)` (`care-create-exchange.service.ts:46`) | — |
| G05 | Actual reporter | **CLOSED** | Migration `0435` (tabel append-only + CHECK), validasi `handyman-api.validation.ts:219-229`, ditulis satu transaksi; `handyman-request-reporter-contact.test.ts` 11/11 PASS | R-P3-1: `reporter` belum wajib (kompatibilitas mundur). Butuh keputusan bisnis, bukan kode |
| G06 | Contact person dan fallback kontak | **PARTIAL** | `contactPerson` tersimpan sebagai snapshot dengan CHECK completeness | Urutan fallback D3 (reporter → PIC primary → email/phone tenant) **tidak diimplementasi**; grep tidak menemukan derivasi dari `tenant_pics`/`tenant_companies`. Nilai juga tidak diverifikasi identitasnya (R-P3-2) |
| G07 | Link PIC di request | **PARTIAL** | Injeksi `tenantPicId`/`userId` dari CC ditolak 400 (dibuktikan di 16 kasus negatif PART 03); `tenant_pic_id` tetap dari attribution | Sisi approver (PIC terverifikasi) = G08, W03. Butuh D2 |
| G08 | Otoritas approval quotation oleh PIC | **DEFERRED (W03)** | `handyman-quotations-api.routes.ts:35` masih `manage`; `handyman-quotation-decision.repository.ts` mencatat `decided_by_user_id` lokal | Tidak ada jalur approval PIC. Bukan regresi: W02 tidak menyentuh quotation engine. Prasyarat D2 |
| G09 | Read request berbasis occupancy (C6) | **CLOSED** | `customerRequestReadScope` (`handyman-service-request.repository.ts:184`) dan file repository **0 baris diff** pada `f6b1419..HEAD` | Wall tidak dilonggarkan oleh queue baru |
| G10 | Service category dan variant | **CLOSED** | `serviceCatalogId` wajib, `serviceVariantId?`, validasi cross-client ACTIVE di `createFromAuthorizedAttribution` | — |
| G11 | Deskripsi masalah | **CLOSED** | `description` 1–1000, di allowed-list parser care (`:241`) | — |
| G12 | Priority / urgency | **DEFERRED** | `priority` tidak ada di allowed-list care body; tidak ada kolom di migration Handyman W02 | D7 rekomendasi (b) tunda. Jangan duplikasi dari legacy (G28) |
| G13 | Foto / attachment saat intake dari CC | **PARTIAL** | `GET/POST /handyman/requests/:id/intake-evidence` (read/manage) ada dan terdaftar OpenAPI; `care-workspace.routes.ts` **tidak** punya route evidence (grep: 0 hasil) | D8 belum diputuskan. Opsi (c) tetap ditolak (SI-08) |
| G14 | Create-exchange dan assisted create | **CLOSED** | `tests/handyman-care-workspace-create-exchange.test.ts` 20/20 PASS; 201 INTAKE, `createdByUserId` null, attribution `CUSTOMER_CARE` | — |
| G15 | Nomor request yang dibaca manusia | **DEFERRED** | Tidak ada `request_number` di modul Handyman (hanya di legacy `0081`/`0148`) | D9 rekomendasi (b): UUID saja untuk W02 |
| G16 | Idempotency dan replay create | **PARTIAL** | Idempotensi level exchange terbukti 3× independen: replay → 401, concurrency → tepat satu 201 (PART 03, PART 05 C1/C2 di run 168) | Tidak ada `Idempotency-Key` pada create request (grep: 0 di `handyman-api/*.ts`). Dibatasi scope: token single-use sudah mengikat satu create ke satu exchange |
| G17 | Kebijakan duplicate request | **DEFERRED** | Tidak ada logika dedupe di `handyman-requests` | D4 belum diputuskan. Rencana PART 13 |
| G18 | Readback list dan detail CC | **CLOSED** | `tests/handyman-care-workspace-requests.test.ts` + `request-detail.test.ts`; scope di `care-workspace-requests.service.ts`; snapshot kontak tidak diekspos (cek rekursif di test PART 03) | — |
| G19 | Visibilitas historis setelah occupancy turnover | **DEFERRED** | Wall C6 tidak berubah (0-diff), `PLATFORM_ADMIN` tetap per-Building | Tidak ada test turnover. D5 default (a) dipertahankan. AC-10 terbuka |
| G20 | Handoff ke Operations queue | **CLOSED** | `GET /handyman/operations/requests[/:id]` + `handyman-operations-queue.{repository,service}.ts`; 19/19 PASS; OpenAPI `:4106` dan `:4183` | Menampilkan `contact` untuk triage → lihat R-2 |
| G21 | Triage, referral, assignment | **CLOSED** | `handyman-request-triage.service.ts`; journey PART 04 27/27 PASS; triage kini berpintu `handyman.operations.request.triage` (`handyman-lifecycle-api.routes.ts:49`) | R-P4A-1: tidak ada fallback `manage` (keputusan eksplisit) |
| G22 | Notifikasi Operations saat intake | **BLOCKED_BY_POLICY** | Event dan kontrak ada (`handyman-notification-contract.ts:49-56`, templateKey `HANDYMAN_REQUEST_CREATED`); create mencatat `notificationHandoff.status = BLOCKED_BY_POLICY` (`handyman-service-request.service.ts:149-154, 269`) | Tidak ada `emitHandymanNotificationIntent` di modul requests (grep: 0) → memang tidak diterbitkan. Butuh R-P5-1 (recipient + channel + consent) |
| G23 | Audit dan provenance create | **CLOSED** | `HANDYMAN_REQUEST_CREATED` di audit contract (`:87`) + emit di executor transaksi yang sama (`:255`); rollback dan no-PII dibuktikan `handyman-request-create-audit-part05.test.ts` 14/14 PASS | R-P5-2: status handoff adalah snapshot create; delivery nanti dicatat di ledger, bukan update event |
| G24 | Pembatalan / withdrawal | **DEFERRED** | Tidak ada `CANCELLED` pada vocabulary status Handyman | D7 (b). Journey frozen membatasi |
| G25 | Kontrak OpenAPI | **CLOSED** (untuk permukaan W02) | `docs/api/openapi.yaml` +227 baris pada rentang W02: queue, otoritas triage (`:4351`, `:4390`), `HandymanRequestContactInput` (`:79828`), `HandymanRequestContactSnapshot` (`:79842`, dipakai `:82889`) | Belum dibandingkan dengan konsumsi frontend (bagian AC-12) |
| G26 | Frontend Customer Care | **UNVERIFIED** | Tidak ada di repo ini | Repo frontend. Tidak ada klaim E2E |
| G27 | Frontend Operations queue | **UNVERIFIED** | Tidak ada di repo ini; backend queue sudah tersedia sehingga FE bisa mulai | Repo frontend, setelah kontrak disetujui |
| G28 | Intake Work Order legacy (`tenant-service-requests`) | **CLOSED** (out-of-scope by design) | Modul legacy tidak disentuh W02; tidak ada duplikasi field legacy (`priority`, `request_number`) ke path care Handyman (dibuktikan di G12/G15) | Tetap jalur Work Order sendiri |
| G29 | Runtime visibility queue untuk Operations tanpa PIC | **CLOSED** | `tests/handyman-operations-queue.test.ts` test 9, 11, 12 (re-run PASS di batch 168): User tanpa PIC tidak melihat request di C6, queue hanya Building yang di-assign, tanpa assignment → 403 | — |

Ringkasan 29 capability: **CLOSED 16** (G01, G02, G03, G04, G05, G09, G10, G11, G14, G18, G20, G21, G23, G25, G28, G29) · **PARTIAL 4** (G06, G07, G13, G16) · **BLOCKED_BY_POLICY 1** (G22) · **DEFERRED 6** (G08, G12, G15, G17, G19, G24) · **UNVERIFIED 2** (G26, G27). Total 29.

### 8.2 Journey review (backend runtime, per fase)

| Fase | Pintu masuk | Otoritas | Status |
|---|---|---|---|
| S1 CC admission → sesi | `POST /handyman/care/session` | assertion + property grant | CLOSED |
| S3 create-exchange | `POST .../create-exchanges` | sesi CC + scope grant; token TTL `min(120s, config)`, single-use | CLOSED |
| S4 request create | `POST /handyman/requests/care` | exchange token; 201 INTAKE; `createdByUserId` null; attribution `CUSTOMER_CARE` | CLOSED |
| S4b snapshot reporter/kontak | body opsional `reporter`, `contactPerson` | ditulis di transaksi yang sama; input invalid → 400 sebelum token terbakar | CLOSED (fallback D3 belum ada) |
| S8 audit create | `recordHandymanEvent(HANDYMAN_REQUEST_CREATED, …, client)` | satu executor dengan insert; metadata hanya identitas | CLOSED |
| S8b notification seam | kontrak + `notificationHandoff` | tidak menerbitkan intent | BLOCKED_BY_POLICY |
| S9 Operations queue | `GET /handyman/operations/requests[/:id]` | `handyman.operations.request.read` + ACTIVE building assignment (fail-closed) | CLOSED |
| S10 triage | `POST /handyman/requests/:id/triage` | `handyman.operations.request.triage` + `assertBuildingScopedResourceAccess`; audit `HANDYMAN_REQUEST_TRIAGED` | CLOSED |
| S11 approval PIC | `POST /handyman/quotation-versions/:id/decision` | masih `tenant_company.manage` + building access User lokal | DEFERRED ke W03 |

### 8.3 Security review (tidak ada regresi, semua diperiksa di HEAD ini)

- **Duplicate authority:** triage POST tidak lagi menerima `tenant_company.manage` (tidak ada fallback). Satu-satunya any-of gate adalah `GET .../triage` (`tenant_company.read` ATAU `handyman.operations.request.read`) dengan Building scope yang sama; `requireAnyPermission` dipakai tepat satu kali di seluruh `src/`. Tidak ada dua jalur tulis untuk kemampuan yang sama.
- **Permission overgrant:** hanya 2 kode baru di W02 (`handyman.operations.request.read`, `.triage`), keduanya additive di migration `0434`/`0436` (`ON CONFLICT DO NOTHING`, tanpa baris grant) dan terdaftar di `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` (`foundation-access.seed.ts:774,776`). grep seed/migration: tidak ada grant ke role mana pun, termasuk PLATFORM_ADMIN.
- **Data exposure:** snapshot reporter/kontak hanya muncul di Operations queue; modul care-workspace tidak memiliki satu pun referensi `contact` (grep: 0 hasil) dan test PART 03 melakukan cek rekursif pada respons C6. Payload audit dan marker outbox hanya identitas (Dibuktikan A2/E1, part05 14/14).
- **C6 dan frozen journey:** `handyman-service-request.repository.ts` (berisi `customerRequestReadScope`) = **0 baris diff** pada rentang W02. `handyman-service-request.service.ts` berubah +75 baris, tetapi seluruh hunks berada di jalur create saja (`createFromAuthorizedAttribution`, `createHandymanServiceRequest`, `createCareHandymanServiceRequest`); tidak ada hunk pada read/projection path. `docs/e2e/HANDYMAN_BUSINESS_JOURNEY_v1.3_FROZEN.md` tidak disentuh (0 diff).
- **Schema:** hanya additive (`0434`, `0435`, `0436`). Tidak ada constraint yang dilemahkan; `0435` justru menambah trigger append-only UPDATE/DELETE.
- **Rollback schema:** untuk pertama kalinya dibuktikan dieksekusi, bukan hanya dibaca. Pada cluster fresh: 436 migration UP → `down` ×3 (`0436`, `0435`, `0434`) → `to_regclass('public.handyman_service_request_contacts') = null` dan 0 baris permission Operations → re-UP = 3 migration, tabel dan 2 baris katalog kembali, total applied 436.
- **Temuan F-01 (perlu ditindak, bukan blocker runtime):** gerbang ROUTE-TO-REGISTRY memakai regex `PERMISSION_CALL = /requirePermission\(...\)/` (`tests/config-perm-01-permission-registry.test.ts:177`) dan **tidak memindai `requireAnyPermission`**. Kedua kode pada GET triage hari ini memang terdaftar, jadi tidak ada pelanggaran aktif; tetapi gerbang itu punya blind spot untuk any-of gate di masa depan. Perbaikan = perluasan regex test (di luar W02, review-only di sini).
- **Temuan F-02:** tabel "Ringkasan status" §1 adalah snapshot pra-coding dan kini usang terhadap implementasi; matriks §8.1 menjadi acuan closure.

### 8.4 Backend runtime certification vs frontend vs cross-repo

- **Backend runtime certification W02: selesai.** Bukti = 168 PASS / 0 FAIL / 0 SKIP pada regresi fokus 14 file (dijalankan ulang independently di sandbox pemulihan dengan embedded PostgreSQL 18.4, cluster fresh), `npx tsc --noEmit -p .` exit 0, `git diff --check` bersih, plus bukti rollback migration di §8.3.
- **Frontend (G26, G27): tidak diklaim.** Tidak ada FE di repo ini. Yang bisa dikirim ke repo frontend: kontrak OpenAPI W02 (queue, contact input/snapshot, otoritas triage).
- **Cross-repo / E2E (AC-13): tidak diklaim.** Tidak ada bukti runtime dua sisi. Setiap kalimat yang mengesankan "E2E selesai" harus ditolak.

### 8.5 Blocker menuju W03 dan keputusan yang tersisa

| ID | Item | Jenis | Blokir W03? |
|---|---|---|---|
| B-1 | **R-2 / OQ-6** — operator Building melihat semua tenant di Building yang di-assign (termasuk snapshot kontak pelapor) | Keputusan bisnis + privacy | **Ya**, karena W03 menambah data komersial (quotation) di permukaan yang sama |
| B-2 | **R-3 / D-8** — provisioning role Operations produksi (grant `handyman.operations.request.read` dan `.triage`) | Operasional/admin (bukan kode) | **Ya** untuk pemakaian produksi; triage kini tidak punya grant default sama sekali akibat PART 04A |
| B-3 | **D2** — sumber otoritas PIC untuk approval quotation | Keputusan bisnis | **Ya**: prasyarat desain W03 |
| B-4 | **D1 sisa (R-P3-1)** — `reporter` diwajibkan atau tidak | Keputusan bisnis | Tidak memblokir; memengaruhi kualitas data yang dibaca W03 |
| B-5 | **D3** — urutan fallback kontak | Keputusan bisnis | Tidak memblokir W03; catat sebagai PARTIAL G06 |
| B-6 | **R-P5-1** — recipient + channel policy `HANDYMAN_REQUEST_CREATED` | Keputusan produk | Tidak memblokir; G22 tetap BLOCKED_BY_POLICY sampai diputuskan |
| B-7 | **F-01** — ROUTE-TO-REGISTRY tidak memindai `requireAnyPermission` | Housekeeping test | Tidak memblokir; sebaiknya ditutup di awal W03 |
| B-8 | **AC-12 / G26, G27** — verifikasi kontrak frontend | Repo lain | Tidak memblokir W03 backend; memblokir klaim E2E |

### 8.6 Gap yang memang menjadi scope week lain

- **W03 Quotation:** G08 (approval PIC), sisa G07 (beneficiary vs approver), `GET /handyman/requests/:id/quotation/presented` yang baru read-only, `Idempotency-Key` yang sudah ada di decision quotation (reuse, jangan duplikasi pola), dan SI-07/SI-11 (maker-checker approval PIC).
- **Bukan W02 dan bukan W03 (ke week berikutnya / backlog; W10 tidak punya definisi di repo ini — lihat catatan):** G12 priority, G15 nomor request, G17 duplicate policy, G24 cancel/withdrawal, G19 visibilitas historis (D5, D7, D9), G13 evidence dari CC (D8), G22 aktivasi delivery notifikasi (R-P5-1), G26/G27 frontend (W02-FE-TRACK), dan R-P5-4/R-P5-6 (keputusan outbox/ledger dan DB test persisten). Catatan: dokumen repo tidak mendefinisikan W10; pemetaan week untuk item-item ini harus ditetapkan di perencanaan W03, jangan disimpulkan dari dokumen ini.

### 8.7 Keputusan closure

- **W02 BACKEND RUNTIME CERTIFICATION: CLOSED.** Seluruh P0 yang menjadi tanggung jawab W02 (G05, G20, G23, G29) tertutup dengan bukti runtime yang bisa diulang; tidak ada regresi C6, tidak ada overgrant, tidak ada exposure baru, tidak ada perubahan C6/frozen journey, dan rollback schema terbukti.
- **W02 sebagai journey end-to-end: tetap PARTIAL.** AC-04 (approval PIC), AC-08 (duplicate), AC-09 (lampiran CC), AC-10 (turnover) belum terpenuhi, dan AC-12/AC-13 tidak bisa dibuktikan dari repo ini. Semua penundaan itu adalah keputusan (D2–D9) atau scope week lain, bukan cacat runtime.
- Konsekuensi: W03 boleh mulai. Dua gerbang non-kode (B-1 R-2, B-2 provisioning R-3) harus diputuskan/dikerjakan sebelum fitur queue dan triage dipakai di produksi.
