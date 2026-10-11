# W03 PART 03D — Bacaan portal PIC yang terbatasi: otoritas datang dari kredensial, bukan dari grant staf

**Status:** IMPLEMENTED + VALIDATED (lihat §7). Tidak ada deploy, tidak ada PR.
**Parent authority:** `CR-HM-06_AMENDMENT_01_TENANT_PIC_APPROVAL_ACTOR.md` (`CR-HM-06/A01` v1.1, RATIFIED) — §9 (route contract PIC), §12 BLK-9 (PIC read surface scope), §13 baris **03D**.
**Addendum:** `CR-HM-06_ADDENDUM_A_TENANT_PIC_BINDING_AUTHORITY.md` — B1–B5 (kelayakan pengikatan), B7 (tidak ada gerbang status-permintaan), B12 (OFF di PART ini), B13–B18 (pin/revoke/pembekuan), C22.
**Freeze:** `CR-HM-06_DECISION_FREEZE.md` F6 v1.1 — teks normatif tidak diubah dokumen ini.
**Branch:** `arena/44e8ce22-handyman-backend`, base sha `9602991c`; commit masuk = commit terakhir di cabang ini.

---

## 1. Baseline yang diverifikasi sebelum menulis apa pun

| Cek | Hasil |
|---|---|
| `git rev-parse --short HEAD` sebelum kerja | `a5e5361` (03C) — kerja 03D di atasnya, bukan di tempat lain |
| `git status --porcelain` | bersih sebelum PART ini; hanya file milik 03D yang berubah setelahnya |
| Teks beku F6 v1.1 + Addendum A | dibaca ulang, tidak disunting (§12 A01 hanya menambah pointer BLK-9; lihat §11) |
| `npx tsc --noEmit` | exit 0 |
| Migrasi baru untuk 03D | **tidak ada**. 0441/0442 (03C) sudah menyediakan kredensial + kolom sesi di ledger; 0437–0440 (03B/03B2) sudah menyediakan tabel binding dan guard-nya. Sebuah bacaan tidak boleh memindahkan lantai DB |
| Permintaan kode izin baru | **tidak ada**. Item 5 melarang `tenant_company.read/manage`; kalau 03D menambahkan kode izin sendiri, artinya ia diam-diam kembali ke jalur staf |

Rekon struktural yang menentukan bentuk PART ini:

- `PicWorkspacePrincipal` 03C **tidak** membawa `clientId` (aturan 10). Karena itu `clients` dijangkau lewat `tenant_companies.client_id`, bukan dari klaim pemanggil.
- Semua layanan baca staf saat ini mengalir lewat satu gerbang (`assertQuotationThreadBuildingAccess`), dan `user_building_assignments` adalah predikatnya. 03D **tidak boleh** memakai gerbang itu (item 5), jadi 03D punya predikat sendiri; akibatnya 03D juga tidak boleh menggemukkannya jadi jalur baru bagi staf.
- Tidak ada satu pun `GET /handyman/pic/*` sebelum PART ini: 03C hanya punya `POST /handyman/pic/session`, `GET|DELETE /handyman/pic/session/current`. Jadi 03D membuka permukaan baca pertama, bukan memangkas yang lama.
- `handyman-quotation-lifecycle.service.ts` tidak punya gerbang B12/binding (dikonfirmasi dengan grep). Justru itu rails yang benar: B12 masih OFF, maka terbit tanpa binding itu sah, dan `NO_ACTIVE_APPROVAL_BINDING` benar-benar tercapai dalam tes.

## 2. Yang diimplementasikan

Lima file baru di `src/modules/handyman-pic-portal/`, satu router yang dipasang di `src/routes/index.ts` tepat sesudah `createPicWorkspaceRouter()`:

