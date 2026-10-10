# W03 PART 01 — PIC Readiness & Permission Registry Guard

**Status: TEST-ONLY + DOKUMENTASI.** Tidak ada perubahan route produksi, service, repository, schema, migration, permission grant, atau business logic. Nol baris `src/` berubah.

- Branch: `arena/44e8ce22-handyman-backend` · HEAD saat PART ini dimulai: `913b3f2` (expected, cocok) · ancestry `main`@`9602991` → 21 ahead / 0 behind · working tree bersih saat masuk.
- Lanjutan langsung dari `W03_QUOTATION_PIC_APPROVAL_RECONCILIATION.md` §7 (blind spot F-01), §5 Q-D1/Q-D2/Q-D8, dan §8.

---

## 1. Perbaikan gerbang ROUTE-TO-REGISTRY (scope 2–4)

**Sebelum.** `tests/config-perm-01-permission-registry.test.ts` memindai satu bentuk saja,
`PERMISSION_CALL = /requirePermission\(\s*['"`]([^'"`]+)['"`]\s*\)/g`, hanya di file `*.routes.ts`
di bawah `src/modules` dan `src/routes`. Konsekuensi: kode yang dipasang lewat
`requireAnyPermission([...])` (middleware yang ditambahkan W02 PART 04A, `src/modules/auth/rbac.middleware.ts:55`,
satu pemakai: `handyman-lifecycle-api.routes.ts:50-53`) **tidak terlihat gerbang**. Di bawah default-deny,
kode tak terdaftar di balik any-of sama tidak tercapainya dengan kode di balik `requirePermission` — tetapi
tidak ada test yang gagal. Guard yang bisa dihindari dengan memilih middleware lain bukan guard.

**Sesudah.** Satu scanner untuk kedua bentuk:

| Aspek | Perubahan | Alasan |
|---|---|---|
| Bentuk admission | `require(?:Any)?Permission\s*\(\s*(\[[^\]]*\]\|['"`]…['"`])` — literal di dalam array/list diurai satu-satu | any-of adalah enforcement nyata |
| cakupan file | `walkRouteFiles(*.routes.ts)` → `walkTsFiles(src/)` (semua `.ts`) | literal yang dipasang lewat file helper tetap enforcement; mencegah bentuk baru lolos karena nama file |
| komentar | di-strip sebelum memindai (`/* */` dan `//`) | prosa yang menyebut sebuah kode tidak pernah dihitung sebagai enforcement |
| Reuse | `unregisteredCodes(enforcedCodesByFile(files))` dipakai test gateway DAN fixture negatif | fixture melewati jalur kode yang sama, bukan salinan logika |

**Tervalidasi netral di tree hari ini** (penting: perbaikan ini tidak mengubah verdict, hanya menutup lubang):
himpunan kode hasil scan identik sebelum/sesudah = **333 kode, 0 unregistered**; tidak ada kode yang hanya
muncul di komentar; tidak ada kode any-of yang tidak juga muncul di `requirePermission` lain. Karena itu
test A–L lama tetap hijau tanpa penyesuaian angka.

**Test baru (3):**

| Test | Isi |
|---|---|
| `GUARD-A` | kedua middleware harus masih ada di `rbac.middleware.ts` (gerbang membacanya); kode pada situs any-of nyata (`tenant_company.read`, `handyman.operations.request.read`, `…triage`) terlihat scanner; scanner diuji per-bentuk lewat inline sample supaya penyempitan regex gagal keras, bukan diam-diam |
| `GUARD-B` | nama kode di dalam blok komentar dan komentar baris **tidak** dihitung; hanya panggilan hidup |
| `GUARD-C` | **fixture negatif**: file sintetis di `mkdtempSync(tmpdir())` berisi satu any-of sah + satu any-of fiktif + satu `requirePermission` fiktif → gerbang WAJIB menghasilkan tepat dua kode fiktif itu; assert anti-vakuolum (kedua kode memang tidak ada di katalog) dan assert scan repo tetap bersih; direktori sementara dihapus di `finally` |

**Hasil:** `tests/config-perm-01-permission-registry.test.ts` → **16 PASS, 0 FAIL, 0 SKIP** (13 lama + 3 baru).
`npx tsc --noEmit -p .` → **exit 0**. Tanpa DB, tanpa HTTP (suite ini statis).

**Mutation check (bukti bahwa guard baru bukan hiasan).** Scanner dikembalikan ke bentuk lama
(hanya `requirePermission`) pada salinan temporer, salinan itu dijalankan: **# pass 14, # fail 2**
(GUARD-A dan GUARD-C gagal). Mutan dihapus segera; repo tidak pernah menyimpannya.
Kombinasi guard + fixture + mutasi inilah yang menutup F-01, bukan sekadar test hijau.

---

## 2. Audit read-only identitas PIC (scope 5) — fakta struktural

| Relasi | Fakta di schema/source | Sumber |
|---|---|---|
| PIC ↔ User | `tenant_pics.user_id UUID REFERENCES users(id)` **nullable**; tidak ada CHECK yang memaksa link; tidak ada cascade | `0145_create_tenant_pics.ts:17-33` |
| Keanggotaan tenant | `tenant_pics.tenant_company_id NOT NULL → tenant_companies(id)` | idem |
| Satu primary per tenant | `UNIQUE INDEX tenant_pics_primary_unique ON (tenant_company_id) WHERE is_primary` + `CHECK (NOT is_primary OR status='ACTIVE')` | `0145:31-41` |
| Link user unik per tenant | `UNIQUE INDEX tenant_company_user_unique ON (tenant_company_id, user_id) WHERE user_id IS NOT NULL` | `0145:42-44` |
| Status PIC | `CHECK status IN ('ACTIVE','INACTIVE')` | `0145:29-30` |
| Status User | `CHECK status IN ('ACTIVE','INACTIVE','SUSPENDED')` — **tidak ada konsep "user customer" vs "user staf"** (tanpa `is_linked`/kind column; grep 0 hasil) | `0002_create_users.ts:18-22` |
| Occupancy tenant×building | `tenant_building_contexts(tenant_company_id, building_id, effective_from/to, status)` + `UNIQUE … WHERE status='ACTIVE'` | `0147:18-40` |
| Occupancy unit | `tenant_space_relationships(tenant_company_id, building_id, space_id, effective_from/to, status)` | `0146:18-23` |
| BM handoff → PIC | snapshot exchange membawa `tenantCompanyId`, `tenantPicId` (nullable), `tenantBuildingContextId`, `tenantSpaceRelationshipId`; **"tenant-pics.userId is never fabricated"** | `handoff-runtime.types.ts:59-64`, `handoff-runtime.service.ts:38-46` |
| Provenance request | `handyman_service_requests.tenant_pic_id UUID REFERENCES tenant_pics(id)` **nullable**; `created_by_user_id` **nullable**; `actor_type`/`care_actor_id` (0427) untuk aktor CC — **"never a users/tenant_pics id"** | `0378:40,49`; `0427:38-40` |
| Query "PIC mana yang mewakili User ini?" | **tidak ada helper-nya**: `tenantPicRepository` hanya `create/findById/listByTenantCompany/update`; satu-satunya resolusi `pic.user_id = actor` ada di dalam SQL C6 | `tenant-pic.repository.ts:47-63`; `handyman-service-request.repository.ts:202-206` |
| Index pendukung lookup-by-user | **tidak ada**: semua indeks `tenant_pics` berleading-column `tenant_company_id`. Predicate `WHERE user_id = ?` tidak terlayani indeks | `0145:37-44` |

### 2.1 Readiness matrix (scope 6) — empat kelas yang diminta

Kolom "siapa yang bisa jadi penanda tangan" diukur terhadap ledger hari ini:
`handyman_quotation_decisions.decided_by_user_id UUID NOT NULL REFERENCES users(id)`, `tenant_pic_id UUID` nullable (0394).

| # | Kelas PIC | Struktur mendukung? | Konsekuensi untuk W03 quote approval | Status |
|---|---|---|---|---|
| R1 | **ACTIVE + link User ACTIVE**, tenant building-context ACTIVE & jendela efektif, (space relationship bila request punya `space_id`) | **Ya**, dan inilah satu-satunya kelas yang hari ini lolos predikat C6 **bila** user itu juga memegang `user_building_assignments` aktif (lihat F-05) | Kandidat approver sah; butuh permission decision khusus (Q-D7) + maker-checker (Q-D4). Populasi = **UNVERIFIED** | READY-SECARA-STRUKTUR |
| R2 | **ACTIVE tanpa link User** (`user_id IS NULL`) | Baris PIC ada; `users` tidak | **Tidak bisa menandatangani apa pun**: NOT NULL `decided_by_user_id` menolak. Butuh Q-D1 (sesi terbatas ter-attestasi) **atau** Q-D2(a) discriminator + actor polimorfik; menyalakan jalur "buat User untuk PIC" = keputusan provisioning, bukan coding | BLOCKED-BY-SCHEMA |
| R3 | **PIC revoked** (`status='INACTIVE'`) atau User-nya `INACTIVE/SUSPENDED` | Link bisa tetap ada (tidak ada cascade/CHECK yang membersihkannya) | **Harus ditolak secara runtime**, bukan dipercaya sebagai fakta: resolusi approver wajib menguji `pic.status='ACTIVE' AND users.status='ACTIVE'` pada setiap keputusan, bukan hanya saat tautan dibuat. Idiom pembanding sudah ada: `tenant-communication.service.ts:100-121` (`assertRecipient`) dan `handyman-channel-attribution.service.ts:244-251` (PIC harus ACTIVE + tenant sama) | GAP-YANG-HARUS-DIJAGA |
| R4 | **PIC lintas tenant** (PIC tenant A dipakai untuk request tenant B, termasuk User yang sama) | FK tidak melarang; hanya aplikasi yang bisa menolak | Tolak dengan predikat `pic.tenant_company_id = request.tenant_company_id` (bukan hanya `user_id` match) + jendela occupancy. Preseden persisnya sudah ada di attribution service (`:246`: `requester.tenantCompanyId !== company.id` → tolak). Tanpa ini, satu User yang PIC di dua tenant bisa memutuskan quotasi tenant lain | GAP-YANG-HARUS-DIJAGA |

### 2.2 Temuan F-05 — KOREKSI atas rekomendasi PART 00 §3 (penting, mengubah desain)

PART 00 §3 menyarankan: *"request induk harus terbaca oleh actorUser di bawah dinding C6 yang ada"*.
Audit read-only ini membuktikan saran itu **tidak cukup**:

```
EXISTS (SELECT 1 FROM user_building_assignments uba … WHERE uba.user_id = $actor AND uba.status='ACTIVE'
         AND b.id = r.building_id AND c.id = r.client_id
         AND ( PLATFORM_ADMIN … OR ( PIC … AND occupancy … ) ))
```

Seluruh predikat — **termasuk cabang PIC** — bersarang di dalam `EXISTS (user_building_assignments)`.
Jadi C6 adalah dinding staf: seorang Tenant PIC yang tidak punya assignment Building aktif **tidak**
membaca request-nya sendiri lewat `GET /handyman/requests`. Konsekuensi:

1. Reuse C6 tidak bisa menjadi otoritas approver customer. Yang bisa di-reuse hanyalah **sisi occupancy**
   dari predikat itu (`tenant_building_contexts` + `tenant_space_relationships` + `users/pic.status`),
   sebagai komponen dari predikat baru yang **tidak** menuntut assignment Building.
2. Tidak ada satu pun permukaan baca Handyman yang di-autentikasi sebagai customer hari ini: gerbangnya
   `authenticationMiddleware` + `tenant_company.read|manage`. Komentar kontrak di
   `handyman-api.routes.ts:36-42` menyatakan desain ini secara eksplisit — jalur care memakai
   exchange dari handoff ter-sign dan *"it never borrows the represented PIC's local session"*.
3. Bila W03 memilih memberi PIC permission staf (mis. `tenant_company.read`) agar C6 "jalan", itu adalah
   **overgrant ke arah customer** (permission administratif untuk aksi satu versi). Karena itu F-05
   justru menguatkan Q-D7 (permission khusus) dan Q-D1 (sesi terbatas), bukan melemahkannya.

Status: rekomendasi PART 00 §3 langkah 2 **diganti** oleh F-05. Tidak ada kode yang berubah; PART 00 §3
sudah diberi catatan koreksi silang.

---

## 3. Population measurement: UNVERIFIED (scope 7–8)

Angka populasi (berapa PIC ACTIVE yang punya link User, sebarannya per tenant, rasio primary-without-user)
**tidak diukur dan sengaja tidak diasumsikan**. Yang tersedia di sandbox ini hanyalah DB uji kosong hasil
migrasi fresh; menghitung populasi di atasnya menghasilkan angka 0 yang akan terbaca sebagai "siap", dan
itu bohong. Jadi sesuai aturan: **UNVERIFIED**, tanpa angka.

Query agregat untuk dijalankan di staging/prod (read-only, tanpa satu pun nilai PII keluar — hanya count):

```sql
-- A. kelas R1–R4 dalam satu jalan
SELECT
  count(*) FILTER (WHERE p.user_id IS NOT NULL AND p.status='ACTIVE'  AND u.status='ACTIVE') AS r1_ready,
  count(*) FILTER (WHERE p.user_id IS NULL     AND p.status='ACTIVE')                          AS r2_no_user_link,
  count(*) FILTER (WHERE p.user_id IS NOT NULL AND (p.status<>'ACTIVE' OR u.status<>'ACTIVE' OR u.id IS NULL)) AS r3_revoked,
  count(*) FILTER (WHERE p.status='ACTIVE' AND p.is_primary)                                     AS active_primary_total
FROM tenant_pics p LEFT JOIN users u ON u.id = p.user_id;

-- B. R1 yang juga punya occupancy aktif untuk tenant-nya (syarat minimum predikat F-05)
SELECT count(DISTINCT p.id)
  FROM tenant_pics p
  JOIN users u             ON u.id = p.user_id AND u.status='ACTIVE'
  JOIN tenant_building_contexts tbc ON tbc.tenant_company_id = p.tenant_company_id
                                   AND tbc.status='ACTIVE'
                                   AND (tbc.effective_from IS NULL OR tbc.effective_from <= now())
                                   AND (tbc.effective_until IS NULL OR tbc.effective_until >= now())
 WHERE p.status='ACTIVE';

-- C. R4 eksplisit: User yang jadi PIC ACTIVE di >1 tenant ( Kandidat tabrakan otoritas )
SELECT p.user_id, count(DISTINCT p.tenant_company_id) AS tenants
  FROM tenant_pics p WHERE p.status='ACTIVE' AND p.user_id IS NOT NULL
 GROUP BY p.user_id HAVING count(DISTINCT p.tenant_company_id) > 1;

-- D. berapa banyak quotasi yang hari ini tidak bisa punya penanda tangan sah
SELECT count(*) FILTER (WHERE r.tenant_pic_id IS NULL) AS requests_without_pic, count(*) AS requests_with_quotation
  FROM handyman_quotations q JOIN handyman_service_requests r ON r.id = q.handyman_request_id;

-- E. bukti self-approval yang sudah terjadi (T-01 hari ini)
SELECT count(*) FROM handyman_quotation_decisions d
  JOIN handyman_quotation_versions v ON v.id = d.quotation_version_id
 WHERE d.decided_by_user_id = v.created_by_user_id;
```

Larangan yang dipatuhi: query di atas mengembalikan **aggregate count** saja. Query C mengembalikan
`user_id` (UUID internal) dan harus dijalankan sebagai agregat per-tenant-only (`count(*)`) di laporan
final — jangan pernah menempelkan hasilnya ke dokumen. Tidak ada nama, email, telepon, atau token yang
boleh muncul di laporan readiness. Dokumen ini tidak memuat satu pun nilai PII.

---

## 4. Limited PIC session & amandemen F6 sebagai keputusan arsitektur (scope 9)

Tidak ada dokumen frozen yang diubah di PART ini (`HANDYMAN_BUSINESS_JOURNEY_v1.3_FROZEN.md`,
`CR-HM-06_DECISION_FREEZE.md`, `CR-HM-00_CROSS_REPO_OWNERSHIP_MATRIX.md` semuanya 0 diff).

**Benturan yang harus diselesaikan lewat keputusan, bukan kode:**

| Sumber | Bunyi | Implikasi |
|---|---|---|
| Journey v1.3 `:23` | Tenant/PIC: "Menyetujui quotation… **Tidak login langsung**" | PIC approval tidak boleh jadi akun-password-standalone baru |
| CR-HM-06 F6 | "Actor = authenticated local user with required Client/RBAC authority; caller-supplied customer identity is never authority" | F6 mengasumsikan actor User lokal; mengubah actor = **amandemen F6** |
| Ownership matrix row 1 | "Secure BM Super App Handoff" berstatus **A — BACKEND CONTRACT BLOCKER**; "every customer and field journey binding begins from this trusted context" | jalur identitas customer yang sah adalah handoff BM, bukan sesi baru |
| `handoff-runtime.service.ts:44` | "tenant-pics.userId is never fabricated"; exchange bukan sesi User; tidak ada `users` row yang dibuat | handoff saat ini memberi identitas PIC **tanpa** User → tidak bisa mengisi `decided_by_user_id NOT NULL` |
| 0394 | `decided_by_user_id NOT NULL → users`, `tenant_pic_id` nullable | ledger keputusan hari ini secara struktural tidak bisa mencatat approver non-User |

**Kebutuhan "limited PIC session" yang harus disetujui (bukan keputusan coding):**

1. **Bentuk**: sesi terbatas satu-aksi, ber-attestasi, single-use, TTL pendek — preseden yang sudah ada di
   repo dan sudah teruji: `admitCareWorkspace` + `signCareWorkspaceAssertion` + `handyman_care_workspace_sessions`
   (CR-HM-01), `rfqVendorSessionMiddleware` (vendor RFQ), dan `handyman_arrival_challenges` 0397
   (challenge consumed_at, satu pending per scope). **Jangan** membuat mekanisme keempat; pilih satu dan
   petakan persis ke pola yang ada.
2. **Root of trust**: klaim PIC dari BM handoff (bukan klaim frontend). Bila BM tidak mengirim
   `tenantPicId`, hasil yang benar adalah **ditolak**, bukan ditebak dari User atau dari "PIC primary".
3. **Korespondensi ledger**: identitas approver non-User tidak bisa masuk kolom `NOT NULL → users`. Dua
   opsi bersih: (i) PIC wajib punya tautan `users` dan sesi terbatas hanya *membuktikan* tautan itu
   (skema tidak berubah, tetapi butuh program tautan identitas — bagian dari Q-D8); atau (ii) amendemen
   ledger yang additive: `decision_actor_type TEXT CHECK IN ('USER', 'TENANT_PIC_SESSION')`,
   `decision_actor_reference`, dan syarat `tenant_pic_id NOT NULL` saat actor-type PIC — persis idiom 0427
   (`actor_type` + `care_actor_id`, "never a users/tenant_pics id") yang sudah diterima repo. **Opsi (ii)
   paling konsisten dengan "never fabricate a user", tetapi menyentuh tabel immutable → butuh keputusan
   resmi + migration additive, bukan perubahan diam-diam.**
4. **Amandemen F6 (wajib sebelum coding decision path)**: teks F6 harus diperluas menjadi "actor =
   authenticated local user OR an attested, single-use, bounded Tenant PIC session bound to the exact
   quotation version; caller-supplied customer identity is never authority". Angka F1–F12 lain tidak
   boleh berubah. F7 (lock+idempotency), F8 (scope hanya oleh APPROVE), F11 (bukan BAST/payment) tetap.
5. **Yang tidak boleh dilakukan sebagai jalan pintas**: memberi PIC permission staf (`tenant_company.read`
   /`manage`) supaya C6 "bisa dipakai"; memberi `user_building_assignments` ke customer; memakai
   `tenant-approvals` (BE-14H) sebagai ledger kedua; melonggarkan `assertQuotationThreadBuildingAccess`.

Karena butir 1–5 semuanya keputusan, **W03 PART 02 tidak boleh menulis coding decision path sebelum Q-D1
dan Q-D2 disetujui dan F6 diamendemen.**

---

## 5. Blocker menuju W03 PART 02

| ID | Blocker | Jenis | Dibutuhkan sebelum |
|---|---|---|---|
| **P0-B1** | F-05: tidak ada admission customer; C6 menuntut assignment Building → reuse-C6 batal | Desain (temuan baru) | semua PART decision path |
| **P0-B2** | Q-D1 (bentuk otoritas PIC) + Q-D2 (`decision_authority`) belum disetujui; F6 belum diamendemen | Keputusan arsitektur | PART 02 |
| **P0-B3** | Q-D8: populasi `tenant_pics.user_id` belum diukur (query §3 A/C). Tanpa angka, (i) vs (ii) di §4.3 tidak bisa dipilih | Data | PART 02 |
| **P1-B4** | Lookup `tenant_pics` by `user_id` tanpa indeks (semua indeks leading `tenant_company_id`) | Performa/skema | sebelum predikat PIC dipasang ke jalur baca (butuh migration aditif — keputusan, bukan di PART ini) |
| **P1-B5** | R3/R4 (revoked & lintas tenant) belum punya test runtime apa pun; hari ini hanya predikat C6 dan attribution yang menjaganya | Test | PART 02 |
| **P1-B6** | `Idempotency-Key` global (0394) dan expiry read/write (T-05/T-06) masih terbuka | Keputusan + test | PART 03/04 |
| P2-B7 | T-01 sudah terbukti mungkin (query §3 E menghitung korbannya) tetapi belum ditutup | Kode | PART 02 (maker-checker) |

**Sudah selesai di PART ini:** F-01 tertutup (guard + fixture + mutation), readiness matrix struktural
terdokumentasi, koreksi F-05 masuk register, limited-PIC-session & F6 amendment tercatat sebagai
keputusan arsitektur.

## 6. Yang TIDAK dilakukan (agar tidak terbaca sebagai klaim)

- Tidak mengubah satu file `src/` pun; tidak menambah permission, migration, grant, atau indeks.
- Population measurement: **UNVERIFIED** (bukan "0", bukan "siap").
- Tidak menjalankan full suite. Yang dijalankan hanya `tests/config-perm-01-permission-registry.test.ts`
  (statis, tanpa DB) + `npx tsc --noEmit -p .`.
- Tidak ada klaim frontend, BM Super App, maupun E2E dua sisi.
- Tidak ada PII yang diekspor; hanya agregat dan identitas struktural (nama tabel/kolom/indeks).

## 7. Bukti

| Item | Nilai |
|---|---|
| Suite fokus | `tests/config-perm-01-permission-registry.test.ts` → 16 PASS / 0 FAIL / 0 SKIP |
| Mutation check | scanner any-of dihapus pada salinan → **# fail 2** (GUARD-A, GUARD-C); salinan dihapus |
| Typecheck | `npx tsc --noEmit -p .` exit 0 |
| Diff scope | `tests/config-perm-01-permission-registry.test.ts` + dokumen ini; `src/`, `src/database/`, `docs/api/` = 0 perubahan |
| Frozen docs | `git diff --name-only <HEAD>.. -- docs/e2e/HANDYMAN_BUSINESS_JOURNEY_v1.3_FROZEN.md docs/handyman/CR-HM-06_DECISION_FREEZE.md docs/handyman/CR-HM-00_CROSS_REPO_OWNERSHIP_MATRIX.md` = kosong |
