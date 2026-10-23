# CR-HM-WORKER-COMPETENCY-01 — PART 03B1 Delivery Report
## Certification Re-verification & Assignment Decision History

- **Branch:** `arena/3df97f5e-handyman-backend`
- **Baseline:** `f1dac0b` (PART 03A)
- **Commit implementasi:** **`76eb66b`**
- **Scope:** PART 03B1 saja (PART A re-verifikasi + PART B decision history). PART 01, 02, 03A **tidak** diubah ulang.
- **Status:** selesai, teruji, di-commit, di-push. **Tanpa PR / merge / deploy.**
- **Tidak ada perubahan produksi**, tidak ada perubahan role Super User, tidak ada perubahan password.
- **Di luar cakupan (tetap backlog PART 03B2):** expiry sweeper, bulk import konfigurasi, redesign UI.

---

## 1. Ringkasan eksekutif

Dua celah audit ditutup tanpa menambah otoritas kedua:

1. **PART A — re-verifikasi sertifikat.** Sebelumnya status verifikasi hanya hidup sebagai **satu baris**
   (`workforce_certifications.verification_status` + `verified_by_user_id` + `verified_at`, migrasi `0461`).
   Satu metadata berubah → tidak ada yang di-reset; satu keputusan baru → keputusan lama **hilang**.
   Sekarang: perubahan metadata yang **material** mengembalikan sertifikat ke `PENDING_VERIFICATION`,
   mengosongkan triple verifier, dan **keputusan lama disimpan permanen** sebagai baris ledger append-only.
2. **PART B — riwayat keputusan kompetensi.** Sebelumnya hasil gate PART 03A hanya tersimpan sebagai agregat
   (`operational_events.metadata.competency = {requirementCount, mandatoryRequirementCount}`) — tidak bisa
   menjawab "siapa dievaluasi, requirement mana, bukti apa, kenapa ditolak". Sekarang setiap assign/reassign
   yang **berhasil** menulis satu baris per (aksi × worker × requirement) di **transaksi yang sama**.

Prinsip yang dipertahankan:

- **Satu evaluator** (`worker-competency-eligibility`) untuk penegakan **dan** riwayat; tidak ada evaluator kedua.
- **Satu jalur assignment** (`handyman-scope-assignment.service.ts`); tidak ada workflow alternatif/flag force.
- **Maker-checker tidak berubah**: pemilik sertifikat tetap tidak boleh memverifikasi dirinya sendiri.
- **Client/Building scope** ditegakkan pada kedua operasi baca baru.
- **Sertifikasi tetap opsional**: nol requirement = perilaku identik dengan sebelumnya.

---

## 2. Audit singkat (temuan yang menentukan desain)

| Area | Temuan | Konsekuensi desain |
|---|---|---|
| `workforce_certifications` (`0461`) | Hanya menyimpan keputusan **terkini**; UPDATE menimpa jejak verifier sebelumnya | Perlu tabel ledger terpisah — bukan kolom tambahan |
| `verifyWorkforceCertification` | Menulis status + audit event, tanpa transaksi bersama | Ledger + event + row harus satu transaksi (`withTransaction`) |
| `updateWorkforceCertification` | Membolehkan semua field metadata tanpa menyentuh verifikasi | Reset harus **dihitung terhadap baris tersimpan**, bukan "field dikirim atau tidak" |
| `evaluateExecutionScopeCompetency` (03A) | Mengembalikan verdict lengkap tapi pemanggil membuang detailnya | Service mengembalikan verdict; assignment memakainya sebagai snapshot |
| `operational_events` | Metadata agregat saja, bukan per requirement/worker | Ledger bertipe; event tetap sebagai ringkasan |
| Pola immutability `0396` | Trigger `*_no_write` menolak UPDATE/DELETE | Pola yang sama dipakai untuk kedua tabel baru |

---

## 3. Model data — migrasi `0464_workforce_competency_decision_history`

### 3.1 `workforce_certification_decisions` (PART A)

