# CR-HM-WORKER-COMPETENCY-01 — PART 03A Delivery Report
## Competency-Based Work Assignment (Persyaratan Kompetensi per Job Type + Penegakan di Otoritas Assignment)

- **Branch:** `arena/3df97f5e-handyman-backend`
- **Baseline:** `558ba4d06729e015198000220fcbafcf39501572` (PART 02)
- **Scope:** PART 03A saja. PART 01 & PART 02 **tidak** diubah ulang.
- **Status:** selesai, teruji, di-commit, di-push. **Tanpa PR / merge / deploy.**
- **Tidak ada perubahan produksi**, tidak ada perubahan role Super User, tidak ada perubahan password.

---

## 1. Ringkasan eksekutif

PART 02 membuat sertifikasi worker **terbaca dan tervalidasi** (`isValid = ACTIVE && !expired && VERIFIED`),
tetapi belum ada yang **memakainya**: siapa pun masih bisa menugaskan crew yang tidak kompeten.

PART 03A menutup celah itu dengan tiga lapis:

1. **Model persyaratan per job type** — tabel baru `service_catalog_competency_requirements` (migrasi `0463`).
   Job type = entri Service Catalog (`service_catalog`, `0321`) yang menempel pada Handyman Service Request
   (`0378`), yang menjadi asal Execution Scope (`0395`).
2. **Satu evaluator** — `worker-competency-eligibility` menghitung verdict untuk setiap anggota crew aktif.
3. **Penegakan di otoritas yang sudah ada** — `handyman-scope-assignment.service.ts` (CR-HM-04 PART B) memanggil
   evaluator itu untuk **assign** dan **reassign**. Tidak ada workflow assignment kedua, tidak ada endpoint
   alternatif, tidak ada flag `force`/`override`.

Prinsip yang dipegang:

- **Sertifikasi tidak pernah wajib untuk semua worker.** Nol baris requirement = perilaku identik dengan sebelum
  PART 03A. Tidak ada seed/default requirement.
- **RECOMMENDED tidak pernah memblokir.** Hanya `MANDATORY` yang menolak assignment.
- **Semua anggota crew aktif** harus memenuhi setiap requirement MANDATORY, bukan hanya Lead.
- **Client/Building scope tetap ditegakkan** pada setiap operasi (baca maupun tulis).

---

## 2. Audit alur assignment (temuan)

| Area | Modul | Temuan |
|---|---|---|
| Otoritas assignment Handyman | `handyman-scope-assignments` (service 506 baris, repository 274 baris) | **Satu-satunya penulis** `handyman_execution_scope_assignments`: `insertAssignment` & `supersedeAssignment`. Dipakai hanya oleh `assignHandymanExecutionScopeCrew` dan `reassignHandymanExecutionScopeCrew`. |
| Eligibility lama | `handyman-providers/handyman-worker-eligibility.repository.ts` | Memeriksa registrasi (worker context ACTIVE, vendor binding, workforce ACTIVE), penempatan Building, dan login Lead. **Tidak** memeriksa skill/sertifikat. |
| Dispatch | `handyman-dispatch` | `releaseHandymanDispatch` mensyaratkan assignment ACTIVE dan readiness; **tidak bisa** dipakai membuat assignment → bukan jalur bypass. |
| Inspector | `handyman-inspector-assignments(-api)` | Domain terpisah (visit inspector), tidak menyentuh crew assignment. |
| Work Order | `work-order-assignments` | Assignee `workforce/team/vendor` dengan `work_orders.work_type` berupa teks bebas; **tidak ada** relasi ke `service_catalog` → tidak punya asal requirement. Perilaku tidak diubah (lihat §8). |
| Vendor / Mobile / External workforce | `vendor-assignments`, `mobile-assignments`, `external-workforce`, `vendor-workforce`, `teams`, `workforce-building-assignments` | Tidak menulis `handyman_execution_scope_assignments`; hanya memasok identitas/penempatan. |
| Katalog jasa | `service-catalog` (service 318, validation 289, repository 244) | Hanya identitas (code/name/category/status). **Belum ada** model persyaratan skill/sertifikat → model baru diperlukan. |
| Peta skill worker | `workforce-skills` (`workforce_skill_assignments`) | Sudah menyimpan `proficiency_level` (BASIC/INTERMEDIATE/ADVANCED/EXPERT) + window `valid_from`/`valid_until` → **dipakai ulang**, tidak diduplikasi. |
| Sertifikat worker | `workforce-certifications` (PART 01/02) | `isValid` sudah operasional; resolver expiry `resolveWorkforceCertificationExpiryStatus` diimpor agar aturan tidak menyimpang. |