- **`pic-portal.types.ts`** — 12 kode alasan + pesan tetap tanpa identifier, dan `evaluatePicApprovalEligibility`: fungsi murni, tanpa DB, tanpa `Date.now()` (jam masuk sebagai argumen). Semua proyeksi publik (`PublicPicPortal*`) didefinisikan di sini supaya "bidang apa yang ada di wire" punya satu rumah.
- **`pic-portal.repository.ts`** — satu-satunya tempat portal memutuskan **visibilitas**. `findRequestForCredential` (sempit ke tenant + building + `(spaceId IS NULL OR r.space_id = $n)`), `findPresentedVersion` (`status='ISSUED'`, `FOR SHARE OF v`), `findVersionForCredential` (versi → quotation → request dalam SATU statement dengan predikat yang sama, supaya id versi milik orang lain gagal di query yang sama seperti id yang tidak ada), `findDecisionByVersion`, `findCurrentOccupancyStatus` → `ACTIVE|INACTIVE|EXPIRED|MISSING`, dihitung ulang dari (tenant, building) + `clock_timestamp()`, **bukan** dari `occupancy_authority_id` yang tersimpan di baris.
- **`pic-portal.service.ts`** — `loadThreadContext` dipakai oleh bacaan mana pun, jadi kedua bacaan tidak bisa saling bertentangan: request → quotation → versi ISSUED → decision → `findActiveBinding` → fakta PIC/tenant/client → satu `clock_timestamp()` untuk seluruh perhitungan window. `readPicPortalOwnDecision` hanya mengembalikan baris bila `decided_by_tenant_pic_id === principal.tenantPicId`.
- **`pic-portal.routes.ts` + `index.ts`** — tiga GET, `Cache-Control: no-store`, dan auth **hanya** lewat `readPicWorkspaceBearer(req.header('authorization'), req.query, req.body)`: tanpa `authenticationMiddleware`, tanpa `requirePermission`, dan keberadaan body/query pada GET adalah 400, bukan pengenduran scope (aturan 13).

Dua keputusan bentuk yang perlu disebut karena akan ditagih di 03E/03G:

1. **404, bukan 403.** Setiap sumber yang tidak boleh diketahui PIC dijawab `HANDYMAN_PIC_WORKSPACE_RESOURCE_NOT_FOUND` dengan pesan seragam (`Resource not found for this PIC session.`) — helper 03C, bukan string baru. Id yang tidak ada, id milik penyewa lain, bangunan lain milik penyewa yang sama, Space di luar klaim kredensial, dan keputusan PIC lain **sama persis**. Autentikasi tetap lebih dulu: kredensial mati → 401 bahkan untuk id asing (401 dan 404 tidak boleh tertukar).
2. **Kelayakan adalah bacaan, bukan janji.** `guaranteesDecision` adalah literal `false` di skema (bukan default), dan setelah kunci baris diambil, sesi + kelayakan diperiksa ulang di transaksi yang sama (`withPicWorkspaceSession` = verify → work → re-verify). Sebuah bacaan yang menunggu lock bisa kedaluwarsa di tengah jalan dan menjawab 401; itu perilaku yang diinginkan, bukan race yang harus "diperbaiki".

## 3. Pemetaan 13 item scope ke bukti

| # | Item scope | Di mana | Bukti di tes |
|---|---|---|---|
| 1 | Verifikasi HEAD/cabang/pohon + beku F6 v1.1/Addendum A | §1 | — (dokumen ini) |
| 2 | Pakai ulang middleware sesi PIC 03C | `pic-portal.routes.ts`, `withPicWorkspaceSession` | blok C: `loses all three reads at once when the session is revoked`, `expires against the database clock, including while blocked on a lock` |
| 3 | Endpoint baca quotation ISSUED yang memang wewenangnya | 3 GET (`pic-portal.routes.ts`) | `ships exactly three GETs, no mutation, and no decide path` |
| 4 | PIC, tenant, request, thread, binding aktif, versi, occupancy diselesaikan server-side | `pic-portal.repository.ts`, `loadThreadContext` | blok A/B; `honours a space-narrowed credential and a space-free one differently` |
| 5 | Bukan `tenant_company.read/manage`, bukan assignment bangunan staf | tidak ada satu pun referensi; grep statis | `references neither the staff building predicate nor any tenant grant (no-C6-reuse)` |
| 6 | Kelayakan approval read-only + alasan non-sensitif saat belum ada keputusan | `evaluatePicApprovalEligibility`, `PicPortalEligibilityReason` | blok D + blok E (tabel murni 12 kode, pesan tanpa UUID/ kontak / nominal) |
| 7 | Validasi sesi ACTIVE, kedaluwarsa, revoke, binding ACTIVE, expiry quotation, maker-checker | repositors + evaluator | `reports a missing binding, a revoked binding and a lapsed window`, `reports an expired presentation and a recorded decision`, `sees a maker-checker conflict that the ledger would refuse (MC1′)` |
| 8 | Re-check sesi + kelayakan setelah lock; bacaan jangan disajikan sebagai jaminan | `withPicWorkspaceSession`; `guaranteesDecision: false` | `expires against the database clock, including while blocked on a lock`, `refuses to be a lease: no write, no state, second call answers again` |
| 9 | 404 seragam, non-enumerating | `picWorkspaceResourceNotFound()` | `cannot tell another tenant's thread from one that does not exist` (bandingkan byte envelope, korelasi id dikecualikan) |
| 10 | Tanpa metadata staf, tanpa audit internal, tanpa quotation penyewa lain | proyeksi kunci tetap | `returns the thread, the presented version, its lines and derived totals` (21 nama terlarang + token `hpw_` absent), `keeps the ledger and Execution Scope untouched by the read` |
| 11 | Tes negatif: lintas-tenant, lintas-building, PIC salah, sesi revoked, binding kedaluwarsa, ketidakcocokan identitas | blok B/C/D | nama tes sesuai; `R-1.2` juga diuji di sisi tulis (write-nya memang ditolak DB) |
| 12 | Typecheck terpisah untuk tes baru, tanpa melebarkan cakupan tsconfig produksi | `tsconfig.tests.json` + `npm run typecheck:tests` + `tests/types/embedded-postgres.d.ts` | §7 |
| 13 | Dokumentasi API + kebutuhan frontend BM Super App | `docs/api/openapi.yaml` (§4), §5 dokumen ini | — |

