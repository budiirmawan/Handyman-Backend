# W03 PART 03E — Otoritas keputusan Tenant PIC: jalur tulis ke ledger yang sudah ada, tanpa fallback staf

**Status:** IMPLEMENTED + VALIDATED (lihat §10). Tidak ada deploy, tidak ada PR, **W03 E2E TIDAK dinyatakan tersertifikasi**.
**Parent authority:** `CR-HM-06_AMENDMENT_01_TENANT_PIC_APPROVAL_ACTOR.md` (`CR-HM-06/A01` v1.1, RATIFIED) — §6.2/§6.3 (ledger & actor identity), §8 MC0–MC5 + F7, §9 (kontrak route PIC), §10.3 C1–C16, §10.4 (disposisi jalur staf), §12 BLK-4, §13 baris **03E**.
**Addendum:** `CR-HM-06_ADDENDUM_A_TENANT_PIC_BINDING_AUTHORITY.md` — B7 (tidak ada gerbang status permintaan), B11 (body keputusan = `{decision}` saja), B12 (gerbang ISSUE: tetap OFF), B16/B17 (okupansi dievaluasi ulang, snapshot bukan otoritas), B18 (thread membeku setelah ada keputusan), C17/C21–C24, §8 BLK-GAP-1 + BLK-BIND-BACKFILL.
**Freeze:** `CR-HM-06_DECISION_FREEZE.md` F6 v1.1 (revisi 03E atas F6 tidak mengubah teks normatifnya), F7 (satu keputusan otoritatif per versi, replay via idempotency), F8/F9 (atomicitas keputusan + Execution Scope), F10/F11 tidak disentuh.
**Branch:** `arena/44e8ce22-handyman-backend`, base sha `9602991c`; HEAD sebelum kerja 03E = `dbb76f9` (03D).

---

## 1. Baseline yang diverifikasi sebelum menulis apa pun

| Cek | Hasil |
|---|---|
| `git rev-parse --short HEAD` sebelum kerja | `dbb76f9` (03D) — persis yang dijadwalkan A01 §13; rantai `fbce60b → 1b0e713 → fce6322 (03B) → e895e0d (03B2) → a5e5361 (03C) → dbb76f9 (03D)` terverifikasi `merge-base --is-ancestor` |
| `git status --porcelain` | bersih sebelum PART ini; hanya file milik 03E yang berubah setelahnya |
| Baca ulang F6 v1.1, A01 §6/§7/§8/§9/§10/§11/§12/§13, Addendum A | selesai lebih dulu, sebelum satu baris kode ditulis (item 2); tidak ada dokumen beku yang diedit selain penambahan pointer di A01 (lihat §12) |
| `npx tsc --noEmit` (produksi) | exit 0 setelah setiap tahap; hasil akhir di §10 |
| Migrasi baru untuk 03E | **tidak ada**. Lantai DB sudah tersedia: `0438` (kolom aktor ledger), `0439` (kolom aktor scope), `0441` (kredensial sesi workspace PIC), `0442` (guard ledger yang membaca sesi + binding). Sebuah PART permukaan tulis tidak boleh memindahkan lantai DB — dan tidak butuh |
| Kode error baru | **tidak ada** (C15). Penolakan PIC memakai `HANDYMAN_QUOTATION_DECISION_CONFLICT` (MC3), penolakan staf memakai `PERMISSION_DENIED` yang sudah ada, konflik scope memakai `HANDYMAN_EXECUTION_SCOPE_CONFLICT` yang sudah ada |
| Tabel ledger/scope baru | **tidak ada**. 03E menulis ke `handyman_quotation_decisions` dan `handyman_execution_scopes` yang sudah ada, hanya lewat mesin keputusan yang sudah ada |

## 2. Ratifikasi BLK-4 yang dicatat secara eksplisit (kewajiban item 3)

A01 §12 **BLK-4** meminta keputusan manusia: *"Staff route disposition S1 vs S2 (§10.4) — three frontends share the endpoint"*. Owner menjawabnya pada **2026-10-11**, dan ratifikasi itu dicatat di tiga tempat: sel BLK-4 di A01 §12, baris **03E** di A01 §13, dan dokumen ini.

