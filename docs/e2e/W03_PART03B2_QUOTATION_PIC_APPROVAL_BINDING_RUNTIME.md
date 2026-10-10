# W03 PART 03B2 — Runtime binding: modul, tiga route staff, permission khusus, audit

Tanggal: 2026-10-11 (Asia/Jakarta). Branch kerja: `arena/44e8ce22-handyman-backend`.
Kontrak: `docs/handyman/CR-HM-06_ADDENDUM_A_TENANT_PIC_BINDING_AUTHORITY.md` §3.3 (B8–B11),
§3.4 (B12–B17), §4 (B18/B20), §5 (R-1.2), §6 (MC1′/MC3/MC4′), §7.2 (C21–C24), §8, §9;
`docs/handyman/CR-HM-06_AMENDMENT_01_TENANT_PIC_APPROVAL_ACTOR.md` §9 (baris binding) dan §13
(baris 03B2). Record sebelumnya: `docs/e2e/W03_PART03B_QUOTATION_PIC_APPROVAL_SCHEMA.md`
(schema floor 0437–0439, commit `fce6322`).

**Status PART ini: selesai dan terverifikasi fokus. BUKAN PR, BUKAN deploy, BUKAN sertifikasi.**

---

## 1. Baseline yang diverifikasi sebelum menulis apa pun

| Pemeriksaan | Hasil |
|---|---|
| `git log -1` sebelum mulai | `fce6322 W03 PART 03B: quotation PIC approval schema foundation (0437-0439)` |
| `git status --porcelain` sebelum mulai | bersih |
| posisi terhadap `origin/main` | 0 di belakang, 28 di depan; `ANCESTRY_OK` |
| `ls src/database/migrations \| grep -E "^043[7-9]"` | 0437 / 0438 / 0439 ada (dibuat 03B) |
| teks B8–B11, §7.2 C17–C24, §8, §9 ADD-A | dibaca ulang verbatim sebelum implementasi |
| A01 §9 (permukaan route staff/PIC) + §13 baris 03B2 | dibaca ulang verbatim |
| pola yang ditiru sebelum menulis | `handyman-quotations-api.routes.ts` (rantai auth→permission→handler), `handyman-quotation-access.ts:23-41`, `handyman-request-triage.service.ts` (lock → wall → tulis → journal dalam satu transaksi), `handyman-quotation-decision.service.ts` (fingerprint + replay), `request-idempotency` (`executeIdempotent`), `0428` (idiom grant-history tanpa kolom narasi), `0436` (template migrasi permission) |

Jumlah entri di array `migrations` sesudah PART ini: **440** (sebelumnya 439).

---

## 2. Yang diimplementasikan

**Modul baru `src/modules/handyman-quotation-approval-bindings/`** (5 berkas):

| Berkas | Isi |
|---|---|
| `…types.ts` | status ledger (`ACTIVE`/`REVOKED`), status otoritas LIVE (`ACTIVE`/`INACTIVE`/`EXPIRED`/`MISSING`/`NOT_APPLICABLE`), record DB, proyeksi publik, `approvalStatus`, input bind/revoke, hasil tulis. Tidak ada satu pun tipe yang membawa nama/e-mail/telepon PIC |
| `…errors.ts` | envelope penolakan: satu 404 seragam, 403 penyangkalan, 409 pin/beku/linase, 400 window, penerjemah pesan guard (`bindingGuardRefusalError`). **Nol kode error baru** — semuanya anggota `ERROR_CODES` yang sudah ada (MC3) |
| `…repository.ts` | SQL mentah atas `handyman_quotation_approval_bindings` + SELECT baca-basis (linase request, fakta PIC, occupancy, space, liveness tenant/client, `hasIssuedUndecidedVersion`, `hasAnyDecision`). Hanya SATU `INSERT` dan SATU `UPDATE` di seluruh berkas; tidak ada jalur tulis ke tabel keputusan/version (B9 ada di level SQL, bukan hanya niat) |
| `…service.ts` | `bind…`, `revoke…`, `get…` + kunci operasi idempotensi + konstanta permission |
| `…index.ts` | ekspor terbatas; sengaja tidak mengekspor apa pun yang menyentuh jalur keputusan (03C) atau sesi PIC (03B/BLK-2) |