**Kesimpulan audit:** titik penegakan yang benar adalah `validateTarget` → gate baru di dalam transaksi
`assign`/`reassign`. Tidak ada jalur tulis lain yang perlu ditambal.

---

## 3. Model data — migrasi `0463_service_catalog_competency_requirements`

Tabel: `service_catalog_competency_requirements`

| Kolom | Tipe | Catatan |
|---|---|---|
| `id` | UUID PK | |
| `client_id` | UUID NOT NULL → `clients` | server-derived dari entri katalog |
| `service_catalog_id` | UUID NOT NULL | **FK gabungan** `(service_catalog_id, client_id)` → `service_catalog (id, client_id)` |
| `requirement_type` | TEXT | `SKILL` \| `CERTIFICATION` |
| `enforcement_level` | TEXT DEFAULT `MANDATORY` | `MANDATORY` \| `RECOMMENDED` |
| `skill_id` | UUID → `skills` | wajib untuk `SKILL`; opsional (penyempit) untuk `CERTIFICATION` |
| `minimum_proficiency_level` | TEXT | wajib untuk `SKILL`; `NULL` untuk `CERTIFICATION` |
| `certificate_name` | TEXT | wajib untuk `CERTIFICATION`; `NULL` untuk `SKILL` |
| `notes` | TEXT | opsional 1–1000 |
| `status` | TEXT DEFAULT `ACTIVE` | `ACTIVE` → `INACTIVE` (terminal untuk penegakan, baris tetap ada) |
| `created_by_user_id`, `created_at`, `updated_at` | | audit |

Constraint penting:

- `service_catalog_competency_requirements_shape_check` — bentuk wajib per `requirement_type`
  (`SKILL` ⇒ skill + level, tanpa certificate name; `CERTIFICATION` ⇒ certificate name, tanpa level).
- `..._client_fk` — scope Client struktural (FK gabungan).
- Trigger `trg_service_catalog_competency_requirements_scope_guard` — memastikan `skill_id` milik Client yang
  sama dengan entri katalog (preseden `0461`), sehingga service/seed tidak bisa melintasi Client.
- Unique parsial `..._skill_unique` — satu requirement ACTIVE per (job type, skill).
- Unique parsial `..._cert_unique` — satu requirement ACTIVE per (job type, `lower(btrim(certificate_name))`).
- Index `..._catalog_idx` (job type + status + enforcement) dan `..._client_idx`.

**Head migrasi sekarang `0463`** (`0462` tetap head PART 02; `0449` sengaja tidak dipakai).

---

## 4. Aturan evaluasi (satu evaluator, dua pemakai)

`worker-competency-eligibility` dipakai oleh (a) penegakan assignment dan (b) endpoint baca. Karena satu fungsi,
jawaban preflight **tidak mungkin** berbeda dengan keputusan assignment.

| Requirement | Terpenuhi bila | Alasan penolakan (`reason`) |
|---|---|---|
| `SKILL` | worker punya `workforce_skill_assignments` ACTIVE untuk skill tsb, di dalam window `valid_from/valid_until`, dengan level ≥ minimum | `SKILL_MISSING`, `PROFICIENCY_INSUFFICIENT` |
| `CERTIFICATION` | ada `workforce_certifications` dengan `certificate_name` sama (case-insensitive, whitespace dinormalisasi), status `ACTIVE`, `verification_status = VERIFIED`, dan belum kedaluwarsa; bila requirement menyempit dengan `skill_id`, sertifikat harus terhubung ke skill itu | `CERTIFICATION_MISSING`, `CERTIFICATION_UNVERIFIED`, `CERTIFICATION_EXPIRED`, `CERTIFICATION_INACTIVE` |