| Yang diratifikasi | Isi | Konsekuensi yang dikerjakan 03E |
|---|---|---|
| BLK-4 = **S1** (soft-close) | Otoritas approval adalah Tenant PIC; rute staf **tidak dihapus** | `decideHandymanQuotation` menolak sebelum menyentuh DB; route, permission code, dan `GET` riwayat tetap ada (C8/C10) |
| Bentuk penolakan staf | berlapis, atas jawaban eksplisit owner: **403 `PERMISSION_DENIED`** untuk "kelas aktor Anda bukan kelas pemberi approval"; **409 `HANDYMAN_QUOTATION_DECISION_CONFLICT`** untuk konflik keadaan | lihat deviasi **03E-D1** — teks §10.4 menyebut "409/`STAFF_APPROVAL_FORBIDDEN` semantics", dan kode itu memang tidak diciptakan |
| Header deprekasi | `Deprecation: true` + `Link: <…>; rel="successor-version"`, **tanpa tanggal `Sunset`** | tanggalnya adalah janji rollout pemilik; dicatat sebagai blokir terbuka (§12), bukan dikarang di kode |
| Suite beku CR-HM-06 06/07A | **hanya** harapannya yang di-retarget ke kontrak S1 (penolakan terkendali, tanpa scope, header deprekasi); tidak ada penulisan ulang ke principal PIC, dan tidak boleh dibiarkan mengunci perilaku-era-500 | lihat §10 baris 06/07A + **03E-D7** |

## 3. Yang diimplementasikan

1. **Ledger menjadi tahu siapa yang menandatangani.** `handyman-quotation-decision.types.ts` + repository: `decisionActorType` (`USER` | `TENANT_PIC` sebagai diskriminator tersimpan, bukan turunan), `decidedByTenantPicId`, `decidedByPicSessionId`, `approvalBindingId`, dan `decidedByUserId` yang menjadi nullable; `NewHandymanQuotationDecision` membawa `actor` alih-alih user id telanjang (C4/C5). Kolom-nol untuk arm `USER` tetap terisi sebagaimana adanya — tidak ada baris lama yang ditulis ulang.
2. **Satu mesin tulis, dua lengan.** `writeQuotationDecision(tx, …)` adalah urutan beku F7/F8 (kunci versi → replay-atau-konflik → ISSUED + `validUntil` server-clock → lineage → query maker-checker sisi layanan → INSERT dengan pemetaan `23505`/`23514`/`23503`/`40P01` → proyeksi lifecycle → scope khusus APPROVE → jurnal) yang kini dipakai kedua lengan; tidak ada salinan kedua.
3. **Lengan PIC.** `recordPicQuotationDecision(tx, …)` diekspor untuk portal dan berjalan **di dalam** transaksi seam kredensial; `pic-portal-decide.service.ts` (`submitPicQuotationDecision`) menyelesaikan versi lewat predikat kredensial dengan `FOR UPDATE`, membaca binding aktif thread, menilai kelayakan dengan **evaluator 03D yang sama**, memanggil mesin, lalu **merevalidasi separuh otoritasnya setelah write** sebelum commit.
4. **C2 ditegakkan di replay.** Replay tidak lagi cukup "kunci sama + sidik jari sama + keputusan sama": kelas aktor, PIC, dan tenant harus sama, dan yang berbeda dijawab 409 tanpa mengulang isi baris.
5. **Scope tahu siapa pembuatnya.** `handyman-execution-scope.types.ts`/repository: `createdByActorType`, `createdByTenantPicId`, `createdByPicSessionId`, `createdByUserId` nullable; `buildExecutionScopeInput` menerima `actor` + `decisionTenantPicId` dan menolak jika PIC scope ≠ PIC keputusan (E2). Proyeksi publik **tidak** memuat `createdByPicSessionId` — omitnya ada di tipenya, bukan hanya di mapper (C7).
6. **Permukaan HTTP PIC.** `POST /handyman/pic/quotation-versions/{quotationVersionId}/decision` dengan body whitelist satu kunci, `Idempotency-Key` header wajib (1–200, ditrim), `Cache-Control: no-store`, dan 201/400/401/404/409 sesuai §9.
7. **Jalur staf ditutup secara terkendali**, dengan header deprekasi di kedua permukaan (refusal membawa header yang sama).
8. **OpenAPI**: 1 operasi POST baru + 3 skema baru (`PicPortalDecisionBody`, `PicPortalExecutionScope`, `PicPortalDecisionWrite`), pelonggaran §9 pada `HandymanQuotationDecisionRecord` dan `HandymanExecutionScopeRecord`, `deprecated: true` + header pada POST staf.
9. **Konsumen lama di-retarget** (03D×2 tes, 03C×1, 03B×1, 06×10, 07A×3) supaya tidak ada satu pun tes yang mengunci perilaku pra-S1 — lihat §11.

## 4. Pemetaan 14 item scope ke bukti