**Tiga route staff** di `handyman-quotations-api.routes.ts` (C22): `POST /handyman/quotations/:quotationId/approval-binding`
(menulis), `POST …/approval-binding/revoke` (membatalkan), `GET …/approval-binding` (membaca). Rantai
tulis: `authenticationMiddleware → requirePermission('tenant_company.manage') →
requirePermission('handyman.quotation.approval.binding.manage')`; rantai baca:
`requirePermission('tenant_company.read')` (C21). Parser body whitelist di
`handyman-quotations-api.validation.ts`; handler tipis di `handyman-quotations-api.controller.ts`.

**Permission khusus + migrasi `0440`.** `handyman.quotation.approval.binding.manage`
("Manage Handyman Quotation Approval Bindings") masuk `FOUNDATION_PERMISSIONS` dan
`UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`; `0440` hanya INSERT katalog
`ON CONFLICT (code) DO NOTHING`, `down()` menghapus baris selama belum di-assign ke role mana pun.
Tidak ada grant, tidak ada role, tidak ada seed yang diubah. Gate registry
`tests/config-perm-01-permission-registry.test.ts` diperbarui pada dua pin-nya (356→357 dan daftar
`EXPECTED_UNASSIGNED_BY_DEFAULT`) — bukan dilonggarkan.

**Audit.** `recordOperationalEvent` pada transaksi yang sama:
`HANDYMAN_QUOTATION_APPROVAL_BOUND` dan `HANDYMAN_QUOTATION_APPROVAL_BINDING_REVOKED`,
`entityType = HANDYMAN_QUOTATION_APPROVAL_BINDING`, metadata berisi id + versi + window + narasi
operator. Kosong saat penolakan (tidak ada baris, tidak ada event, tidak ada klaim idempotensi).

---

## 3. Pemetaan 12 item scope PART 03B2 ke bukti