| Kolom | Tipe | Catatan |
|---|---|---|
| `id` | UUID PK | |
| `client_id` | UUID NOT NULL → `clients` | dari profil workforce, bukan dari pemanggil |
| `certification_id` | UUID NOT NULL → `workforce_certifications` | |
| `workforce_profile_id` | UUID NOT NULL → `workforce_profiles` | |
| `decision` | TEXT | `VERIFIED` \| `REJECTED` \| `PENDING_VERIFICATION` |
| `previous_verification_status` | TEXT NULL | keputusan yang digantikan |
| `previous_verified_by_user_id` | UUID NULL → `users` | verifier yang digantikan |
| `previous_verified_at` | TIMESTAMPTZ NULL | |
| `changed_fields` | TEXT[] NULL | **hanya** terisi saat reset karena edit material |
| `reason` | TEXT NULL | catatan yang dikirim saat verify/reject (1–1000 karakter) |
| `decided_by_user_id` | UUID NULL → `users` | wajib kecuali `PENDING_VERIFICATION` |
| `decided_at` | TIMESTAMPTZ NOT NULL | |

Constraint penting:

- `decision IN (...)`, `previous_verification_status IN (...)`.
- `decision = 'PENDING_VERIFICATION' OR decided_by_user_id IS NOT NULL` — atestasi tanpa penulis bukan atestasi.
- `changed_fields IS NULL OR (decision = 'PENDING_VERIFICATION' AND array_length(changed_fields,1) >= 1)` —
  `changed_fields` **hanya** boleh mendeskripsikan reset.
- `reason` 1–1000 karakter setelah trim, atau `NULL`.

Index: `(certification_id, decided_at DESC)`, `(client_id, decided_at DESC)`.

### 3.2 `handyman_assignment_competency_evaluations` (PART B)

| Kolom | Tipe | Catatan |
|---|---|---|
| `id` | UUID PK | |
| `decision_group_id` | UUID NOT NULL | satu grup per assign/reassign |
| `client_id` | UUID NOT NULL → `clients` | |
| `execution_scope_id` | UUID NOT NULL → `handyman_execution_scopes` | |
| `assignment_id` | UUID NOT NULL → `handyman_execution_scope_assignments` | assignment yang **berhasil** |
| `handyman_crew_id` | UUID NOT NULL | crew yang dievaluasi |
| `action` | TEXT | `ASSIGNED` \| `REASSIGNED` |
| `service_catalog_id` | UUID NOT NULL | job type saat keputusan dibuat |
| `worker_context_id` / `workforce_profile_id` | UUID NOT NULL | worker yang dievaluasi |
| `requirement_id` | UUID NOT NULL | requirement saat keputusan dibuat |
| `requirement_type` | TEXT | `SKILL` \| `CERTIFICATION` |
| `enforcement_level` | TEXT | `MANDATORY` \| `RECOMMENDED` |
| `skill_id` / `skill_code` / `minimum_proficiency_level` | | snapshot fakta requirement |
| `certificate_name` | TEXT NULL | snapshot fakta requirement |
| `satisfied` | BOOLEAN NOT NULL | |
| `reason` | TEXT NULL | 6 kode gap yang sudah ada |
| `evidence_proficiency_level` | TEXT NULL | bukti minimum |
| `evidence_certification_id` | UUID NULL | **opaque**, tanpa nomor/dokumen |
| `evidence_verification_status` | TEXT NULL | |
| `evidence_expiry_date` | TIMESTAMPTZ NULL | |
| `evaluated_at` | TIMESTAMPTZ NOT NULL | |

Constraint penting:

- `(satisfied AND reason IS NULL) OR (NOT satisfied AND reason IS NOT NULL)` — hasil dan alasan tidak bisa
  saling bertentangan di level database.
- `reason` hanya 6 kode gap yang dikenal; `requirement_type`, `enforcement_level`, `action`, level proficiency
  dibatasi CHECK.
- **Tidak ada** kolom nomor sertifikat, `document_id`, `file_reference`, isi dokumen, atau token — dibatasi
  secara skema, bukan hanya oleh kode.

Index: `(client_id, execution_scope_id, evaluated_at DESC, id DESC)`, `(assignment_id)`, `(decision_group_id)`.