## 4. Kontrak API

Tiga path baru, `security: picWorkspaceSession` (skema 03C dipakai ulang, tidak diduplikasi), semuanya `GET`, semuanya `no-store`:

| Method + path | operationId | Isi |
|---|---|---|
| `GET /handyman/pic/requests/{handymanRequestId}` | `readPicPortalQuotation` | fakta thread; `quotation.presentedVersion` (versi ISSUED saja: `versionNumber`, `status`, `validUntil`, `lines[]`, `totals`); `decision` atau `null`; `approvalBinding` (ACTIVE saja) atau `null`; `session{sessionId,canDecide,expiresAt}` |
| `GET /handyman/pic/requests/{handymanRequestId}/approval-eligibility` | `readPicPortalApprovalEligibility` | `eligible`, `reasons[{code,message}]`, `evaluatedAt`, `guaranteesDecision:false`, `lineageMatchesCaller`, `canDecide`, `decisionRecorded`, `binding{window}` |
| `GET /handyman/pic/quotation-versions/{quotationVersionId}/decision` | `readPicPortalOwnDecision` | keputusan **milik penandatangan**: `decision`, `decisionActorType`, `decidedByTenantPicId`, `decidedByPicSessionId`, `approvalBindingId`, `decidedAt`, `decidedByCaller` |

Kode error: 400 `VALIDATION_ERROR` (uuid rusak, atau query/body di GET) · 401 `HANDYMAN_PIC_WORKSPACE_UNAUTHORIZED` · 404 `HANDYMAN_PIC_WORKSPACE_RESOURCE_NOT_FOUND` · 500 tanpa klaim state.

Skema baru: `PicPortalQuotationRead`, `PicPortalVersion`, `PicPortalLine`, `PicPortalTotals`, `PicPortalBinding`, `PicPortalDecision`, `PicPortalApprovalEligibility`, `PicPortalEligibilityReason`, `PicPortalEligibilityCode` (enum + `x-code-meanings`). Semuanya `additionalProperties: false`.

Dua belas kode alasan, urutan tetap (kredensial → binding → lineage → master data → state versi → maker-checker):