Aturan tambahan:

- Requirement `INACTIVE` tidak pernah dievaluasi.
- Job type tanpa requirement ACTIVE → fast path, tanpa query skill/sertifikat (biaya satu query keanggotaan).
- Setiap anggota crew ACTIVE dievaluasi; crew eligible ⇔ **semua** anggota eligible.
- `RECOMMENDED` yang gagal masuk `advisoryGaps` (tidak pernah memblokir).
- Bukti (`evidence`) disertakan untuk requirement yang terpenuhi; `gapEvidence` untuk yang gagal
  (mis. sertifikat kedaluwarsa yang benar-benar dipegang worker) supaya Operations tahu langkah perbaikannya.
- Validasi expiry memakai `resolveWorkforceCertificationExpiryStatus` (PART 02) — tidak ada aturan kedaluwarsa
  kedua di repo ini.

---

## 5. Endpoint & DTO baru (7 operasi)

### 5.1 Konfigurasi requirement (Operations/Web, di bawah entri Service Catalog)

| Method | Path | Permission | Sukses |
|---|---|---|---|
| GET | `/api/v1/service-catalog/entries/{id}/competency-requirements` | `service_catalog.read` | 200 list |
| POST | `/api/v1/service-catalog/entries/{id}/competency-requirements` | `service_catalog.manage` | 201 |
| GET | `/api/v1/service-catalog/entries/{id}/competency-requirements/{requirementId}` | `service_catalog.read` | 200 |
| PATCH | `/api/v1/service-catalog/entries/{id}/competency-requirements/{requirementId}` | `service_catalog.manage` | 200 |
| POST | `/api/v1/service-catalog/entries/{id}/competency-requirements/{requirementId}/deactivate` | `service_catalog.manage` | 200 |

Filter list: `status`, `enforcementLevel`, `requirementType`.

DTO keluar `ServiceCompetencyRequirement`:
`{ id, clientId, serviceCatalogId, requirementType, enforcementLevel, skillId, skill{id,code,name,category,status},
minimumProficiencyLevel, certificateName, notes, status, createdByUserId, createdAt, updatedAt }`

Body create (allow-list ketat; key lain → 400, jadi `clientId`/`status`/`serviceCatalogId`/`createdByUserId`
tidak bisa diselundupkan):
`{ requirementType (wajib), enforcementLevel?, skillId?, minimumProficiencyLevel?, certificateName?, notes? }`

Body PATCH: `{ enforcementLevel?, minimumProficiencyLevel?, certificateName?, notes? }`.
`requirementType` dan `skillId` **immutable** (koreksi = deactivate + buat baru) supaya assignment lama tidak
ditafsirkan ulang secara retroaktif.

### 5.2 Eligibility & kandidat (read-only, namespace Execution Scope)

| Method | Path | Permission | Sukses |
|---|---|---|---|
| GET | `/api/v1/handyman/execution-scopes/{executionScopeId}/competency/eligibility?crewId=` | `tenant_company.read` | 200 |
| GET | `/api/v1/handyman/execution-scopes/{executionScopeId}/competency/candidates` | `tenant_company.read` | 200 |

DTO `CrewCompetencyEligibilityReport`:
`{ executionScopeId, serviceCatalogId, serviceCatalogCode, crewId, summary{requirementCount,
mandatoryRequirementCount, recommendedRequirementCount, requirementsConfigured}, eligible, blockingGaps[],
advisoryGaps[], workers[] }`

DTO `CompetencyCandidateReport`:
`{ executionScopeId, serviceCatalogId, serviceCatalogCode, summary, eligibleCandidateCount,
candidates[{crewId, crewCode, crewName, providerContextId, providerContextStatus, competencyEligible,
blockingGaps[], advisoryGaps[], workers[]}] }`