| # | Item | Bukti |
|---|---|---|
| 1 | modul baru (types, repository, service, errors, index) | §2; tipe/error/repository/service terpisahkan, `index.ts` membatasi permukaan |
| 2 | repository dengan SQL mentah | `…repository.ts`; predikat occupancy/space **disalin dari guard 0437**, bukan parafrase, sehingga pre-check service dan floor DB tidak bisa berbeda kesimpulan |
| 3 | tiga route staff di `handyman-quotations-api.routes.ts` | test 9 membaca berkas route dan menuntut rantai literal `bindingPath, auth, manage, approvalBindingManage, …` untuk kedua POST dan `bindingPath, auth, read, …` untuk GET; test 10 menjalankan HTTP asli |
| 4 | body HANYA `{tenantPicId, effectiveUntil?, note?}` | `parseQuotationApprovalBindingBody`; test 10 menyuntik 10 kunci palsu (`clientId`, `tenantCompanyId`, `buildingId`, `spaceId`, `bindingVersion`, `status`, `supersedesBindingId`, `occupancyAuthorityId`, `spaceAuthorityId`, `grantedByUserId`, `decidedByTenantPicId`) → baris tetap sama persis dengan linase (B11 "structurally ignored", diuji per kolom) |
| 5 | service menegakkan B1–B5, B11, B13, B14, B18, R-1.2, MC1′ | test 1 (B3/B4/B5 snapshot + eligibility), test 2 (B1/B2 uniform), test 3 (B8/BE-02G), test 4 (MC1′ + MC4′), test 5 (B13, B15, B18, R-1.2), test 8 (B14 satu ACTIVE di bawah konkurensi) |
| 6 | revoke dengan body `reason`/`effectiveUntil` sendiri, bukan sekadar idempotensi | test 7: `reason` kosong → 400 (`field: reason` dari validator route, bukan dari service); cutoff di masa depan → 400; cutoff sah → tercatat di jurnal sebagai `statedEffectiveUntil`, kolom `effective_until` baris TIDAK berubah |
| 7 | permission khusus, `UNASSIGNED_BY_DEFAULT` | katalog + seed + `0440` + test 9 (katalog tepat satu, nama tepat, anggota `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`, `schema_migrations` memuat 0440, role `PLATFORM_ADMIN` hasil seed TIDAK memegangnya) + test 3b (holder `tenant_company.manage` saja → 403) |
| 8 | read status + proyeksi `approvalStatus` | `bindingVersion`, `grantedAt`, `effectiveUntil`, `occupancyStatus` + `spaceStatus`, `picStatus`, `pinned`, `frozen`, `eligibleForApproval`, `bindingId`, `tenantPicId`, `bindingStatus`; test 1 membandingkannya dengan baris DB, test 7 dan 8 menguji versi LIVE-nya (B16/B17) |
| 9 | `Idempotency-Key` + floor DB; cek apakah 0437 butuh kolom versi/uniqueness | **Diperiksa: tidak perlu.** Floor yang dibutuhkan binding sudah ada di 0437 (`binding_version` + `…_one_per_version` + `…_one_active` + guard max+1/supersede), dan replay/conflict adalah milik substrat `request_idempotency_records` (`0349`, `executeIdempotent`). Menambah `idempotency_key`/UNIQUE ke 0437 justru dilarang ADD-A M6 / A01 R6 (BLK-7 = migrasi terpisah). Nol perubahan skema di PART ini. Bukti: test 6 (replay body sama → 201 hasil asli + `replayed: true`; body beda → 409 `IDEMPOTENCY_CONFLICT`; bind vs revoke = namespace operasi terpisah; retry key yang sebelumnya gagal → sukses) |
| 10 | audit create/revoke tanpa PII | test 1: satu event, `entityId` = id baris, metadata id-saja, `JSON.stringify` proyeksi+metadata tidak memuat `picName`/`email`/`phone` maupun alamat e-mail fixture; assert informatif bahwa ledger tidak punya kolom `note`/`reason`/`revoked_reason` |
| 11 | jangan ubah skema kecuali ada blocker nyata; test runtime khusus | **nol** migrasi skema; hanya `0440` (katalog permission, bentuk sama seperti `0436`). Suite `tests/handyman-quotation-approval-binding-runtime.test.ts` 10 test, `10 pass / 0 fail` |
| 12 | dokumentasi kontrak API + dependensi deploy | §4 dan §5 di dokumen ini |

---

## 4. Kontrak API (yang dijanjikan runtime PART ini)

Semua path di bawah berada di bawah prefix `/api/v1`. Envelope respons adalah envelope repo
(`sendSuccess` → `{ data }`; error → `{ error: { code, message, details? } }`); tidak ada bentuk baru.

### 4.1 `POST /handyman/quotations/{quotationId}/approval-binding`

- Auth: sesi User lokal. Permission: `tenant_company.manage` **DAN** `handyman.quotation.approval.binding.manage`. Wall tambahan di service: BE-02G assignment ke Building milik thread (`handyman-quotation-access.ts`).
- Header wajib: `Idempotency-Key` (1–200 karakter, tanpa CR/LF/NUL).
- Body: `tenantPicId` (UUID, wajib), `effectiveUntil` (ISO 8601, opsional), `note` (≤500, opsional). Kunci lain diabaikan secara struktural.
- 201 `{ binding, replayed, alreadyBound }`. `alreadyBound: true` = wewenang yang diminta sudah aktif; tidak ada baris baru, tidak ada versi baru (B14).
- `binding` = `{ id, quotationId, handymanRequestId, clientId, tenantCompanyId, buildingId, spaceId, tenantPicId, bindingVersion, supersedesBindingId, status, effectiveFrom, effectiveUntil, authorityEndsAt, grantedByUserId, grantedAt, revokedByUserId, revokedAt, createdAt, updatedAt }` — id dan window saja; tidak ada nama orang.
- Rebind sah: revoke baris ACTIVE lama + INSERT `max+1` yang menamai baris itu di `supersedesBindingId`, satu transaksi. Rebind dengan PIC yang sama dengan baris ACTIVE tidak membuat versi baru.

### 4.2 `POST /handyman/quotations/{quotationId}/approval-binding/revoke`