| Kode | Arti bagi PIC | Yang bisa dilakukannya |
|---|---|---|
| `SESSION_READ_ONLY` | kredensial ini tidak membawa identitas PIC | minta admission ulang dengan `tenantPicId` (03C) |
| `NO_ACTIVE_APPROVAL_BINDING` | tidak ada pengikatan ACTIVE di thread ini | minta binding ke staf (ADD-A B8/B12) |
| `BINDING_WINDOW_LAPSED` | binding ada, tapi window-nya tidak mencakup sekarang | minta perpanjangan/binding baru |
| `BINDING_TARGET_DIFFERS` | binding menyasar PIC lain di penyewa yang sama | jangan pakai jalur ini; PIC lain yang memutuskan |
| `LINEAGE_PIC_DIFFERS` | lineage thread menyebut PIC lain | minta koreksi lineage/binding |
| `TENANT_OR_CLIENT_NOT_ACTIVE` | tenant company atau client-nya non-ACTIVE | hubungi staf (bukan kewenangan PIC) |
| `OCCUPANCY_NOT_CURRENT` | okupansi tenant-building tidak lagi mencakup sekarang | minta perpanjangan okupansi |
| `VERSION_NOT_ISSUED` | belum ada versi ISSUED yang dipresentasikan | tunggu presentasi |
| `VERSION_VALID_UNTIL_MISSING` | versi tanpa `validUntil` — ledger akan menolak | staf memperbaiki datanya |
| `VERSION_EXPIRED` | `validUntil` sudah lewat | minta versi baru |
| `ALREADY_DECIDED` | sudah ada keputusan; thread beku (B18) | baca struknya di jalur own-decision |
| `MAKER_CHECKER_CONFLICT` | pemanggil (via user tertaut) menulis root/versi atau memberi binding | PIC lain yang memutuskan (MC1′) |

Pesan tiap kode adalah konstanta, bukan interpolasi: tidak ada id, nama, email, atau nominal di dalamnya (diuji di blok E).

## 5. Kebutuhan frontend BM Super App

Yang harus dilakukan FE, berurutan:

1. Mint sesi lewat `POST /handyman/pic/session` (jalur server-to-server BM; rahasia integrasi tidak pernah menyentuh browser), simpan token hanya di memori, pakai sebagai `Authorization: Bearer` untuk ketiga bacaan ini. **Jangan** menaruh token di URL/query/fragment/referrer (03C rule 1).
2. Render thread dari `readPicPortalQuotation`. `quotation: null` atau `presentedVersion: null` adalah **keadaan sah** ("belum ada"), bukan error — FE tidak boleh menampilkan "akses ditolak" untuk itu.
3. Countdown dan kesiapan tombol diambil dari `session.expiresAt` + `session.canDecide`. `canDecide: false` → jangan tampilkan aksi apa pun; itu sesi read-capable.
4. Status kelayakan diambil dari `approval-eligibility` **tegas sebelum** aksi, dan di-refresh setiap kali jendela fokus berubah; tidak boleh di-cache (server mengirim `no-store`; FE harus menghormati itu dan tidak menyimpan `evaluatedAt` sebagai fakta hidup).
5. `eligible: true` **tidak** berarti keputusan akan diterima. Teks UI harus menyatakan "saat ini tampak bisa" — bukan "disetujui" / "dijamin". Setelah user menekan tombol (di 03E), hasil keputusan adalah satu-satunya otoritas.
6. `404` berarti "bukan milikmu, atau tidak ada" — dan **harus** ditampilkan identik untuk dua hal itu. Jangan pernah membuat affordance "minta akses" dari 404: affordance itu akan mengubah endpoint baca jadi oracle enumerasi tenant.
7. `401` berarti kredensial mati — refresh sesi (admission ulang), lalu ulangi bacaan. Jangan pernah fallback ke sesi staf / cookie login FE untuk menutupi 401; tidak ada jalur itu di backend, dan percobaan lewat sesi staf adalah bug keamanan, bukan degradasi.
8. `400` untuk query/body di GET berarti FE salah memanggil; jangan pernah mengutus `tenantCompanyId`/`buildingId`/`spaceId` dari sisi klien — server menolak, dan memang itu tujuannya (aturan 13).
9. UI angka: `totals` dihitung server; FE boleh menghitung ulang sebagai pemeriksaan, tapi tidak boleh mengunggahnya balik. `lineTotal = quantity × finalQuotedUnitAmount` adalah satu-satunya aritmetika yang dijanjikan; `referenceUnitAmount` dan `sourceItemId` **tidak akan pernah** ada di respons ini.
10. Tombol APPROVE/REJECT **tidak boleh** dirilis terhadap permukaan ini. Tidak ada endpoint decide di 03D; menulis satu sekarang berarti menabrak B12 yang masih OFF dan jalur keputusan staf yang masih ditolak ledger.

Yang dijamin tidak pernah muncul di respons 03D (ditegakkan oleh tes, bukan oleh kebijakan lisan): `requestFingerprint`, `idempotencyKey`, `createdByUserId`, `decidedByUserId`, `referenceUnitAmount`, `sourceItemId`, `originChannel`/`originReference`/`channelAttributionId`, `occupancyAuthorityId`, `spaceAuthorityId`, `supersedesBindingId`, revoked-by/revocation reason, `picName`/email/phone, riwayat revisi quotation, isi buku audit internal, baris `user_sessions`, dan token/`token_hash` itu sendiri.