### 3.3 Append-only

`workforce_competency_history_block_mutation()` + dua trigger `*_no_write` (BEFORE UPDATE OR DELETE) menolak
mutasi dengan pesan `"<table> is an append-only decision ledger: <OP> is forbidden."` — pola identik `0396`.
`down()` melepas trigger, function, lalu kedua tabel.

### 3.4 Kompatibilitas dengan `0461`–`0463`

- `0461` (`workforce_certifications`) **tidak diubah**: kolom status/verifier tetap sumber kebenaran "keputusan
  saat ini". Ledger `0464` hanya **menambah** riwayat; tidak ada backfill, tidak ada kolom baru, tidak ada
  perubahan semantic pada baris lama. Sertifikat yang sudah ada tetap `PENDING_VERIFICATION`/`VERIFIED` seperti
  sebelumnya dan **tidak** mendapat baris ledger retroaktif (ledger mulai berlaku untuk keputusan berikutnya).
- `0462`/`0463` (requirement & eligibility 03A) **tidak disentuh**; ledger hanya membaca hasil evaluator yang
  sudah ada.
- Urutan migrasi: `0464` **setelah** `0463` (butuh `workforce_certifications`, `workforce_profiles`,
  `handyman_execution_scopes`, `handyman_execution_scope_assignments`).
- Migrasi bersifat **aditif dan reversibel**: `up` → `down` → `up` diverifikasi pada cluster disposable
  (tabel 2 → 0 → 2).

---

## 4. PART A — kebijakan re-verifikasi

### 4.1 Field material

Urutan kebijakan (`CERTIFICATION_MATERIAL_FIELDS`):

`certificateNumber, certificateName, issuingAuthority, issueDate, expiryDate, skillId, documentId, fileReference, status`

`notes` **tidak** termasuk. Alasannya: catatan administrasi tidak mengubah **apa** yang diatestasi; nomor,
nama, penerbit, tanggal, skill, dokumen, dan status **mengubah** klaim itu sendiri.

### 4.2 Kapan reset terjadi

Reset (`verificationStatus → PENDING_VERIFICATION`, `verifiedByUserId → NULL`, `verifiedAt → NULL`) terjadi bila:

1. ada field material yang **berbeda dari baris tersimpan**, dan
2. status verifikasi saat ini **bukan** `PENDING_VERIFICATION` (tidak ada gunanya "reset" yang sudah reset).

Perbandingan dilakukan terhadap **nilai tersimpan**:

- teks dibandingkan setelah `trim()`,
- tanggal dibandingkan sebagai **instant** (`new Date(x).toISOString()`), sehingga format `2026-01-01` vs
  `2026-01-01T00:00:00.000Z` tidak dianggap perubahan,
- `undefined` (field tidak dikirim) tidak pernah dianggap perubahan.

Konsekuensi penting: **mengirim ulang nilai yang sama tidak mencabut atestasi**. Ini kesengajaan — banyak klien
mengirim seluruh objek saat PATCH; perilaku "field dikirim = field berubah" akan mencabut verifikasi secara acak.

### 4.3 Atomisitas

Metadata baru + reset ditulis dalam **satu UPDATE**, dan baris ledger ditulis dalam **transaksi yang sama**
(`withTransaction`). Tidak pernah ada keadaan "fakta baru, atestasi lama", bahkan sesaat. Bila penulisan ledger
gagal, seluruh PATCH di-rollback.

### 4.4 Efek setelah reset

- `isValid = ACTIVE && !expired && VERIFIED` → otomatis `false`, sehingga requirement **MANDATORY** tidak lagi
  terpenuhi sampai sertifikat diverifikasi ulang (diuji di A4).
- Sertifikat kedaluwarsa tetap tidak bisa diverifikasi (A5) — reset pada sertifikat kedaluwarsa tetap
  `PENDING_VERIFICATION` dan verifikasi ditolak `WORKFORCE_CERTIFICATION_VERIFICATION_NOT_ALLOWED`.
- Maker-checker tidak berubah: pemilik tetap tidak boleh memverifikasi dirinya sendiri (A6, nol baris ledger).