- Permission dan header sama seperti 4.1 (operasi idempotensi berbeda namespace, jadi kunci yang sama untuk bind dan revoke tidak bertabrakan — diuji).
- Body: `reason` (wajib, ≤500), `effectiveUntil` (opsional). `reason` TIDAK bisa digantikan oleh idempotency key.
- 200 `{ binding, replayed, alreadyRevoked }`; `alreadyRevoked: true` = tidak ada binding ACTIVE, riwayat dibacakan kembali, tidak ada tulis apa pun.
- Aturan cutoff: `effectiveUntil` revoke wajib berada di dalam window yang sudah diberikan (`≥ effective_from`, `≤ NOW()` server). Ia HANYA dicatat di jurnal (`statedEffectiveUntil`) — `revoked_at` tetap DB-derived dan kolom `effective_until` tidak pernah ditulis ulang. Alasan: guard 0437 mengizinkan hanya `status`/`revoked_by_user_id`/`revoked_at`/`updated_at` bergeser (B14), sehingga cutoff dari caller tidak punya tempat sah di ledger; menyimpannya sebagai kolom akan berarti memperlonggar guard yang sudah diratifikasi.
- Revoke tidak menuntut B3/B4/B5 (occupancy/tenant/client hidup) — lihat B2-D5.

### 4.3 `GET /handyman/quotations/{quotationId}/approval-binding`

- Permission: `tenant_company.read` (C21) + BE-02G. Tidak memerlukan permission khusus.
- 200 `{ quotationId, binding | null, approvalStatus, history[] }`; `history` newest-first, maksimum 20 baris, isi = `{ id, bindingVersion, status, tenantPicId, grantedAt, revokedAt }`.
- `approvalStatus` SELALU dihitung ulang saat itu juga: `occupancyStatus` dan `spaceStatus` adalah status LIVE baris authority (bukan salinan snapshot), `picStatus` adalah status LIVE PIC, `pinned` = ada versi ISSUED tanpa keputusan, `frozen` = ada baris keputusan, `eligibleForApproval` = konjungsi B16 (ACTIVE + window menutupi sekarang + occupancy ACTIVE + space ACTIVE/NOT_APPLICABLE + PIC hidup + tidak beku). 03C (C19) wajib memakai makna yang sama; PART ini sengaja tidak mendefinisikan makna kedua.

### 4.4 Envelope error (semua route)

| Status | `error.code` | Kapan |
|---|---|---|
| 400 | `VALIDATION_ERROR` | UUID salah; window tak bisa diparse; `effectiveUntil` bind di masa lalu/sama dengan sekarang; cutoff revoke di luar window; `reason` hilang/terlalu panjang; `note`/`reason` > 500; `Idempotency-Key` hilang/cacat |
| 401 | `AUTHENTICATION_REQUIRED` | tanpa sesi |
| 403 | `PERMISSION_DENIED` | pemegang `tenant_company.manage` tanpa `…binding.manage` (atau sebaliknya); MC1′: PIC yang ditautkan ke granternya sendiri |
| 403 | `BUILDING_ACCESS_DENIED` | caller tidak punya assignment ACTIVE ke Building milik thread (B8/BE-02G); thread tanpa request induk |
| 404 | `HANDYMAN_QUOTATION_NOT_FOUND` | **satu** jawaban seragam untuk: thread tidak ada, PIC tidak ada, PIC tenant lain, PIC non-ACTIVE, occupancy/space basis tidak hidup, tenant/client non-ACTIVE, revoke pada thread yang belum pernah diikat. Ketigabelas menghasilkan byte yang identik (diuji dengan perbandingan JSON) sehingga tidak bisa dipakai memprobe |
| 409 | `CONFLICT` | B13 pin (rebind saat ada versi ISSUED-undecided); R-1.2 (binding menyangkal PIC linase yang sudah di-attest); kalah race di ledger |
| 409 | `HANDYMAN_QUOTATION_DECISION_CONFLICT` | B18 beku: thread sudah punya keputusan (untuk bind maupun revoke) |
| 409 | `IDEMPOTENCY_CONFLICT` | kunci sama, isi berbeda (substrat `request-idempotency`; pesan memuat `operationKey`, tidak memuat respons tersimpan atau fingerprint) |