## 6. Dependensi rollout (urutan, bukan anjuran)

1. 03D bisa dirilis tanpa UI apa pun: permukaannya baca-saja dan tidak mengubah jalur mana pun yang ada.
2. Sementara **B12 OFF**, mayoritas thread nyata akan menjawab `NO_ACTIVE_APPROVAL_BINDING` — itu **hasil yang benar**, dan FE harus bisa menampilkannya tanpa membuat seolah-olah backend rusak.
3. Nyalanya B12 (presentasi mensyaratkan binding aktif) adalah keputusan 03E/03F, bukan konsekuensi 03D.
4. FE BM Super App boleh mulai membangun terhadap kontrak ini setelah 03G (eksposur OpenAPI W-series) atau sekarang lewat dokumen ini — tapi tombol keputusan tetap mati sampai 03E.
5. Jalur baca staf tidak berubah sama sekali; tidak ada satu pun konsumen lama yang dipaksa bermigrasi oleh PART ini.

## 7. Bukti perintah

Semua dijalankan di sandbox ini; yang tidak dijalankan, atau yang merah sejak baseline, ditandai apa adanya.

| Perintah | Hasil |
|---|---|
| `npx tsc --noEmit` (produksi) | **exit 0** |
| `npm run typecheck:tests` (`tsc -p tsconfig.tests.json`) | **exit 0** — 4 suite milik program (03B, 03B2, 03C, 03D) + shim |
| `ASSENTRA_USE_EMBEDDED_POSTGRES=true npx tsx --test tests/handyman-pic-portal-read.test.ts` | **25 tes / 25 pass / 0 fail / 0 skip**, ±83 detik pada embedded PostgreSQL 55561 |
| `npx tsx --test tests/handyman-pic-workspace-session.test.ts` (03C) | 25/25 pass |
| `npx tsx --test tests/handyman-quotation-pic-binding-migration.test.ts` (03B) | 14/14 pass |
| `npx tsx --test tests/handyman-quotation-approval-binding-runtime.test.ts` (03B2) | 10/10 pass |
| `npx tsx --test tests/openapi-operational-structural-closure.test.ts tests/openapi-tenant-commercial-closure.test.ts` | 19 tes / 15 pass / **4 fail = BASELINE-FAIL** — angka yang sama persis dengan `docs/api/openapi.yaml` di `HEAD` (sudah diverifikasi dengan menukar file lama, menjalankan ulang, lalu mengembalikan). Perbaikan census milik program INT-LC-19-BE/CR-BE-CONFIG, bukan 03D, dan tidak kita kerjakan diam-diam |
| `node -e "require('yaml').parse(...)"` atas `openapi.yaml` | parse OK; 1358 path, 2057 schema; 3 path + 9 schema 03D hadir; **2377 `$ref` diperiksa, tidak ada yang menggantung** |
| `handyman-quotation-decision` (suite ledger CR-HM-06 06) | 10 tes / 2 pass / **8 fail = BASELINE-FAIL yang sudah tercatat** — controlled standstill: guard DB menolak approval staf, dan suite lama itu masih mengharapkan 200. Dijalankan terhadap PostgreSQL hidup (embedded, port 55562) supaya tidak ter-skip; **bukan** PASS dan tidak dibuat PASS |
| `handyman-quotations-api` (suite permukaan CR-HM-06 07A) | 10 tes / **7 pass / 3 fail = sama persis dengan baseline** (test 6/7/9, kelas standstill yang sama; 500 `INTERNAL_SERVER_ERROR` di jalur APPROVE/REJECT staf). Sempat menjadi 6/4 karena sensus path `/handyman/**quotation**` ikut menghitung path decision PIC yang baru — lihat deviasi **03D-D6**; setelah cakupan sensus dippersempit ke permukaan staf, hasilnya kembali 7/3 (dijalankan ulang, angka di kanan ini adalah hasil setelah perbaikan) |
| `handyman-quotation-lifecycle` | **10/10 pass** pada DB hidup — jalur penerbitan versi tidak berubah sama sekali |
| census `openapi-saas-route-parity`, `openapi-contract`, `mobile-openapi-completeness` | tidak dijalankan di PART ini; angka yang dikutip di catatan baseline berasal dari run PART sebelumnya, dan ditandai sebagai milik baseline |

