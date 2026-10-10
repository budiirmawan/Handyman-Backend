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
| `POST /api/v1/handyman/requests/:id/triage` | `tenant_company.manage`, building scope | Keputusan triage | — | G21 |
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