DTO `CompetencyRequirementEvaluation`:
`{ requirementId, requirementType, enforcementLevel, skillId, skillCode, skillName, minimumProficiencyLevel,
certificateName, satisfied, reason, evidence, gapEvidence }`

DTO `WorkerCompetencyEligibility`:
`{ workerContextId, workforceProfileId, workforceProfileName, isLead, eligible, blockingGaps[], advisoryGaps[],
satisfiedCount, requirementsEvaluated }`

**Catatan namespace:** endpoint baca diletakkan di `/competency/*`, **bukan** `/assignment/*`, agar invarian
frozen CR-HM-04 PART C ("tepat dua bentuk URL assignment") tetap literal. PART 03A menambah penjelasan,
bukan jalan kedua untuk meng-assign.

---

## 6. Permission & scope

- **Tidak ada permission baru.** Konfigurasi memakai vocabulary katalog (`service_catalog.read|manage`),
  baca eligibility memakai `tenant_company.read` (sama dengan `GET .../assignment`).
- Permission lebar tidak pernah memperluas jangkauan Client: service memanggil
  `contextAccessService.canAccessClient` (konfigurasi) dan `assertBuildingScopedResourceAccess` (eligibility)
  berdasarkan Building dari baris scope/entri yang authoritative.
- Operasi tulis assignment tetap `tenant_company.manage`; verdict competency tidak bisa dipakai untuk
  melewatinya (tidak ada parameter `force`/`override`).

---

## 7. Penegakan & anti-bypass

- Gate dijalankan **di dalam transaksi** setelah `validateTarget` (provider/crew/Lead/penempatan) dan
  **sebelum** ada baris ditulis. Gagal ⇒ 409 `HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_COMPETENCY_REQUIRED`
  dengan `details[]` per gap (`workerContextId`, `workforceProfileId`, `requirementId`, `requirementType`,
  `skillCode`, `certificateName`, `minimumProficiencyLevel`, `reason`). Tidak ada baris/event parsial.
- **Reassign** memakai gate yang sama, dan dijalankan **sebelum** supersede → reassignment yang ditolak
  meninggalkan assignment ACTIVE lama utuh (versi tidak berubah, tidak ada history palsu).
- **Anti-bypass:** hanya dua fungsi itu yang menulis `handyman_execution_scope_assignments`; dispatch release
  justru mensyaratkan assignment ACTIVE. Tidak ada endpoint assignment alternatif di seluruh router.
- Jejak audit: event `HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CREATED|SUPERSEDED` sekarang membawa
  `metadata.competency = { requirementCount, mandatoryRequirementCount }` — termasuk `0/0` untuk job type
  tanpa requirement, sehingga assignment lama tetap bisa dijelaskan tanpa merekonstruksi state katalog lama.
- Event konfigurasi: `SERVICE_COMPETENCY_REQUIREMENT_CREATED|UPDATED|DEACTIVATED`.

---

## 8. Backward compatibility

| Skenario | Perilaku |
|---|---|
| Job type tanpa requirement (kondisi semua data existing) | Identik dengan sebelum PART 03A; gate mengembalikan `requirementsConfigured=false` |
| Sertifikasi worker | Tidak pernah wajib kecuali Client mengonfigurasi requirement |
| Skill | Tidak berubah; hanya dibaca (`workforce_skill_assignments` tetap satu-satunya sumber) |
| Work Order assignment (`work-order-assignments`) | Tidak berubah — tidak ada relasi job type/service catalog, jadi tidak ada asal requirement; didokumentasikan sebagai di luar cakupan penegakan PART 03A |
| Tabel CR-HM-04 | `handyman_execution_scope_assignments` tidak diubah (tanpa kolom baru, trigger tetap) |
| Role Super User / password | Tidak disentuh |

---

## 9. Migrasi & catatan operator