Rekaman baseline-merah (tidak pernah disebut PASS): `openapi-contract` 5 pass/1 fail · `mobile-openapi-completeness` 3 pass/2 fail · `openapi-operational-structural-closure` + `openapi-tenant-commercial-closure` 15 pass/4 fail (diulang di PART ini, hasil identik sebelum dan sesudah perubahan yaml) · `handyman-quotation-decision` 2/8 · tiga tes permukaan staf 07A (6/7/9) · suite ujung-migrasi `fx02-part02…:482`, `r08-part01b:488`, `r08-part02b:676`. Typecheck dengan cakupan `tests/**` seluruh repo = **2078 error pre-existing**; karena itu `tsconfig.tests.json` sengaja diskop ke file milik program (item 12) dan bukan dilebarkan lalu dibiarkan merah.

Catatan harness (penting bagi PART berikutnya, dan sesuai arahan "perbaiki harness-mu sendiri"):

- Sandbox ini **membuang variabel berawalan `ASENTRA_` saat exec**, sehingga `ASSENTRA_USE_EMBEDDED_POSTGRES=true` tidak pernah sampai ke proses tes dan seluruh suite ter-skip dalam 4 detik. Solusi yang dipakai: `NODE_OPTIONS="--require /tmp/embedded-flag.cjs"` yang mengeset `process.env` sebelum modul tes dimuat. Kalau suite 03D terlihat "hijau" kurang dari 30 detik, itu skip — bukan hasil.
- `stableJson` (canonicalization tanda tangan 03C) merender key bernilai `undefined` sebagai `null`, sementara `JSON.stringify` di wire membuangnya. Tanda tangan jadi cover body yang salah kirim → 401. Karena itu helper `admit()` mem-*prune* klaim yang hendak ditarik, bukan mengesetnya `undefined`.

## 8. Deviasi yang dicatat dari teks terbekukan (eksplisit, bukan diam-diam)
- **03D-D1** — A01 §13 baris 03D menyebut dua permukaan (`GET /handyman/pic/requests/:id` + own decision). Yang dikirim **tiga**: `approval-eligibility` ditambahkan sebagai bacaan terpisah, dan **owner telah meratifikasi** pilihan ini lewat direktif eksplisit pada 2026-10-11 (lihat §10). Alternatifnya — menyembunyikan kelayakan di dalam payload baca thread — ditolak karena akan membuat satu respons membawa dua umur evaluasi yang berbeda.

- **03D-D2** — PIC `INACTIVE`, tenant non-ACTIVE, atau perubahan user-link **tidak pernah** muncul sebagai kode alasan di 03D: 03C mencabut kredensialnya lebih dulu, jadi jawabannya 401. `TENANT_OR_CLIENT_NOT_ACTIVE`/`OCCUPANCY_NOT_CURRENT` tetap ada karena keadaan itu tidak mer revoke sesi (itu aturan okupansi/master data, bukan aturan kredensial). Ini fail-closed, bukan pelaporan — diuji, didokumentasikan, dan tidak "diperbaiki" dengan membaca lebih dulu.

- **03D-D3** — Untuk kredensial read-capable, perbandingan yang memakai identitas PIC (`BINDING_TARGET_DIFFERS`, `LINEAGE_PIC_DIFFERS`, `MAKER_CHECKER_CONFLICT`) **dilewati**; alasannya `SESSION_READ_ONLY` saja. Membandingkan binding dengan `NULL` lalu menyebutnya "berbeda" adalah kebocoran perbandingan yang tidak bisa ditafsirkan klien, dan menyesatkan.

- **03D-D4** — Item 12 dipenuhi dengan gate baru (`tsconfig.tests.json` + `typecheck:tests`) **dan** shim `tests/types/embedded-postgres.d.ts`. `tsconfig.json` produksi tetap `exclude: ["tests"]`, tidak diturunkan sedikit pun.

- **03D-D5** — `approvalBinding.grantedByUserId` (id staf pemberi) **ada** di payload thread. Alasannya: PIC harus bisa menunjuk orang yang benar untuk ditanya. Yang tidak dijangankan dan karena itu tidak dikirim: nama, email, role, atau siapa pun selain pemberi dari binding yang menyasar PIC ini.