Tidak ada 500 yang dapat dicapai dari kontrak di atas: `23514` dari guard 0437 diterjemahkan
`bindingGuardRefusalError` ke baris tabel ini (dipakai sebagai floor, bukan sebagai pesan pengguna).

---

## 5. Dependensi deploy dan urutan rilis

1. **Migrasi `0440` wajib berada di sisi DB sebelum aplikasi yang memasang route ini dipakai.**
   Kalau route lebih dulu terpasang dan `0440` belum jalan, permukaannya tetap **gagal tertutup**:
   kode tidak ada di katalog → `resolvePermissionsForUser` tak mungkin mengembalikannya → semua caller
   403 (tidak ada rute yang bocor). Tidak ada mode "setengah terbuka".
2. **Permission tidak boleh di-auto-grant.** Tidak ada perubahan seed/role di PART ini. Pemberian
   `handyman.quotation.approval.binding.manage` adalah tindakan administratif eksplisit lewat
   permukaan role/permission (`role.manage` + `permission.manage`) — sama seperti
   `handyman.operations.request.triage` (W02 PART 04A). Yang berubah kalau admin lalai memberi: route 403,
   ledger tetap kosong, tenant tidak melihat apa pun.
3. **Deploy PART ini dalam keadaan gelap dan itu disengaja.** Tidak ada pembaca/penulis baru di jalur
   keputusan (C17/C19 = 03C), tidak ada B12 issue-gate, tidak ada perubahan `issue/supersede/decide`,
   tidak ada perubahan C6/queue/read wall (C23), tidak ada perubahan konsumen scope hilir (C24).
   Satu-satunya cara baris binding lahir adalah melalui tiga route ini.
4. **Urutan rilis yang mengikat:** 03B (skema, `fce6322`) → **03B2 (PART ini)** → 03C (ledger + guard
   keputusan + `approvalBindingId`) → 03D ∥ 03E → 03F → 03G (OpenAPI) → 03H (sertifikasi).
   Bergantung pada apakah tabel sudah ada saat 03C menambah `approval_binding_id`.
5. **BLK-BIND-BACKFILL (P0 untuk rollout) tetap terbuka dan mengikat urutan ini.** Yang boleh mendarat
   sekarang: tabel, guard, route. Yang TIDAK boleh diaktifkan: B12 gate. Begitu gate itu aktif, setiap
   thread tanpa binding tidak bisa dipresentasikan, dan jumlah populasi yang terdampak masih
   **UNVERIFIED** (BLK-3). PART ini secara sadar tidak menyentuh `issueHandymanQuotationVersion`.
6. **`docs/api/openapi.yaml` tidak diubah** (A01 §13 menugaskannya ke 03G). Konsekuensi yang dicatat
   jujur: runtime kini punya 3 path yang belum dipublikasikan. Sensus `openapi-asset-equipment-closure`
   yang menghitung selisih runtime-vs-docs **sudah merah karena sebab lain** (lihat §7), jadi PART ini
   tidak bisa mengklaim maupun menyangkal pergeseran angka itu — angka +3 adalah konsekuensi analitik
   dari penambahan route, bukan hasil ukur.
7. **Rollback PART ini.** `0440.down()` menghapus baris katalog hanya selama tidak ada role yang
   memegangnya; kalau sudah di-grant, operator harus menarik grant itu lebih dulu (itu memang
   tujuannya: rollback tidak boleh menghapus jejak otoritas diam-diam). Ledger 0437 tidak diutak-atik
   oleh rollback ini, dan tetap mengikuti aturan 03B: berisi = ditolak, forward-fix only.

---

## 6. Deviasi yang dicatat dari teks terbekukan (eksplisit, bukan diam-diam)