| # | Item scope | Di mana | Bukti di tes |
|---|---|---|---|
| 1 | Verifikasi HEAD/cabang/ancestry/tree | §1 | — (dokumen ini) |
| 2 | Ulas F6 v1.1, A01, Addendum A, kontrak 03B–03D | §1, §2, §6 | — |
| 3 | Catat ratifikasi BLK-4 S1 secara eksplisit | A01 §12 + §13 baris 03E, §2 dokumen ini | — |
| 4 | Endpoint keputusan PIC di atas sesi workspace PIC | `pic-portal.routes.ts`, `submitPicQuotationDecision` | `records an APPROVE as a TENANT_PIC decision…`; census rute di 03D (`three GETs and exactly one mutation`) |
| 5 | Versi/permintaan/tenant/PIC/binding/sesi diselesaikan server-side | `findVersionForCredential(..., {lock:'update'})`, `bindings.findActiveBinding`, principal 03C | `accepts exactly {decision} plus the idempotency header`, `refuses a version that is not this credential's thread…` |
| 6 | Revalidasi kelayakan **setelah lock**: expiry, revoke, okupansi, binding, maker-checker | `evaluatePicApprovalEligibility` dijalankan **setelah** versi di-lock `FOR UPDATE` (bukan sebelum), lalu `assertRecordedDecisionIsCurrent` mengulang separuh otoritasnya **setelah** write, pada transaksi yang sama | `refuses a binding whose window has lapsed`, `refuses self-approval by the thread's own author (MC1′)`, `refuses the PIC a binding does not confer…`, `refuses a credential revoked before the decision lands` |
| 7 | INSERT ke ledger yang sudah ada dengan `decision_actor_type=TENANT_PIC` + binding + PIC + sesi | `insertDecision`, guard `0438`/`0442` | tes 1 (`ledgerRowOf` memverifikasi kelima kolom) |
| 8 | Satu keputusan per versi; concurrency-safe; replay aman; idempotency sesuai kontrak | `lockVersionById`, `lockDecisionByVersion`, UNIQUE + pemetaan error | `replays the caller's own key and decision…`, `is safe under concurrency: one decision row per version…`, `refuses a second different decision on the same version` |
| 9 | APPROVE menghasilkan Execution Scope lewat otoritas yang ada; REJECT tidak pernah | `buildExecutionScopeInput` + `insertScope` di cabang APPROVE | `records a REJECT and creates nothing downstream (E5)`; assertion `E2` di tes 1 |
| 10 | Jalur keputusan staf ditutup dengan 403/409 terkendali, bukan 500 | `staffApprovalForbiddenError`, `asDecisionRefusal` | `keeps the staff decide path a controlled 403 with a successor, never a 500`; tes 03B yang di-retarget; tes 06/07A |
| 11 | Keputusan `USER` historis tidak berubah; tanpa backfill | tidak ada UPDATE di manapun; default kolom `'USER'` tetap | `leaves the pre-amendment historical shape untouched`; 03B `blocks every new non-PIC decision at the ledger (prospective-only ban)` |
| 12 | Tes terfokus: approval, rejection, replay, race, cross-tenant, PIC salah, sesi revoked, maker-checker, penolakan fallback staf | `tests/handyman-pic-portal-decide.test.ts` | 23 tes, semuanya tersebut di §10 |
| 13 | Verifikasi seluruh konsumen langsung sehingga tidak ada jalur bypass approval | §11 | blok "static census" (satu call-site tulis, repositori INSERT-only, tanpa lock tabel aktor, C6 tidak dilebarkan) |
| 14 | Dokumentasi dependensi rilis, standstill terkendali, blokir tersisa | §7, §12, A01 §12/§13 | — |

## 5. Kontrak API yang dikirim

| Method + path | operationId | Isi |
|---|---|---|
| `POST /handyman/pic/quotation-versions/{quotationVersionId}/decision` | `submitPicQuotationDecision` | body **tepat** `{decision}`; header `Idempotency-Key` wajib; 201 = `{decision: PicPortalDecision, executionScope: PicPortalExecutionScope|null}` |
| `POST /handyman/quotation-versions/{quotationVersionId}/decision` | `decideHandymanQuotation` | **deprecated** (`deprecated: true`); selalu 403 `PERMISSION_DENIED`; `Deprecation: true` + `Link rel="successor-version"`; 201 dipertahankan di dokumen sebagai bentuk historisnya, ditandai unreachable |
| `GET` ketiga permukaan PIC (03D) | — | tidak berubah; eligibility kini adalah alasan yang sama dipakai jalur tulis |