### 4.5 Bentuk baris ledger

| Kejadian | `decision` | `previous_*` | `changed_fields` | `reason` |
|---|---|---|---|---|
| Verifikasi/reject eksplisit | `VERIFIED`/`REJECTED` | keputusan sebelumnya | `NULL` | catatan input (bila ada) |
| Reset karena edit material | `PENDING_VERIFICATION` | keputusan sebelumnya (termasuk verifier-nya) | daftar field material | `NULL` |

Dengan begitu, "reset administrasi" dan "keputusan manusia" bisa dibedakan tanpa tabel tambahan.

---

## 5. PART B — riwayat keputusan assignment

### 5.1 Kapan ditulis

Hanya pada **assign/reassign yang berhasil**, di dalam transaksi assignment:

- `assignHandymanExecutionScopeCrew` → `action = 'ASSIGNED'`
- `reassignHandymanExecutionScopeCrew` → `action = 'REASSIGNED'`

Assignment yang **ditolak** (gap MANDATORY, cross-client, crew tidak aktif, dsb.) tidak menulis apa pun —
rollback yang sama membatalkan baris ledger (B2: 0 baris evaluasi, 0 baris assignment).

### 5.2 Isi snapshot

Satu baris per (aksi × worker × requirement) untuk **setiap** worker yang dievaluasi — termasuk yang
`satisfied = true` dan requirement `RECOMMENDED`, karena riwayat harus menjelaskan keputusan yang **diambil**,
bukan hanya penolakan.

Bukti yang disimpan **minimum**: `evidence_certification_id` (opaque), `evidence_verification_status`,
`evidence_expiry_date`, `evidence_proficiency_level`. Yang **tidak** disimpan: nomor sertifikat, `document_id`,
`file_reference` (storage key), isi dokumen, token. Ini diuji langsung di B3 (JSON baris tidak boleh memuat
nomor sertifikat maupun path storage) — dan ditegakkan pula oleh skema tabel.

### 5.3 Job type tanpa requirement

Nol requirement → tidak ada yang dievaluasi → `{decisionGroupId: null, rowCount: 0}` dan perilaku assignment
**identik** dengan sebelum PART 03B1 (backward compatible).

---

## 6. Endpoint baru (2 operasi, keduanya read-only)

### 6.1 `GET /workforce/:workforceId/certifications/:certificationId/decisions`

- Permission: `workforce_certification.read` (otoritas baca **sama** dengan sertifikatnya: self-read, Crew Lead
  aktif, atau pemegang permission).
- Batas Client diturunkan dari **profil workforce**, bukan dari pemanggil → sertifikat Client lain = `403
  BUILDING_ACCESS_DENIED` (bukan halaman kosong).
- Sertifikat yang bukan milik workforce tsb = `404 WORKFORCE_CERTIFICATION_NOT_FOUND`.
- Urutan terbaru dulu; pagination **opt-in** (`page`/`pageSize`) dengan `meta {page,pageSize,total,totalPages}`;
  tanpa parameter, `meta = {}` (kontrak BE-25A) dan hasil dibatasi plafon repository.

### 6.2 `GET /handyman/execution-scopes/:executionScopeId/competency/history`

- Permission: `tenant_company.read` + **exact-Building** (BE-02G) — Building lain = `403 BUILDING_ACCESS_DENIED`.
- Selalu paginasi (`meta.total` wajib), filter opsional: `action`, `assignmentId`, `crewId`,
  `workerContextId`, `satisfied`, `enforcementLevel`.
- Parameter tidak valid (UUID/enum/boolean) = `400 VALIDATION_ERROR`.
- Read-only: tidak ada satu pun permukaan yang bisa mengubah/menghapus keputusan.

### 6.3 OpenAPI

- 2 path baru + 3 schema baru (`WorkforceCertificationDecision`, `AssignmentCompetencyHistoryItem`, dan
  pemakaian `PaginationMeta`), `x-error-codes`, `x-required-permission`, `x-building-scoped`.
