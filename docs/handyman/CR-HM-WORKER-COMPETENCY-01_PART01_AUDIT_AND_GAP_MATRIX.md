# CR-HM-WORKER-COMPETENCY-01 — PART 01: Audit, Gap Matrix & Individual Worker Certification Foundation

- **CR ID:** `CR-HM-WORKER-COMPETENCY-01`
- **Part:** `PART 01`
- **Repository:** `budiirmawan/Handyman-Backend`
- **Branch:** `arena/1338174d-handyman-backend`
- **Status:** `PART 01 DELIVERED — READY FOR PART 02`

---

## 1. Tujuan & Ruang Lingkup PART 01

PART 01 dari `CR-HM-WORKER-COMPETENCY-01` mencakup:
1. **Audit menyeluruh** terhadap fondasi kompetensi pekerja (`skills`, `workforce_skill_assignments`), sertifikasi/lisensi tingkat vendor (`vendor_licenses_certifications`, `vendor_compliance_documents`), fondasi dokumen bersama (`documents`), serta proyeksi profil pekerja Handyman (`handyman-worker-profile`).
2. **Penyusunan Gap Matrix (`Existing` / `Reuse` / `New`)** untuk memetakan kapabilitas yang sudah tersedia, komponen yang dapat digunakan ulang tanpa duplikasi, dan celah yang harus dibangun baru.
3. **Implementasi fondasi sertifikasi pekerja individu (`workforce_certifications`)** yang bersifat **opsional** (pekerja tanpa sertifikat tetap valid 100%), mendukung nomor sertifikat (`certificate_number`), nama sertifikat (`certificate_name`), penerbit (`issuing_authority`), tanggal terbit (`issue_date`), masa berlaku/kedaluwarsa (`expiry_date`), status verifikasi (`verification_status`), serta referensi dokumen yang aman (`document_id` + `file_reference`).
4. **Penegakan isolasi multi-client, RBAC, dan perlindungan kontrak Mobile** yang telah dibekukan (*contract freeze*).

---

## 2. Hasil Audit Kapabilitas Eksisting

### 2.1 Workforce Skills & Skill Assignments (`0025_create_skills.ts`, `0026_create_workforce_skill_assignments.ts`)
- **`skills` (`0025`)**: Menyimpan katalog keahlian berlingkup client (`client_id`, `code`, `name`, `description`, `category` ∈ `TECHNICAL | OPERATIONAL | SAFETY | SPECIALIST`, `status` ∈ `ACTIVE | INACTIVE`).
- **`workforce_skill_assignments` (`0026`)**: Menyimpan penugasan keahlian ke `workforce_profiles` (`workforce_profile_id`, `skill_id`, `proficiency_level` ∈ `BASIC | INTERMEDIATE | ADVANCED | EXPERT`, `valid_from`, `valid_until`, `status` ∈ `ACTIVE | INACTIVE`) dengan *partial unique index* pada `(workforce_profile_id, skill_id) WHERE status = 'ACTIVE'`.
- **Temuan Audit**:
  - `workforce_skill_assignments` hanya memodelkan tingkat kemahiran (*proficiency*) dan jendela berlaku penugasan skill (`valid_from`, `valid_until`).
  - **Tidak ada** kolom untuk nomor sertifikat individu (`certificate_number`), lembaga penerbit (`issuing_authority`), tanggal terbit (`issue_date`), status verifikasi (`verification_status`), maupun referensi dokumen bukti sertifikat (`document_id` / `file_reference`).

### 2.2 Vendor Licenses & Compliance Documents (`0061_create_vendor_compliance_documents.ts`, `0062_create_vendor_licenses_certifications.ts`)
- **`vendor_compliance_documents` (`0061`)**: Menyimpan metadata dokumen kepatuhan badan usaha vendor (`vendor_id`, `document_type`, `document_number`, `document_name`, `issuing_authority`, `issue_date`, `expiry_date`, `status`, `file_reference`, `notes`).
- **`vendor_licenses_certifications` (`0062`)**: Menyimpan lisensi/sertifikasi tingkat perusahaan vendor (`vendor_id`, `record_type` ∈ `LICENSE | CERTIFICATION`, `name`, `number`, `issuing_authority`, `issue_date`, `expiry_date`, `status` ∈ `ACTIVE | EXPIRED | INACTIVE`, `document_id` → `vendor_compliance_documents.id`, `notes`).
- **Temuan Audit**:
  - Seluruh baris pada `vendor_licenses_certifications` terikat ke entitas perusahaan `vendors(id)`, **bukan** ke individu `workforce_profiles(id)`.
  - Pekerja internal (`workforce_type = 'INTERNAL'`) maupun pekerja individu di dalam vendor eksternal tidak dapat menyimpan sertifikat perorangan (mis. Sertifikat K3 Listrik Teknisi, SIO Kemnaker, Sertifikat BNSP) pada tabel `vendor_licenses_certifications`.
  - Pola resolusi status kedaluwarsa (`VALID | EXPIRED | NOT_APPLICABLE`) dan aturan konsistensi `status` vs `expiry_date` pada `src/modules/vendor-licenses` sudah matang dan dapat diadopsi secara konsisten.