Status code jalur tulis PIC, persis seperti §9: **201** (keputusan + scope; replay = 201 dengan fakta asli), **401** (kredensial mati/cabut — termasuk bila otoritas gugur di tengah transaksi), **404** seragam `HANDYMAN_PIC_WORKSPACE_RESOURCE_NOT_FOUND` (id tak dikenal, thread penyewa lain, building lain, space yang tidak dicakup kredensial), **409** `HANDYMAN_QUOTATION_DECISION_CONFLICT` untuk **semua** alasan penolakan keputusan. 400 VALIDATION untuk body/query/header yang salah (satu-satunya kelas tambahan, dan memang disyaratkan kontrak `Idempotency-Key`).

Yang **tidak** ada di respons PIC: `decidedByUserId` (nol kunci, bukan `null`), idempotency key, sidik jari, `createdByUserId`/`channelAttributionId`/`tenantCompanyId` pada proyeksi scope (F9/C16), dan token/credential apa pun.

## 6. Model otoritas, kunci, dan urutan lock

**Satu transaksi.** `withPicWorkspaceSession` memverifikasi kredensial → menjalankan pekerjaan → memverifikasi ulang sesi, semuanya di transaksi yang sama; karena keputusan berjalan di `tx` pinjaman seam, sebuah revoke atau binding yang jatuh di tengah tidak bisa menyelinap di antara otorisasi dan tulis (butir 6 sekaligus jawaban R7 dari seam).

**Urutan lock yang dipakai jalur ini:**

```
tenant_pic_sessions (FOR NO KEY UPDATE, oleh seam)
  → handyman_quotation_versions (FOR UPDATE, lewat predikat kredensial)
    → handyman_quotation_approval_bindings (FOR SHARE, oleh mesin)
      → INSERT decision (guard 0442 membaca ulang semuanya, tanpa lock)
      → UPDATE version lifecycle → INSERT scope → INSERT events
```

Empat konsekuensi yang sengaja dirancang, bukan kebetulan:

1. **`FOR UPDATE` di bacaan kredensial, bukan `FOR SHARE`.** Mesin sudah mengunci versi `FOR UPDATE`; bila portal lebih dulu mengambil `FOR SHARE` pada baris yang sama, dua sesi PIC yang memutuskan versi yang sama akan saling tunggu saat upgrade ( SHARE → UPDATE = deadlock klasik `40P01`). Satu kunci eksklusif melalui predikat kredensial membuat re-lock mesin menjadi no-op. Ditegaskan secara statis di tes 03E (`findVersionForCredential( … lock: 'update'`).
2. **Binding di-share setelah versi, tidak pernah sebelumnya.** `03B` revoke memakai `session → binding`; path kita juga `session → … → binding`, jadi keduanya searah. Bila binding di-lock sebelum versi, ia berlawanan dengan `createApprovalBinding` (`binding → session`) dan menciptakan siklus. Lihat **03E-D6** untuk residu deadlock yang tetap ada dan bagaimana ia dipetakan ke 409.
3. **Tidak ada satu pun lock pada `tenant_pics` / `tenant_companies`.** `findTenantPicFacts` dan `findTenantCompanyAndClientStatuses` adalah SELECT polos, dan guard ledger juga membaca ulang tanpa lock. Ini yang membuat urutan seam tidak berbenturan dengan trigger revocation (`tenant_pics` → session). Aturan ini **statis**: tes census memecah tiap statement di jalur tulis dan menuntut agar tidak ada `FOR UPDATE`/`FOR SHARE`/`pg_advisory` yang menyasar tabel aktor (alias-target diperiksa, bukan cuma kata kuncinya).
4. **`FOR SHARE OF b`-lah yang menutup ras revoke (B11).** Tanpa lock bersama itu, revoke yang commit setelah bacaan kelayakan kita tapi sebelum insert bisa kalah dari snapshot kita dan keputusan tetap tercatat; dengan share-lock, UPDATE revoke menunggu, dan `0437` B18 menolak revocation tersebut begitu baris keputusan kita ada. Jadi keputusannya: serialize lewat share-lock, dan kalau Postgres yang memutuskan siapa yang kalah (`40P01`), jawabannya 409 + rollback penuh, bukan 500.

**Maker-checker (MC1′) dua lapis.** Layanan memuat `M = pembuat root ∪ pembuat versi ∪ pemberi binding` dan `C = PIC penandatangan + user tertautnya` dalam transaksi yang sama, setelah kunci versi; guard INSERT `0442` mengevaluasi ulang hal yang sama pada saat tulis. Keduanya sengaja ada: layanan untuk menghasilkan error yang benar, guard agar tidak ada pemanggil masa depan yang bisa melewatinya (MC2). Perbandingan hanya lewat `tenant_pics.user_id` — dua namespace id tidak pernah dibandingkan langsung, dan PIC tanpa user link tidak ditolak karena "bukti tidak ada" (MC4 adalah residu, bukan bug di sini).