- Freeze pin diperbarui **hanya** yang terdampak: `271 → 272` operasi Handyman, `181 → 182` operasi
  ter-anotasi (dengan komentar alasan di file test).
- **Tidak ada** permission baru, **tidak ada** kode error baru.

---

## 7. Backward compatibility

| Permukaan | Dampak |
|---|---|
| `PATCH /workforce/.../certifications/:id` | Kontrak request **sama**. Perubahan perilaku hanya: edit material kini mencabut atestasi (memang tujuan PART 03B1). `notes`-only dan re-send nilai identik **tidak** berubah (A2, A3). |
| `POST .../verify`, `.../deactivate` | Kontrak dan bentuk respons **sama** (`verify` tetap mengembalikan record sertifikat). Tambahan hanya baris ledger. |
| Assignment (assign/reassign) | Kontrak HTTP, status, dan body **sama**. Satu-satunya tambahan adalah baris ledger di transaksi yang sama + `metadata.competency` di event (sudah ada sejak 03A). |
| Job type tanpa requirement | Nol baris ledger, perilaku identik. |
| Data lama | Tidak di-backfill, tidak dimigrasi ulang, tidak ada perubahan makna baris lama. |
| Migrasi | Aditif; `down()` bersih. Tidak ada downtime khusus (hanya CREATE TABLE/INDEX/TRIGGER). |

---

## 8. Catatan operator (migrasi)

1. `npm run db:migrate` — `0464` berjalan setelah `0463`.
2. Verifikasi: `SELECT id FROM schema_migrations WHERE id LIKE '0464%'` → 1 baris.
3. Tabel baru: `workforce_certification_decisions`, `handyman_assignment_competency_evaluations`
   (+ 5 index, 2 trigger `*_no_write`).
4. Retensi: kedua tabel append-only dan tumbuh monoton. Belum ada kebijakan arsip — ukurannya sebanding
   (jumlah keputusan sertifikasi) dan (jumlah assignment × worker × requirement); untuk volume saat ini tidak
   perlu intervensi. Bila perlu arsip, lakukan lewat job ekspor + partisi, **bukan** DELETE (ditolak trigger).
5. Rollback: `0464.down()` menghapus trigger → function → kedua tabel. **Data ledger akan hilang**; kolom
   verifikasi di `0461` tetap utuh, jadi tidak ada kehilangan kemampuan operasional.

---

## 9. Bukti pengujian

| Suite | Hasil |
|---|---|
| `tests/worker-competency-03b1.test.ts` (**baru**, 14 test, embedded PostgreSQL disposable `/tmp/hm-competency-03b1-pg:55661`) | **14/14 PASS** |
| `tests/workforce-certifications.test.ts` | 6/6 PASS |
| `tests/workforce-certifications-http.test.ts` | 18/18 PASS |
| `tests/handyman-competency-assignment.test.ts` (03A) | 11/11 PASS |
| `tests/handyman-execution-scope-assignment-service.test.ts` (PART B) | 10/10 PASS |
| `tests/handyman-execution-scope-assignments.test.ts` (PART A) + `...-scope-guard` + `handyman-dispatch-authority.test.ts` | 24/24 PASS |
| `tests/handyman-scope-assignments-api.test.ts` (PART C) | 9/10 PASS — test 10 pra-eksisting gagal (lihat §10) |
| `tests/handyman-contract-freeze-03-openapi.test.ts` | 13/13 PASS (pin 271→272, 181→182) |
| `tests/openapi-contract.test.ts` | 7/7 PASS |
| `tests/mobile-openapi-completeness.test.ts` | 5/5 PASS |
| Migrasi `0464` standalone (`migrateUp` + `down` + `up`) | tabel 2 → 0 → 2, tercatat di `schema_migrations` |
| `npm run typecheck` | bersih |
| `npm run build` | bersih |

Pemetaan 14 test baru ke acceptance criteria:

**PART A — re-verifikasi**