- Jalankan `npm run db:migrate` → membuat tabel `service_catalog_competency_requirements` + trigger + index.
- Tidak ada seed/grant baru. Untuk mengonfigurasi requirement, role butuh `service_catalog.manage` **dan**
  akses ke Client entri tersebut. Untuk membaca eligibility, role butuh `tenant_company.read` **dan**
  assignment Building yang tepat.
- Deaktivasi requirement berlaku seketika untuk assignment **baru**; assignment yang sudah ACTIVE tidak
  dibatalkan otomatis (tidak ada retro-invalidasi diam-diam).

---

## 10. Bukti pengujian

| Suite | Hasil |
|---|---|
| `tests/handyman-competency-assignment.test.ts` (**baru**, 11 test, PostgreSQL disposable via embedded PG) | **11/11 PASS** |
| `tests/handyman-execution-scope-assignment-service.test.ts` (PART B) | 10/10 PASS |
| `tests/handyman-execution-scope-assignments.test.ts` (PART A) | 10/10 PASS |
| `tests/handyman-scope-assignments-api.test.ts` (PART C) | 9/10 PASS — test 10 pra-eksisting gagal (lihat §11) |
| `tests/handyman-dispatch-authority.test.ts` | 10/10 PASS |
| `tests/handyman-contract-freeze-03-openapi.test.ts` | 13/13 PASS (pin 269→271, 179→181) |
| `tests/openapi-contract.test.ts` | 7/7 PASS |
| `tests/config-perm-01-permission-registry.test.ts` | 13/13 PASS (tanpa permission baru) |
| `tests/mobile-openapi-completeness.test.ts` | 5/5 PASS |
| `tests/handyman-cross-repo-gap-contract.test.ts` | 4/4 PASS |
| `tests/openapi-saas-route-parity.test.ts` | 14/15 PASS — test 15 pra-eksisting gagal (lihat §11) |
| `npm run typecheck` | bersih |
| `npm run build` | bersih |

Cakupan 11 test baru (pemetaan ke acceptance criteria):

1. Job type tanpa requirement → assign 201 + bukti `metadata.competency = 0/0`.
2. Requirement SKILL ACTIVE dibuat via HTTP; crew kompeten → 201; duplikat → 409; field selundupan → 400; list → 1.
3. Proficiency kurang (BASIC vs ADVANCED) → 409 `reason=PROFICIENCY_INSUFFICIENT`, nol baris assignment.
4. Sertifikat kedaluwarsa → 409 `CERTIFICATION_EXPIRED`.
5. Sertifikat belum diverifikasi → 409 `CERTIFICATION_UNVERIFIED`; preflight membaca alasan yang sama.
6. Sertifikat VERIFIED & berlaku → 201; requirement RECOMMENDED yang tidak dipenuhi hanya muncul di
   `advisoryGaps` (tidak memblokir).
7. Semua anggota crew aktif diuji, bukan hanya Lead (member tanpa skill → 409 dengan `workforceProfileId` member).
8. Endpoint kandidat: 1 crew qualified, 1 crew ditolak + alasannya (`eligibleCandidateCount = 1`).
9. Cross-client: skill Client lain → 400 `SERVICE_COMPETENCY_REQUIREMENT_SKILL_MISMATCH`; aktor dengan
   Building hanya di Client lain → 403 `BUILDING_ACCESS_DENIED` pada eligibility & candidates; scope miliknya
   sendiri → 200.
10. Reassign ke crew tidak kompeten → 409, assignment ACTIVE lama utuh (id/versi/crew sama, tanpa history);
    reassign ke crew kompeten → 201 dengan tepat satu baris ACTIVE.
11. Deactivate requirement → assign 201; PATCH level BASIC → 200; INACTIVE tetap terbaca di list.

---

## 11. Isu pra-eksisting (tidak diperbaiki, sengaja)