### 2.3 Shared Document & Evidence Storage Foundation (`0224_create_documents.ts`, `0437_create_handyman_field_evidence_uploads.ts`)
- **`documents` (`0224`)**: Menyediakan registri dokumen bersama berlingkup `client_id` (`id`, `client_id`, `building_id`, `document_number`, `document_type`, `context_type`, `source_type`, `source_id`, `title`, `description`, `file_reference`, `status` ∈ `DRAFT | ACTIVE | INACTIVE`).
- **Safe Storage Key (`src/modules/evidence/storage/local-evidence-storage.ts` & `0437`)**: Menetapkan standar keamanan referensi berkas yang menolak *path traversal* (`..`), *leading slash* (`/`), *backslash* (`\`), karakter kontrol/spasi, dan skema URI eksternal (`http://`, `https://`, `file://`, `javascript:`, `data:`), serta hanya mengizinkan kunci penyimpanan relatif yang aman atau skema internal `hm-ev://<uuid>`.

### 2.4 Handyman Worker Profile & Mobile Contract (`src/modules/handyman-worker-profile`, `MOBILE_API_HANDOFF.md`)
- Proyeksi `GET /api/v1/handyman/field/me/profile` dan `GET /api/v1/handyman/field/workers/:workerContextId/profile` saat ini mengembalikan `certificationsAndExpiry` yang berisi:
  - `skillValidityWindows` (dari `workforce_skill_assignments`),
  - `providerLicensesAndCertifications` (dari `vendor_licenses_certifications`),
  - `individualCertificateNumberModeled: false` (dibekukan oleh `docs/api/openapi.yaml`, `tests/handyman-worker-profile.test.ts`, dan `tests/handyman-worker-profile-schema-regression.test.ts`).
- Кроме itu, `tests/openapi-operational-final-parity.test.ts` dan `tests/handyman-contract-freeze-03-openapi.test.ts` mengunci jumlah rute HTTP runtime secara presisi (`runtime.length === 1687`, `handymanOps.length === 269`).
- Oleh karena itu, pada **PART 01**, fondasi penuh `workforce_certifications` (migrasi DB, repository, validasi, kode error, dan domain service beserta RBAC & isolasi multi-client) diimplementasikan tanpa memodifikasi bentuk respons Mobile yang sedang dibekukan atau mengubah jumlah rute HTTP runtime hingga integrasi transport/proyeksi pada **PART 02**.

---

## 3. Gap Matrix (`Existing` / `Reuse` / `New`)

| # | Area Kapabilitas | Status (`Existing` / `Reuse` / `New`) | Artefak / Lokasi | Penjelasan & Keputusan Arsitektur |
|---|---|---|---|---|
| 1 | Identitas Pekerja & Rantai Isolasi Client (`workforce_profiles` → `organizations.client_id`) | **Existing / Reuse** | `0024_create_workforce_profiles.ts`, `src/modules/workforce` | Digunakan langsung sebagai jangkar identitas pekerja (`workforce_profile_id`) dan penentu `client_id` otoritatif. |
| 2 | Katalog Keahlian (`skills`) & Penugasan Skill (`workforce_skill_assignments`) | **Existing / Reuse** | `0025_create_skills.ts`, `0026_create_workforce_skill_assignments.ts`, `src/modules/skills`, `src/modules/workforce-skills` | Digunakan ulang untuk pengaitan opsional `skill_id` pada sertifikat pekerja individu (dengan validasi `skill.client_id = workforce_certification.client_id`). |
| 3 | Lisensi & Sertifikasi Badan Usaha Vendor (`vendor_licenses_certifications`) | **Existing (Tetap Terpisah)** | `0062_create_vendor_licenses_certifications.ts`, `src/modules/vendor-licenses` | Tetap menjadi sumber kebenaran sertifikasi tingkat perusahaan/provider; pola `resolveExpiryStatus` (`VALID | EXPIRED | NOT_APPLICABLE`) diadopsi untuk sertifikat individu. |
| 4 | Fondasi Dokumen Bersama (`documents`) | **Existing / Reuse** | `0224_create_documents.ts`, `src/modules/documents` | Digunakan ulang melalui kolom opsional `document_id` pada `workforce_certifications` dengan penegakan `documents.client_id = workforce_certifications.client_id`. |
| 5 | Validasi Referensi Berkas Aman (*Safe File Reference*) | **Reuse + Hardened Check** | `0461_create_workforce_certifications.ts`, `workforce-certification.validation.ts` | Menolak `..`, `/`, `\`, spasi/kontrol, dan skema URI eksternal (`http://`, `https://`, `file://`, `javascript:`, `data:`); hanya menerima *relative storage key* aman atau `hm-ev://<uuid>`. |
| 6 | Tabel Database Sertifikasi Pekerja Individu (`workforce_certifications`) | **New (PART 01)** | `src/database/migrations/0461_create_workforce_certifications.ts` | Tabel baru dengan `certificate_number`, `certificate_name`, `issuing_authority`, `issue_date`, `expiry_date`, `status`, `verification_status`, `verified_by_user_id`, `verified_at`, `document_id`, `file_reference`, `notes`, partial unique index ACTIVE, dan trigger isolasi client. |
| 7 | Repository, Validation, Error Registry & Domain Service (`workforce-certifications`) | **New (PART 01)** | `src/modules/workforce-certifications/*`, `src/shared/errors.ts` | Modul domain lengkap untuk CRUD sertifikasi individu, siklus verifikasi (`PENDING_VERIFICATION | VERIFIED | REJECTED`), penonaktifan (`INACTIVE`), RBAC (Self, Crew Lead, Workforce/Skill/Ops Roles), dan audit `operational_events`. |
| 8 | Eksposur Endpoint HTTP & Proyeksi Profil Pekerja Mobile (`certificationsAndExpiry`) | **Staged for PART 02** | `src/modules/handyman-worker-profile`, `docs/api/openapi.yaml` | Kontrak Mobile (`individualCertificateNumberModeled: false`) dan jumlah rute OpenAPI/runtime (`1687`) dijaga tetap utuh pada PART 01; siap dihubungkan pada PART 02. |

---

## 4. Desain Fondasi `workforce_certifications` (PART 01)

### 4.1 Skema Tabel (`0461_create_workforce_certifications.ts`)
- **`id`**: `UUID PRIMARY KEY`
- **`client_id`**: `UUID NOT NULL REFERENCES clients(id)`
- **`workforce_profile_id`**: `UUID NOT NULL REFERENCES workforce_profiles(id)`
- **`skill_id`**: `UUID REFERENCES skills(id)` *(opsional — sertifikat dapat terhubung ke skill tertentu atau berdiri sendiri)*
- **`certificate_number`**: `TEXT NOT NULL` *(1..128 karakter setelah trim)*
- **`certificate_name`**: `TEXT NOT NULL` *(1..255 karakter setelah trim)*
- **`issuing_authority`**: `TEXT NOT NULL` *(1..255 karakter setelah trim)*
- **`issue_date`**: `TIMESTAMPTZ NOT NULL`
- **`expiry_date`**: `TIMESTAMPTZ` *(opsional — `NULL` untuk sertifikat seumur hidup; bila diisi wajib `expiry_date >= issue_date`)*
- **`status`**: `TEXT NOT NULL DEFAULT 'ACTIVE'` (`'ACTIVE' | 'EXPIRED' | 'INACTIVE'`)
- **`verification_status`**: `TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'` (`'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED'`)
- **`verified_by_user_id`**: `UUID REFERENCES users(id)` *(wajib `NOT NULL` saat `VERIFIED`/`REJECTED`, wajib `NULL` saat `PENDING_VERIFICATION`)*
- **`verified_at`**: `TIMESTAMPTZ` *(wajib `NOT NULL` saat `VERIFIED`/`REJECTED`, wajib `NULL` saat `PENDING_VERIFICATION`)*
- **`document_id`**: `UUID REFERENCES documents(id)` *(opsional — referensi ke tabel `documents` pada client yang sama)*
- **`file_reference`**: `TEXT` *(opsional — kunci penyimpanan relatif yang aman atau `hm-ev://<uuid>`)*
- **`notes`**: `TEXT` *(opsional)*
- **`created_by_user_id`**: `UUID REFERENCES users(id)`
- **`created_at` / `updated_at`**: `TIMESTAMPTZ NOT NULL DEFAULT NOW()`

### 4.2 Invarian Database & Trigger Isolasi Multi-Client
1. **Unik per Pekerja untuk Sertifikat Aktif**:
   - `workforce_certifications_active_unique` pada `(workforce_profile_id, lower(btrim(certificate_number))) WHERE status = 'ACTIVE'`.
   - Nomor sertifikat yang sama dapat dibuat ulang setelah baris sebelumnya berstatus `EXPIRED` atau `INACTIVE`, dan pekerja berbeda dapat memiliki nomor sertifikat yang sama tanpa benturan.
2. **Trigger Isolasi Multi-Client (`trg_workforce_certifications_enforce_client_scope`)**:
   - Memastikan `NEW.client_id` sama dengan `organizations.client_id` dari `NEW.workforce_profile_id`.
   - Bila `NEW.skill_id IS NOT NULL`, memastikan `skills.client_id = NEW.client_id`.
   - Bila `NEW.document_id IS NOT NULL`, memastikan `documents.client_id = NEW.client_id`.
3. **Constraint Keamanan `file_reference` (`workforce_certifications_safe_file_ref_check`)**:
   - Menolak `..`, `\`, awalan `/`, karakter kontrol/spasi, dan skema berbahaya (`http:`, `https:`, `file:`, `javascript:`, `data:`, `vbscript:`, `ftp:`).

### 4.3 Aturan Isolasi Multi-Client & RBAC pada Domain Service
- **Isolasi Client**: Setiap operasi memverifikasi akses aktor ke `client_id` milik `workforce_profile_id` melalui `contextAccessService.canAccessClient(actor.id, profile.clientId)`. Pelanggaran lintas client ditolak dengan `403 BUILDING_ACCESS_DENIED`.
- **Otorisasi Baca (`listWorkforceCertifications`, `listCurrentWorkforceCertifications`, `getWorkforceCertificationById`)**:
  - Diizinkan bagi:
    1. Pekerja pemilik profil itu sendiri (`profile.userId === actor.id`),
    2. Crew Lead aktif (`PIC_PEKERJAAN`) pada kru aktif yang sama dengan pekerja target,
    3. Pemegang izin operasional/manajemen (`skill.read`, `skill.manage`, `workforce.read`, `workforce.manage`, `tenant_company.read`, `tenant_company.manage`).
  - Rekan sejawat (*peer crew member* biasa) yang bukan Crew Lead ditolak dengan `403 WORKFORCE_CERTIFICATION_FORBIDDEN`.
- **Otorisasi Kelola & Verifikasi (`createWorkforceCertification`, `updateWorkforceCertification`, `verifyWorkforceCertification`, `deactivateWorkforceCertification`)**:
  - Diizinkan hanya bagi pemegang izin manajemen pada client terkait (`skill.manage`, `workforce.manage`, atau `tenant_company.manage`).
  - Pekerja lapangan biasa tidak dapat memverifikasi sendiri (`VERIFIED`) atau memodifikasi sertifikat tanpa izin manajemen (`403 WORKFORCE_CERTIFICATION_FORBIDDEN`).

---

## 5. Kesiapan PART 02 (PART 02 Readiness)

Dengan selesainya PART 01:
1. **Skema & Penyimpanan Kanonis Siap**: Tabel `workforce_certifications` (`0461`) telah terdaftar dan teruji dengan perlindungan penuh di tingkat SQL maupun service.
2. **Domain Service Siap Dipanggil**: `workforceCertificationService` menyediakan operasi lengkap (`listWorkforceCertifications`, `listCurrentWorkforceCertifications`, `getWorkforceCertificationById`, `createWorkforceCertification`, `updateWorkforceCertification`, `verifyWorkforceCertification`, `deactivateWorkforceCertification`) beserta pemetaan `skill` dan `documentReference`.
3. **Integrasi PART 02 yang Siap Dilakukan**:
   - Menghubungkan pembacaan sertifikat individu dari `workforceCertificationRepository` ke proyeksi `handyman-worker-profile` (`certificationsAndExpiry`),
   - Menambahkan rute HTTP pengelolaan sertifikasi pekerja dan memperbarui spesifikasi OpenAPI (`docs/api/openapi.yaml`) serta kontrak parity secara serempak pada PART 02.