| ID | Deviasi | Alasan |
|---|---|---|
| **B2-D1** | PART ini **menambah** permission code, padahal ADD-A B8 menulis "no new permission code in V1" | B8 sendiri yang menandai kode khusus sebagai **deferred hardening** yang harus "pass the registry gate and the catalogue in a code-bearing PART" (BLK-BIND-SCOPE). PART ini adalah PART pembawa kode itu, atas perintah item 7. Arahnya menyempit, bukan melonggar: `tenant_company.manage` (B8) dan BE-02G tetap **wajib bersama** — wall B8 tidak digantikan |
| **B2-D2** | Revoke adalah `POST …/approval-binding/revoke` (200 + body), bukan `DELETE …/approval-binding` (204) seperti baris tabel A01 §9 | Kedua dokumen ratified saling bertentangan; ADD-A §7.2 C22 secara eksplisit menyebut "one new POST (bind) + **one new POST (revoke)** + one new GET", dan item 6 PART ini menuntut body revoke sendiri (`reason`/`effectiveUntil`) yang tidak bisa diangkut DELETE secara andal. Tidak ada route ganda untuk fakta yang sama (dites: tidak ada `router.delete` di permukaan binding). **Dilaporkan ke pemilik dokumen untuk direkonsiliasi di 03G**, tidak diputuskan diam-diam di sini |
| **B2-D3** | `note` dan `reason` hidup di audit journal, bukan sebagai kolom ledger | 0437 (ratified 03B) tidak punya kolom narasi dan 0428 — model yang ditiru tabel ini — juga tidak. Item 10 meminta catatan create/revoke justru **sebagai audit event**; item 11 melarang ubah skema tanpa blocker nyata. `recordOperationalEvent` memang otoritas tunggal untuk ini (CR-BE-AUDIT-01) |
| **B2-D4** | Idempotensi memakai substrat `request-idempotency` (`0349`), bukan kolom `idempotency_key`/UNIQUE baru di 0437 | Pemeriksaan yang diminta item 9: floor versi/uniqueness **sudah ada**; menambah UNIQUE/NOT NULL baru adalah tepat yang dilarang M6/A01 R6, dan BLK-7 adalah migrasi terpisah yang harus diukur sendiri |
| **B2-D5** | Revoke melewati pemeriksaan B3/B4/B5 (occupancy/space/tenant-client hidup); bind tetap menuntutnya | B15 ("safety outranks the pin"): occupancy yang hilang, PIC nonaktif, atau tenant yang disuspend adalah **alasan** revokasi. Menolak revokasi justru saat basisnya mati akan mempertahankan otoritas basi. Yang tetap wajib saat revoke: thread + linase + wall BE-02G caller |
| **B2-D6** | B18 tetap membekukan revoke (409 `HANDYMAN_QUOTATION_DECISION_CONFLICT`), sehingga "revoke selalu boleh" (B15) berlaku sampai bekraknya keputusan | Guard 0437 yang diratifikasi 03B menguji B18 **sebelum** transisi revoke di cabang UPDATE, dan itu memang konsekuensi B18 ("no INSERT and the revoke-only UPDATE alike"). Setelah ada keputusan, revokasi tidak mengubah fakta persetujuan yang tercatat; R-1.1/B18 menuntut riwayatnya tetap terbaca. Dicatat agar tidak disalahpahami sebagai bug B15 |
| **B2-D7** | **B12 issue-gate TIDK diaktifkan**, walau baris 03B2 di A01 §13 mencantumkan "B12 issue gate" dalam scope | BLK-BIND-BACKFILL (P0 untuk rollout) secara eksplisit memblokir "ship order" 03B2 dan melarang menyalakan B12 sebelum kebijakan backfill ada; populasinya UNVERIFIED (BLK-3). Menyalakannya sekarang = standstill presentasi yang dibuat sendiri, bukan kemenangan keamanan. Kriteria masuk dicatat di §8 |
| **B2-D8** | Dua assert di test 03B yang mem-pin "0439 adalah tip array `migrations`" digeneralisasi | `0440` memang menjadi tip baru. Bentuk barunya lebih kuat: 0437→0438→0439→0440 harus **berurutan tanpa sisipan** (invarian M6), dan `migrateDown` kosong-kini mengupas 0440 lebih dulu sehingga bukti `0440.down()` (kode tak ter-assign ikut terhapus, lalu kembali tepat satu baris) justru bertambah. Tidak ada klaim 03B yang dilonggarkan |
| **B2-D9** | `picStatus` pada read dilaporkan `ACTIVE`/`MISSING`, bukan `INACTIVE` untuk PIC milik tenant lain | Read tidak boleh membedakan "PIC tidak ada", "PIC tenant lain", dan "PIC nonaktif" (non-enumeration yang sama seperti 404 tulis). Status `INACTIVE` tetap menjadi jawaban sah untuk baris authority occupancy/space yang hubungannya ditutup |