| Test | Yang dibuktikan |
|---|---|
| A1 | Edit material mereset ke `PENDING_VERIFICATION`, mengosongkan triple verifier, `isValid=false`, dan menambah baris ledger (`changed_fields=['certificateName']`, `previous_verified_by_user_id` = manager). |
| A2 | Edit `notes` **tidak** mereset (tetap 1 baris ledger). |
| A3 | Mengirim ulang nilai identik **tidak** mereset. |
| A4 | Sertifikat yang di-reset tidak lagi memenuhi requirement MANDATORY; setelah verifikasi ulang kembali memenuhi; ledger = `VERIFIED → PENDING_VERIFICATION → VERIFIED`. |
| A5 | Sertifikat kedaluwarsa: `status EXPIRED` + reset; verifikasi ulang ditolak `WORKFORCE_CERTIFICATION_VERIFICATION_NOT_ALLOWED`. |
| A6 | Maker-checker: self-verification ditolak `WORKFORCE_CERTIFICATION_SELF_VERIFICATION_FORBIDDEN`, nol baris ledger. |
| A7 | Cross-client decision read ditolak `BUILDING_ACCESS_DENIED`. |
| A8 | Endpoint decisions: 401 anonim, paginasi `page/pageSize` dengan `meta.total` benar (2 baris → 2 halaman), `meta = {}` tanpa parameter. |
| A9 | UPDATE dan DELETE pada `workforce_certification_decisions` ditolak database (`/append-only/i`). |

**PART B — decision history**

| Test | Yang dibuktikan |
|---|---|
| B1 | Assign menulis baris `ASSIGNED` (bukti `ADVANCED`), reassign menulis baris `REASSIGNED` (bukti `EXPERT`, `assignment_id` baru). |
| B2 | Assignment yang ditolak (rollback) menulis 0 baris evaluasi **dan** 0 baris assignment. |
| B3 | Snapshot tidak memuat nomor sertifikat maupun storage key; `evidence_certification_id` + `evidence_verification_status='VERIFIED'` tersimpan. |
| B4 | History: 401 anonim, 403 `BUILDING_ACCESS_DENIED` untuk aktor Client lain, 200 + paginasi untuk pembaca satu Building dengan `tenant_company.read`, `?satisfied=false` → `data` kosong & `total 0`, `?action=DELETED` → 400. |
| B5 | UPDATE/DELETE pada `handyman_assignment_competency_evaluations` ditolak database. |

---

## 10. Isu pra-eksisting (tidak diperbaiki, sengaja)

| Suite / test | Sebab | Status |
|---|---|---|
| `handyman-scope-assignments-api` test 10 | Route `GET /handyman/requests/{handymanRequestId}/inspector-assignments/history` (CR lain) sudah ada di runtime + OpenAPI namun tidak diperhitungkan filter test. Terverifikasi gagal pada baseline `f1dac0b` **dan** `558ba4d`. | Tidak disentuh (di luar cakupan) |
| `openapi-saas-route-parity` test 15 | `$ref` rusak pra-eksisting pada `HandymanStatusVisibilityReadView`. | Tidak disentuh |
| `openapi-operational-final-parity`, `deployment-cors-production`, `r08-*` | Pin jumlah operasi/migrasi yang sudah usang sejak CR sebelumnya (selisih ratusan operasi, tidak mungkin disebabkan 2 path baru). | Tidak disentuh |

Tidak ada regresi baru: seluruh suite yang gagal sudah gagal pada baseline dan tidak menyentuh jalur competency.

---

## 11. File yang berubah / ditambah

**Baru**

- `src/database/migrations/0464_workforce_competency_decision_history.ts`
- `src/modules/workforce-certifications/workforce-certification-decision.repository.ts`
- `src/modules/worker-competency-eligibility/worker-competency-decision.repository.ts`
- `tests/worker-competency-03b1.test.ts`
- `docs/handyman/CR-HM-WORKER-COMPETENCY-01_PART03B1_DELIVERY_REPORT.md` (dokumen ini)

**Diubah**

- `src/database/migrations/index.ts` — registrasi `0464` setelah `0463`
- `src/modules/workforce-certifications/workforce-certification.service.ts` — `resolveMaterialChanges`,
  `normalizeComparableDate`, `update`/`verify` transaksional, `listWorkforceCertificationDecisions`