**Konsistensi jam.** `now` untuk `validUntil` dan window binding diambil dari `clock_timestamp()` di awal pekerjaan; `decided_at` adalah `NOW()` transaksi, dan guard menilai window terhadap `NEW.decided_at`. Perbedaan submilidetik di detik terakhir sebuah window dimenangkan guard (409 via `asDecisionRefusal`) — bukan 500, dan bukan keputusan yang lolos.

## 7. Jalur staf: penutupan terkendali dan standstill yang disepakati

| Permukaan | Sebelum 03E | Sesudah 03E (S1) |
|---|---|---|
| `POST …/decision` (staf) | request masuk ke mesin → guard DB menolak INSERT → `23514` mentah → **500** dengan pesan guard | **403 `PERMISSION_DENIED`** sebelum transaksi dibuka; `Deprecation: true` + `Link` successor; nol query |
| `GET …/decision` (staf) | baca riwayat | **tidak berubah** (C8): riwayat `USER` tetap terbaca, tanpa backfill, tanpa tulis ulang |
| Route + OpenAPI | mounted | tetap mounted + `deprecated: true` (C10). Penghapusan route adalah PART housekeeping terpisah dan butuh tanggal owner |
| Thread tanpa binding | tidak ada yang bisa memutuskan | **standstill terkendali**: staf 403, PIC 409 (`NO_ACTIVE_APPROVAL_BINDING` di bacaan eligibility). Tidak ada auto-bind, tidak ada pembuatan binding saat baca, tidak ada `'USER'` yang kembali ke ledger |
| Gerbang B12 (ISSUE butuh binding) | OFF | **tetap OFF** — fixture 03E justru membuktinya: `buildThread({issue:true})` tanpa binding berhasil, dan tes `stands still when no binding confers anyone…` mengandalkannya |

## 8. Yang secara sadar TIDAK dikerjakan di PART ini

- **B12 tidak diaktifkan.** Mengubah urutan rilis adalah keputusan owner (ADD-A §8), bukan efek samping 03E.
- **Tidak ada auto-binding / binding sementara / binding yang diturunkan saat baca** (ADD-A B12–B18 tetap milik jalur staf).
- **Tidak ada ledger keputusan kedua, tidak ada kolom tambahan di ledger, tidak ada migration baru.**
- **Guard scope sisi DB (E1–E3 di `handyman_execution_scopes`) TIDAK dibuat di sini** — itu baris 03F yang sudah diratifikasi; repository scope 03E tetap INSERT-only dan komentar di `0439`/03F menjadi jejaknya.
- **C6/BE-02G tidak dilebarkan ke principal PIC** (A7): jalur PIC tidak pernah memanggil `assertQuotationThreadBuildingAccess`; dicegah oleh tes census.
- **`UNIQUE (scope, idempotency_key)` tidak diketatkan** (BLK-7 / R6) — milik 03F setelah BLK-3 terukur.
- **Tidak ada mekanisme koreksi/damaran untuk keputusan yang sudah tercatat**, tidak ada `revocation_reason`/`note` di ledger, tidak ada peran baru/kode izin baru.
- **Tidak ada deploy, tidak ada PR, dan `Sunset` date tidak dikarang.**

## 9. Deviasi yang dicatat dari teks terbekukan (eksplisit, bukan diam-diam)