---

## 7. Bukti perintah

| Perintah | Hasil |
|---|---|
| `npx tsc --noEmit` (script `typecheck` repo, `src/**`) | **bersih**, exit 0 |
| `ASENTRA_USE_EMBEDDED_POSTGRES=true npx tsx --test --test-concurrency=1 tests/handyman-quotation-approval-binding-runtime.test.ts` | `# tests 10 # pass 10 # fail 0 # skipped 0` (PostgreSQL 18.4 embedded, 440 migrasi dari nol, 28.7s) |
| suite 03B: `tests/handyman-quotation-pic-binding-migration.test.ts` | `# tests 13 # pass 13 # fail 0` — **setelah** B2-D8; sebelum generalisasi: 11 pass / 2 fail karena pin tip lama |
| `tests/config-perm-01-permission-registry.test.ts` (gate registry, statis) | `# tests 16 # pass 16 # fail 0` dengan katalog 357 dan daftar unassigned yang memuat kode baru |
| `tests/seeds.test.ts` (DB, seed idempoten) | `# tests 1 # pass 1 # fail 0` — `permissions.rowCount === FOUNDATION_PERMISSIONS.length` dan aritmetika `PLATFORM_ADMIN = katalog − unassigned` tetap benar setelah kode + policy ditambah |
| `tests/cr-be-config-openapi-01-part01-contract.test.ts` + `tests/cr-be-config-openapi-01-part02-contract.test.ts`, `tests/form-instance-execute-permission.test.ts`, `tests/integration-webhook-deliveries-read.test.ts` | 8/0, 11/0, 4/0, 7/0 — **tidak tergeser** oleh kode permission baru |
| DB terukur: `SELECT count(*) FROM schema_migrations` | 440 (0437/0438/0439/0440 terapan semua; test 03B2 Assert eksplisit `= 1` untuk 0440) |
| Controlled standstill 03B, diukur ulang di DB yang sama | `handyman-quotations-api` **7 pass / 3 fail** (kasus 6, 7, 9); `handyman-quotation-decision` **2/8**; `handyman-arrival-results` **0/10** — **identik** dengan §6 record 03B. Route tambahan PART ini tidak menggeser satu pun angka, dan tidak ada fallback yang ditambahkan |
| `tests/openapi-asset-equipment-closure.test.ts` | 12 pass / 2 fail — **sudah merah sebelum PART ini** dan gagal di assertion `operationalOpenApi.length` (1761 ≠ 1285) serta pengecualian `/assets/{assetId}/failures`, keduanya hanya menyentuh `docs/api/openapi.yaml` yang tidak PART ini ubah. Sensus runtime-vs-docs tidak tercapai, jadi ia tidak bisa jadi bukti dua arah |
| `tests/attendance-contract.test.ts` | 6 pass / 1 fail — merah karena duplikasi facade `/mobile/material-requests` (CR field material), tidak terkait PART ini |
| `tests/r08-part01b…` / `r08-part02b…` (`migrations.length === 348`) | tetap merah diwarisi (dicatat 03B juga); PART ini menambah satu entri (439→440) dan tidak mencoba "menyetel" angka CR lain |
| `git status --porcelain` saat menyerahkan | 3 jalur baru (modul, `0440`, test runtime) + 3 berkas `handyman-quotations-api` + 2 test + seed + index migrasi = 10 jalur. Tidak ada perubahan `package.json`, `docs/api/**`, `tests/helpers/**`, `handyman-quotations/**`, atau jalur lifecycle/decision |

---

## 8. Yang secara sadar TIDAK dikerjakan di PART ini