- **03D-D6** — Sensus API quotation milik CR-HM-06 PART 07A (`tests/handyman-quotations-api.test.ts`) menghitung path `/handyman/**quotation**` dan mengunci angka 10. Path decision PIC yang baru menambah satu, sehingga sensus itu dipersempit ke **permukaan staf** (`!p.startsWith('/handyman/pic/')`) — bukan dengan mengempiskan angka, dan bukan dengan menghapus path dari kontrak. `missing path`, `operationId`, dan jumlah operasi per path di tes itu tetap mengikat persis seperti saat 07A tersertifikasi; census rute PIC dimiliki 03D sendiri. Ini satu-satunya tes milik program lain yang disentuh 03D, dan hanya untuk cakupan sensusnya.

## 9. Yang secara sadar TIDAK dikerjakan di PART ini

- Tidak ada `POST …/approve`, `…/reject`, atau mutation apa pun. Tidak ada jalur decide dalam bentuk apa pun.
- **B12 tetap OFF**; jalur keputusan staf tetap ditolak ledger (ada tes yang membuktikan penolakan itu masih ada, supaya 03D tidak disalahbaca sebagai cutover).
- Tidak ada perubahan pada ledger keputusan quotation, tidak ada perubahan Execution Scope, tidak ada perluasan C6, tidak ada kolom/tabel/migrasi baru.
- Tidak ada perluasan hak akses staf ke data PIC, dan tidak ada pemindahan "pintu staf" ke permukaan PIC.
- Tidak ada deploy, tidak ada PR, tidak ada perubahan pada teks normatif F6 v1.1 / Addendum A / CR-HM-01.

## 10. Blocker yang masih menunggu keputusan manusia

| # | Status | Catatan |
|---|---|---|
| **BLK-9** | **RATIFIED-BY-OWNER-DIRECTIVE** (2026-10-11) | Daftar rute 03D yang dibatasi (tiga GET di §4) adalah keputusan owner, dicatat di sini dan sebagai pointer di `CR-HM-06/A01` §12. Over-read (riwayat se-tenant, daftar tenant-wide, versi DRAFT/SUPERSEDED) **ditolak oleh kontrak sekarang**, bukan dipangkas nanti. Ini record direktif — bukan tanda tangan yang kami karang: ratifikasi formal di atas dokumen beku tetap milik owner |
| BLK-4 | OPEN (milik 03E) | Disposisi rute staf S1 vs S2 |
| BLK-7 | OPEN (milik 03F) | Cakupan `idempotency_key` global vs per-tenant |
| BLK-3 | OPEN (DBA + Operations) | Pengukuran staging (rate PIC-linked, MC4 detection) — tidak memblokir bacaan 03D, memblokir klaim populasi |
| BLK-GAP-1 / BLK-BIND-BACKFILL | OPEN (ADD-A §8) | Selama keduanya terbuka, `NO_ACTIVE_APPROVAL_BINDING` adalah jawaban normal di produksi, bukan anomali |

## 11. Perubahan dokumen lain

`CR-HM-06/A01` §12 baris **BLK-9** diberi pointer: rute 03D diratifikasi sebagai **RATIFIED-BY-OWNER-DIRECTIVE** (2026-10-11) dan didokumentasikan di §4–§5 dokumen ini. Sel itu adalah pointer, bukan re-ratifikasi, dan tidak menyentuh teks normatif mana pun. Baris §13 untuk 03D dibiarkan sebagaimana adanya, mengikuti preseden 03B/03B2/03C yang juga tidak menandai ✓ sendiri.

## 12. Pernyataan integritas

Tidak ada hasil tes yang dikarang; angka di §7 adalah output perintah yang benar-benar dijalankan di sandbox ini, dan kegagalan baseline dicatat sebagai kegagalan baseline, bukan sebagai PASS. Tidak ada guard yang dilonggarkan, tidak ada `DISABLE TRIGGER`, tidak ada fallback yang ditambahkan ke source untuk membuat tes hijau — dua perbaikan yang terjadi selama debugging ada di **harness** (prune klaim, flag embedded-PG) dan dua temuan yang mengubah perilaku source (skip perbandingan identitas untuk kredensial read-only, pesan 404 seragam) masing-masing punya tes dan alasan di §8. Permukaan ini read-only; klaim bahwa ia "tidak mengubah state" ditegakkan oleh tes yang membandingkan jumlah baris ledger/scope/binding/sesi sebelum-dan-sesudah tiga bacaan, bukan oleh pernyataan.