- `src/modules/workforce-certifications/workforce-certification.repository.ts` — parameter `executor` opsional
  pada `findById`, `findByIdInWorkforceProfile`, `update` (agar bisa ikut transaksi)
- `src/modules/workforce-certifications/workforce-certification.{types,controller,routes}.ts` —
  `CertificationDecisionRecord`, `CERTIFICATION_MATERIAL_FIELDS`, handler + route `.../decisions`
- `src/modules/worker-competency-eligibility/worker-competency-eligibility.{service,types,controller,routes,index}.ts`
  — `evaluateExecutionScopeCompetency`, `recordAssignmentCompetencyDecision`,
  `listAssignmentCompetencyHistory`, handler + route `.../competency/history`
- `src/modules/handyman-scope-assignments/handyman-scope-assignment.service.ts` — `assertCompetencyEligible`
  mengembalikan keputusan; `persistCompetencyDecision(tx, ...)` pada assign & reassign
- `docs/api/openapi.yaml` — 2 path, 3 schema, `x-error-codes`, `x-required-permission`, `x-building-scoped`
- `tests/handyman-contract-freeze-03-openapi.test.ts` — pin `271→272` & `181→182` (dengan komentar)
- `docs/handyman/CR-HM-WORKER-COMPETENCY-01_PART03B_BACKLOG.md` — item 1 & 2 ditandai delivered

---

## 12. Commit

- Implementasi: **`76eb66b`** —
  `feat(competency): PART 03B1 certification re-verification & assignment decision history`
- Branch: `arena/3df97f5e-handyman-backend` (di-push ke origin)
- Baseline: `f1dac0b` (PART 03A)
- **Tidak** ada PR, merge, atau deploy.

---

## 13. Sisa backlog (PART 03B2)

Lihat `docs/handyman/CR-HM-WORKER-COMPETENCY-01_PART03B_BACKLOG.md`. Sisa item, urut prioritas:

**P0 / P1**
1. **Expiry sweeper** — `status='EXPIRED'` masih dihitung saat dibaca; evaluator sudah benar tanpa sweeper,
   kekurangannya hanya observability & notifikasi.
2. **Requirement untuk Work Order** — `work_orders.work_type` masih teks bebas tanpa relasi `service_catalog`;
   perlu pemetaan, lalu **pakai ulang** evaluator yang sama (jangan evaluator kedua).
3. **Bulk konfigurasi requirement** — impor CSV/JSON per Client (preview → validate → commit).
4. **Requirement per Building / Client-policy** — saat ini melekat pada job type (Client-wide); butuh
   keputusan governance.

**P2**
5. **Near-miss → rekomendasi pelatihan** — `gapEvidence` sudah menyimpan sertifikat terdekat & level aktual;
   bisa diangkat jadi rekomendasi di layer baca tanpa mengubah penegakan.
6. **Handoff frontend** — halaman konfigurasi requirement, indikator gap pada modal assign/reassign, dan
   (baru dari 03B1) tampilan riwayat keputusan + ledger verifikasi sertifikat.
7. **Candidates: dimensi penempatan** — flag `placementEligible` read-only bila UI butuh "siap tugaskan".
8. **Export audit requirement** — ekspor riwayat perubahan requirement untuk audit eksternal.
9. **Kebijakan retensi ledger** — arsip/partisi untuk kedua tabel append-only (via ekspor, bukan DELETE).

**Catatan konsistensi untuk PART 03B2**

- Satu evaluator (`worker-competency-eligibility`) untuk penegakan **dan** baca.
- Sertifikasi tidak boleh menjadi wajib untuk semua worker; hanya bila dikonfigurasi.
- Jangan menambah jalur assignment kedua; penegakan tetap di `handyman-scope-assignment.service.ts`.
- Pertahankan invarian frozen CR-HM-04 PART C: tepat dua bentuk URL assignment.
- Client/Building scope wajib ditegakkan pada setiap operasi baru.
- Kedua ledger 03B1 tetap **append-only**; jangan menambahkan UPDATE/DELETE.