- **03E-D1** — A01 §10.4 menulis mekanik S1 sebagai "409/`STAFF_APPROVAL_FORBIDDEN` semantics" + `Deprecation`/`Sunset`. Yang dikirim: **403 `PERMISSION_DENIED`** di permukaan staf (policy tentang pemanggil) dan **409** untuk konflik keadaan di permukaan PIC, dengan `Deprecation: true` **tanpa** `Sunset`. Atasannya adalah jawaban owner 2026-10-11 ("layered refusal" + "no date is the owner's promise"), dan C15 melarang kode baru — karena itu `STAFF_APPROVAL_FORBIDDEN` tidak pernah diciptakan.
- **03E-D2** — Semua penolakan jalur PIC, **termasuk kredensial read-capable**, dijawab 409 (bukan 403). §9 memberi rute ini 201/401/404/409 saja; kelas 403 adalah milik permukaan staf (lihat 03E-D1). Alasan lengkapnya tetap bisa dibaca: itu fungsi bacaan eligibility 03D.
- **03E-D3** — `readPicWorkspaceBearer` menolak **semua** body, yang benar untuk tiga GET dan mustahil untuk POST. Jalur tulis therefore: argumen body di slot bearer diisi `undefined` (aturan query-string tetap ditegakkan penuh) dan `parsePicDecisionBody` memegang whitelist satu kunci — kunci asing dijawab 400 `VALIDATION_ERROR` dengan kelas yang sama seperti penolakan konteks di bacaan.
- **03E-D4** — Revalidasi **setelah** kunci mengulang separuh **otoritas** (binding ACTIVE + window vs `decided_at`, PIC ACTIVE di tenant yang sama, tenant/client ACTIVE, okupansi CURRENT, MC1′, dan bahwa baris yang tercatat benar-benar milik PIC+sesi+binding ini). Separuh **keadaan versi** sengaja tidak diulang setelah write: kita sendiri yang mengubahnya (`ISSUED → APPROVED`), dan menilai proyeksi kita dengan aturan pra-keputusan akan menolak setiap keputusan. Butir 6 tetap terpenuhi karena kelima kondisi yang disebutnya dibaca ulang setelah lock.
- **03E-D5** — Replay **melewati** veto kelayakan pra-tulis (kalau tidak, `ALREADY_DECIDED` mengubah retry setelah respons hilang menjadi 409) dan melewati revalidasi pasca-tulis (F7 mengembalikan fakta asli, dan faktanya window binding lama boleh sudah tertutup). Yang tetap berlaku untuk replay: uji aktor C2 dan larangan satu-baris-per-versi.
- **03E-D6** — R7 menyebut urutan "**authority row → session row**". Jalur tulis PIC memegang sesi lebih dulu (seam 03C tidak bisa dipisah) dan baru mengunci binding. Ini disengaja dan diamankan dengan cara lain: tidak ada lock pada tabel aktor (dipaksa tes census), share-lock binding mengikuti versi, dan `40P01`/`40001` dipetakan ke 409 dengan rollback penuh. Residunya dinyatakan apa adanya: sebuah `createApprovalBinding` yang berlari bersamaan dengan keputusan pada thread yang sama dapat menjadi korban deadlock dan menerima 409 + ulangi. Tidak ada pelonggaran MC1–MC5' yang dibayar untuk itu, dan tidak ada bypass yang terbuka.
- **03E-D7** — Suite beku 06 (`handyman-quotation-decision`) dan 07A (`handyman-quotations-api`) tidak dibiarkan merah maupun mengunci era-500: harapan **keputusannya** di-retarget ke S1 (refusal terkendali, tanpa scope, header deprekasi) atas direktif owner, dan invarian mesin yang sebelumnya diuji lewat staf (replay, atomisitas, E5, census tanpa efek samping) **dipindahkan** ke suite PIC — bukan dihapus. Dua error tipe pra-existing di 06 (baris 218/236, `fixture.service` — berasal dari HEAD, bukan dari 03E) **tidak** dikerjakan: file itu tidak dimasukkan ke `tsconfig.tests.json`, dan dua error itu tetap milik baseline program lain.

## 10. Bukti perintah

Semua dijalankan di sandbox ini; yang tidak dijalankan atau merah sejak baseline ditandai apa adanya.