| Suite / test | Sebab | Status |
|---|---|---|
| `handyman-scope-assignments-api` test 10 | Route `GET /handyman/requests/{handymanRequestId}/inspector-assignments/history` (CR lain) sudah ada di runtime+OpenAPI namun tidak diperhitungkan oleh filter `handymanAssignments` di test. Terverifikasi gagal juga pada baseline `558ba4d`. | Tidak disentuh (di luar cakupan PART 03A) |
| `openapi-saas-route-parity` test 15 | `$ref` rusak pra-eksisting pada `HandymanStatusVisibilityReadView` (bukan file/CR ini). Terverifikasi gagal pada baseline. | Tidak disentuh |
| `openapi-operational-final-parity` (`1687`), `deployment-cors-production` (`457`/`0458`), `r08-*` | Pin jumlah operasi/migrasi yang sudah usang sejak CR sebelumnya. | Tidak disentuh |

Tidak ada regresi yang diperkenalkan PART 03A: seluruh suite yang gagal sudah gagal pada baseline dan
kegagalannya tidak menyentuh jalur competency.

---

## 12. File yang berubah / ditambah

**Baru**

- `src/database/migrations/0463_service_catalog_competency_requirements.ts`
- `src/modules/service-competency-requirements/` (types, errors, repository, validation, service, controller, routes, index)
- `src/modules/worker-competency-eligibility/` (types, repository, service, controller, routes, index)
- `tests/handyman-competency-assignment.test.ts`
- `docs/handyman/CR-HM-WORKER-COMPETENCY-01_PART03A_DELIVERY_REPORT.md` (dokumen ini)
- `docs/handyman/CR-HM-WORKER-COMPETENCY-01_PART03B_BACKLOG.md`

**Diubah**

- `src/database/migrations/index.ts` — registrasi `0463`
- `src/shared/errors.ts` — 6 kode baru
- `src/modules/handyman-scope-assignments/handyman-scope-assignment.service.ts` — gate competency pada
  assign & reassign + `metadata.competency` pada audit event
- `src/routes/index.ts` — 2 router baru
- `docs/api/openapi.yaml` — 5 path / 7 operasi baru, 8 schema, 1 parameter, 2 daftar `x-error-codes`
- `tests/handyman-contract-freeze-03-openapi.test.ts` — pin 269→271 & 179→181 (dengan komentar)
- `docs/handyman/CR-HM-WORKER-COMPETENCY-01_PART03_BACKLOG.md` — item 5 ditandai delivered

---

## 13. Kode error baru

| Kode | HTTP | Kapan |
|---|---|---|
| `SERVICE_COMPETENCY_REQUIREMENT_NOT_FOUND` | 404 | requirement tidak ada untuk entri tsb |
| `SERVICE_COMPETENCY_REQUIREMENT_ALREADY_EXISTS` | 409 | duplikat ACTIVE (skill atau certificate name) |
| `SERVICE_COMPETENCY_REQUIREMENT_INVALID_STATE` | 409 | PATCH/deactivate pada requirement INACTIVE |
| `SERVICE_COMPETENCY_REQUIREMENT_SKILL_MISMATCH` | 400 | skill milik Client lain |
| `SERVICE_COMPETENCY_REQUIREMENT_SERVICE_INACTIVE` | 409 | konfigurasi pada entri katalog INACTIVE |
| `HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_COMPETENCY_REQUIRED` | 409 | assign/reassign ditolak oleh gap MANDATORY |

---

## 14. Commit

- Implementasi: **`8c7e8ef`** — `feat(worker-competency): CR-HM-WORKER-COMPETENCY-01 PART 03A competency-based work assignment`
- Branch: `arena/3df97f5e-handyman-backend` (di-push ke origin)
- Baseline PART 02: `558ba4d06729e015198000220fcbafcf39501572`
- **Tidak** ada PR, merge, atau deploy.

---

## 15. Handoff PART 03B

Lihat `docs/handyman/CR-HM-WORKER-COMPETENCY-01_PART03B_BACKLOG.md`. Inti: history read model evaluasi,
kebijakan re-verifikasi, requirement untuk Work Order (`work_type` → katalog), bulk konfigurasi,
sweeper kedaluwarsa, dan handoff frontend.