- **B12 gate di `issueHandymanQuotationVersion`** (C17) — tertahan BLK-BIND-BACKFILL/BLK-3 (B2-D7). Kriteria masuk: (a) keputusan kebijakan backfill dari Product owner + Operations + release manager, (b) angka agregat `handyman_quotations × handyman_service_requests.tenant_pic_id` terukur lewat jalur BLK-3, (c) urutan enable per-tenant atau per-klien ditetapkan. Setelah itu C17 + C18 adalah satu commit kecil di file lifecycle saja.
- **Perubahan ledger keputusan** (C19/C20: resolve + re-verify binding, snapshot `approval_binding_id`, proyeksi read-only) — milik 03C. PART ini sengaja tidak menyentuh `handyman-quotation-decision.*` sama sekali.
- **Permukaan PIC/portal** (read binding lewat jalur PIC, sesi, decide) — 03D/03E. Route yang ada di sini semuanya **staff**.
- **Revoke cascade berbasis trigger** (M5) — 03B/BLK-2; dan memang bukan tempatnya: binding adalah fakta historis, bukan kredensial.
- **`docs/api/openapi.yaml`, `Deprecation` di route staff, `X-Request-ID` contract baru** — 03G/03E.
- **Perluasan guard 0437/0438** (mis. mengizinkan `revoked_reason` atau cutoff di ledger) — tidak dilakukan; kalau suatu saat diperlukan, itu perubahan kontrak terpisah yang harus diratifikasi, bukan konsekuensi diam-diam dari sebuah route.
- **Menjalankan seluruh suite repo** — di luar instruksi PART ini; yang dijalankan adalah daftar fokus di §7.

## 9. Blocker yang masih menunggu keputusan manusia

| ID | Status setelah PART ini |
|---|---|
| BLK-BIND-SCOPE (P1) | **Terjawab oleh implementasi** — kode khusus ada, `UNASSIGNED_BY_DEFAULT`, dan ia **menambah** wall B8 bukan menggantikannya. Penutupan formal tetap di tangan Product owner + Security (dokumen kontrak belum menyebut kode ini; 03G mempublikasikannya) |
| BLK-BIND-BACKFILL (P0 rollout) | **Tetap terbuka dan mengikat** — memblokir aktivasi B12 (B2-D7), bukan mendaratnya tabel/guard/route |
| BLK-GAP-1 (P0) | Tidak berubah; tetap memblokir 03E saja |
| BLK-2 (sesi PIC), BLK-3 (ukuran populasi staging) | Tidak berubah; BLK-3 adalah gerbang masuk B12 |
| BLK-7 (idempotensi global) | **Sengaja tidak disentuh** — PART ini memakai substrat `0349` yang sudah ada; tidak ada UNIQUE/NOT NULL baru (M6/A01 R6) |
| BLK-CARE-BIND, BLK-ISSUER, BLK-4, BLK-8, BLK-9 | Tidak berubah, tidak diperlebar |
| Baru: **inkonsistensi A01 §9 vs ADD-A §7.2 C22 pada metode revoke** | Untuk pemilik dokumen; keputusan implementasi ada di B2-D2 dan wajib direkonsiliasi saat 03G mempublikasikan path |

## 10. Pernyataan integritas

Tidak ada angka populasi yang diklaim di dokumen ini; yang terukur disebut terukur (§7) dan yang
analitik diberi label analitik di ayat 6 §5. Tidak ada test yang dilonggarkan untuk mengakomodasi
implementasi: satu-satunya test pihak lain yang saya ubah adalah dua assert tip migrasi 03B (B2-D8,
diganti bentuk yang lebih ketat) dan dua pin daftar permission di gate registry (konsekuensi wajib
saat sebuah part sah menambah kode). Controlled standstill 03B dilaporkan utuh dan diukur ulang, tidak
ditambal. Tidak ada jalur tulis lain ke ledger binding selain service ini; tidak ada satu pun perubahan
yang membuat keputusan bisa ditulis dari permukaan staff. Tidak ada PR, tidak ada deploy, tidak ada
perubahan `main` — commit ini ada di `arena/44e8ce22-handyman-backend`.