| Perintah | Hasil |
|---|---|
| `npx tsc --noEmit` (produksi) | **exit 0** |
| `npm run typecheck:tests` (`tsc -p tsconfig.tests.json`, kini 5 suite program + shim) | **exit 0** |
| `npx tsx --test tests/handyman-pic-portal-decide.test.ts` (suite 03E, embedded PG 55562) | **23 tes / 23 pass / 0 fail / 0 skip**, ±38 detik; dijalankan ulang setelah pemetaan `40P01` (03E-D6) dan tetap 23/23 |
| `npx tsx --test tests/handyman-pic-portal-read.test.ts` (03D, 2 tes di-retarget) | **25/25 pass**, diulang setelah 03E mengirim rute tulis (tetap 25/25) |
| `npx tsx --test tests/handyman-pic-workspace-session.test.ts` (03C, 1 tes di-retarget) | **25/25 pass** |
| `npx tsx --test tests/handyman-quotation-approval-binding-runtime.test.ts` (03B2) | **10/10 pass** |
| `npx tsx --test tests/handyman-quotation-pic-binding-migration.test.ts` (03B, 1 blok di-retarget) | **14/14 pass** |
| `npx tsx --test tests/handyman-quotation-lifecycle.test.ts` (jalur penerbitan, tidak berubah) | **10/10 pass** pada PostgreSQL hidup (55555) — bukti `updateVersionLifecycle` di dalam transaksi PIC tidak berbenturan dengan trigger manapun |
| `npx tsx --test tests/handyman-quotation-decision.test.ts` (suite ledger CR-HM-06 06 — **di-retarget ke S1**) | **10/10 pass**. Sebelum retarget: 2 pass / 8 fail = BASELINE-FAIL (guard DB menolak approval staf sebagai `23514` mentah = 500-era). Lihat §12 + 03E-D7 |
| `npx tsx --test tests/handyman-quotations-api.test.ts` (permukaan staf CR-HM-06 07A) | **10/10 pass**. Sebelum retarget: 7 pass / 3 fail = BASELINE-FAIL pada tes 6/7/9. Sensus path staf (10 path `/handyman/**quotation**`) tetap 10 karena path PIC dikecualikan sejak 03D-D6 — tidak ada angka sensus yang dikecilkan |
| `npx tsx --test tests/openapi-operational-structural-closure.test.ts tests/openapi-tenant-commercial-closure.test.ts` | 19 tes / 15 pass / **4 fail = BASELINE-FAIL identik dengan `HEAD`** (census milik program INT-LC-19-BE/CR-BE-CONFIG; tidak dikerjakan diam-diam di 03E) |
| parse `docs/api/openapi.yaml` + census | parse OK; **1358 path** (0 path baru, +1 operasi), **2060 schema** (+3), **18 892 `$ref` hasil traversal rekursif penuh — 0 menggantung** (angka 2377 milik 03D adalah penelusuran yang lebih sempit, bukan pembanding langsung); operasi pada path keputusan PIC = `get` + `post`, path staf `deprecated: true`; `HandymanQuotationDecisionRecord`/`HandymanExecutionScopeRecord` memuat pelonggaran §9 |
| `handyman-quotation-decision`/`-api`/`-lifecycle` dijalankan terhadap PG hidup, bukan di-skip | ya — 30+ tes aktif. Catatan harness di §13 |

Rekaman baseline-merah yang **tidak** pernah disebut PASS: `openapi-contract` 5/1 · `mobile-openapi-completeness` 3/2 · closure pair 15/4 · tiga suite ujung-migrasi lain (`fx02-part02…:482`, `r08-part01b:488`, `r08-part02b:676`) · typecheck `tests/**` seluruh repo = **2078 error pre-existing** (karena itu `tsconfig.tests.json` tetap diskop ke file milik program dan tidak dilebarkan).

## 11. Konsumen langsung yang diverifikasi (item 13)

| Konsumen | Status setelah 03E |
|---|---|
| `handyman-quotations-api.controller.ts` | **satu-satunya** pemanggil `decideHandymanQuotation` di seluruh `src/` (`grep` = controller:295 + ekspor indeks + satu komentar di `0438`); kini menyetel header deprekasi lalu menerima 403 (tulis) / normal (baca). Tidak ada permukaan mobile, batch, atau modul lain yang memanggilnya — jadi tidak ada jalur staf kedua yang bisa tertinggal |
| `handyman-quotations/index.ts` | mengekspor mesin + tipe yang dilebarkan; tidak ada konsumen lain yang mengimpor `insertDecision`/`insertScope` |
| Tipe scope publik (`PublicHandymanExecutionScope`) | dipakai `toPublicExecutionScope` + proyeksi PIC; tidak ada konsumen yang membaca `createdByPicSessionId` (omitted by type), dan tidak ada JOIN `created_by_user_id → users` di seluruh `src/` (E4 diverifikasi ulang di PART ini; hanya modul 03E yang membaca kolom itu) |
| `chargeable-additional-works`, `customer-payments`, `warranty-claims` | hitannya pada `decided_by_user_id` adalah **tabel lain**, bukan ledger keputusan — diverifikasi, tidak diubah |
| Guard DB (`0442`, `0437`) | tidak disentuh; ia lantai di bawah kedua lengan, dan tetap satu-satunya yang menolak `'USER'` bila ada pemanggil yang melewati layanan |
| Modul 03C/03D | seam kredensial dan predikat kredensial dipakai ulang, tidak digandakan; `pic-portal.repository.ts` hanya menambah parameter lock |
| Suite program lain (06/07A/03B/03C/03D) | hanya harapan **keputusan**-nya yang di-retarget (§3.9); tidak ada assertion milik program lain yang dihapus atau dilemahkan |

Kesimpulan yang bisa dibaca dari tabel ini: **tidak ada jalur kedua menuju approval**. Satu-satunya tulis ke `handyman_quotation_decisions` adalah `insertDecision` di dalam `writeQuotationDecision`, dan satu-satunya pemanggilnya adalah lengan PIC (lengan staf menutup dirinya sebelum I/O). Itu ditegakkan secara statis, bukan sebagai konvensi.

## 12. Dependensi rilis, standstill, dan blokir yang tersisa

**Dependensi rilis 03E.** Yang dibutuhkan: 03B/03B2 (kredensial + binding), 03C (seam sesi), `0438`/`0439`/`0442` (lantai ledger), dan **binding aktif dari jalur staf** (B8) — karena S1 menutup jalur staf TANPA mengaktifkan B12, sebuah thread baru hanya bisa diputuskan setelah seorang staf mem-binding PIC. Itu konsekuensi langsung ratifikasi BLK-4, dan itulah **standstill terkendali** yang diminta item 14: tidak ada approval diam-diam, tidak ada kegagalan 500, dan keduanya punya alasan yang bisa dibaca (eligibility PIC ↔ 403 staf).

| Blokir | Pemilik | Status setelah 03E |
|---|---|---|
| BLK-4 (S1 vs S2) | Product owner + FE | **DIRATIFIKASI = S1** (2026-10-11); dicatat di A01 §12/§13 |
| Tanggal `Sunset` + PART housekeeping penghapusan rute staf | Owner + BM | **TERBUKA — dicatat sebagai A01 §12 BLK-10**; 03E sengaja tidak mengarang tanggal (03E-D1) |
| Urutan rilis B12–B18 vs penutupan rute staf (ADD-A §8 "sequence B12–B18 before the staff route is closed") | Product owner | **DILEPAS oleh ratifikasi S1 untuk penutupan *service-level***; gerbang ISSUE B12 tetap OFF, jadi urutan rilis masih menjadi keputusan owner sebelum peluncuran. Tidak ada satu pun kode 03E yang membuka jalur tanpa binding |
| BLK-GAP-1 / BLK-BIND-BACKFILL | Product owner + Ops | **TERBUKA**; selama terbuka, thread tanpa binding tidak punya pemberi approval (standstill di atas) — itu perilaku yang didokumentasikan, bukan bug |
| BLK-3 (pengukuran staging) | DBA + Ops | TERBUKA; 03E tidak membuat klaim populasi apa pun |
| BLK-7 (UNIQUE idempotency global, `0394`) — 409 oracle lintas-tenant | Architecture + DBA | **03F**. 03E tidak mengetatkan apa pun (R6) |
| Guard E1–E3 sisi DB untuk `handyman_execution_scopes` | Architecture | **03F** (diratifikasi di sana); 03E hanya menegakkan E1/E2/E5 di layanan |
| BLK-6 / MC5' (penerbit versi tidak disimpan sebagai kolom sendiri) | Architecture | TERBUKA; M saat ini = root author ∪ version author ∪ granter |
| BLK-9 (tanda tangan formal ratifikasi) | Owner | TERBUKA (pointer, sama seperti di 03D) |

**Sertifikasi.** Yang boleh diklaim: 03E terkirim dengan 23 tes runtime terhadap DB hidup + 5 gate tipe/kontrak, dan 14 item scope punya baris bukti masing-masing. Yang **tidak** boleh diklaim: W03 E2E certified (03F/03G/03H belum berjalan), CR-HM-06 sertifikasi ulang, "PIC approval siap produksi" (B12, BLK-GAP-1, backfill binding, tanggal Sunset masih milik owner), dan angka sensus OpenAPI milik program lain yang tetap merah sebagai baseline.

## 13. Catatan harness (untuk PART berikutnya)

- Sandbox **membuang variabel berawalan `ASENTRA_*` dan `DB_*` saat exec**. Yang dipakai: `NODE_OPTIONS="--require /tmp/embedded-flag.cjs"` untuk suite yang punya bootstrap sendiri (03B/03B2/03C/03D/03E), dan satu PostgreSQL embedded bersama di port **55555** (`/tmp/boot-pg.mjs`) untuk suite CR-HM-06 yang tidak punya bootstrap (06/07A/lifecycle). Suite yang "hijau" di bawah 30 detik berarti **skip**, bukan hasil.
- `node_modules` bisa kosong setelah re-clone: `npm ci --no-audit --no-fund` (307 paket, ±8 detik) sebelum `npx tsc`/`npx tsx`; tanpa itu `npx` mencoba memasang paket `tsc@2.0.4` yang bukan compiler.
- Fixture yang perlu diingat: link `tenant_pics.user_id` untuk uji MC1′ baru boleh dibuat **setelah** baris binding ada (guard `0437` menolak binding yang pemberinya = user PIC tertaut), dan sesi harus di-admit **setelah** link dibuat (03C mencabut kredensial saat user-link bergerak; kalau tidak, yang teruji adalah 401, bukan maker-checker). Binding kedaluwarsa dibuat dengan `effective_until` di masa depan lalu `sleep` — `0437` menolak UPDATE.
