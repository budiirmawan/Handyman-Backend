# W03 PART 03C — Sesi PIC terbatasi yang dijamin attestation BM: schema floor, modul kredensial, audit

Tanggal: 2026-10-11 (Asia/Jakarta). Branch kerja: `arena/44e8ce22-handyman-backend`.
Kontrak: `docs/handyman/CR-HM-06_AMENDMENT_01_TENANT_PIC_APPROVAL_ACTOR.md` (A01) §4–§5
(rule 1–22), §6.1/§7.1 (kolom sesi di ledger), §9 (permukaan route), §10 C15 (kode error),
§13 (baris `03B — session foundation`), §12 BLK-2;
`docs/handyman/CR-HM-06_ADDENDUM_A_TENANT_PIC_BINDING_AUTHORITY.md` §3.3/§3.4 (bentuk binding
yang sudah diratifikasi 03B/03B2, ditiru, tidak diubah); preseden mekanisme:
`CR-HM-CARE-WORKSPACE-01` PART 01–02 (sesi workspace ber-audience terisolasi) dan
CR-HM-01 PART 03/05 (assertion HMAC + canonical stable JSON).
Record sebelumnya: `docs/e2e/W03_PART03B_QUOTATION_PIC_APPROVAL_SCHEMA.md`
(0437–0439, `fce6322`) dan `docs/e2e/W03_PART03B2_QUOTATION_PIC_APPROVAL_BINDING_RUNTIME.md`
(0440, `e895e0d`).

**Status PART ini: selesai dan terverifikasi fokus. BUKAN PR, BUKAN deploy, BUKAN sertifikasi
E2E.** Tidak ada satu pun klaim "journey lengkap" yang boleh dibaca dari dokumen ini.

---

## 1. Baseline yang diverifikasi sebelum menulis apa pun

| Pemeriksaan | Hasil |
|---|---|
| `git log -1` sebelum mulai | `e895e0d W03 PART 03B2: quotation PIC approval-binding runtime (0440, 3 staff routes)` |
| `git status --porcelain` sebelum mulai | bersih |
| `git ls-remote origin refs/heads/arena/44e8ce22-handyman-backend` | `e895e0da2b0a68134ea7b5733452602832cae81a` — sama dengan HEAD |
| posisi terhadap `origin/arena/44e8ce22-handyman-backend` | 0 di depan, 0 di belakang (`ANCESTRY_OK`) |
| posisi terhadap `origin/main` (`9602991`) | 6 commit di depan; `origin/main` TIDAK digabung/di-rebase di PART ini (di luar wewenang PART) |
| teks A01 §4–§5 rule 1–22, §6.1, §7.1, §9, §10 C15, §13 | dibaca ulang verbatim sebelum implementasi |
| jumlah entri array `migrations` sebelum PART | 440 |
| pola yang ditiru sebelum menulis | `handyman-care-workspace/` (router + service + store terpisah), `0429_create_handyman_care_workspace_sessions.ts` (bentuk tabel sesi + guard revocation), `handoff-runtime.repository.ts` (`createIntegration`), `handoff-runtime.config.ts` (`handoffIntegrationSecretEnvName`), `shared/stable-json.ts`, `auth/login-rate-limit.ts`, `0437`–`0439` (idiom guard ledger) |

Jumlah entri di array `migrations` sesudah PART ini: **442** (0441, 0442).

## 2. Yang diimplementasikan

**Skema (2 migrasi).**

- `0441_handyman_pic_workspace_sessions.ts` — tabel `handyman_pic_workspace_sessions`: 11 kolom
  + `id`; FK ke `handyman_handoff_integrations`, `tenant_companies`, `tenant_pics`, `buildings`,
  `spaces`, `tenant_building_contexts`; `token_hash TEXT NOT NULL UNIQUE CHECK ~ '^[0-9a-f]{64}$'`
  (hash saja, tidak pernah token); `UNIQUE (integration_id, assertion_id)` sebagai penanda replay;
  `CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '15 minutes')`;
  `CHECK (revoked_at IS NULL OR revoked_at >= created_at)`. Tiga trigger invalidasi (AFTER UPDATE
  pada `tenant_pics` non-ACTIF / re-parent / `user_id` berubah; pada `tenant_companies` non-ACTIF;
  pada integrasi non-ACTIF / capability hilang) mencabut sesi hidup, plus
  `handyman_pic_workspace_guard` (`BEFORE UPDATE OR DELETE`) yang hanya mengizinkan pencatatan
  revocation pertama dan menolak DELETE — history tidak bisa dihapus. Di batch yang sama:
  `handyman_handoff_integrations_actor_capability_check` diperluas dengan `'TENANT_PIC'`
  (kanal attestation; lihat deviasi 03C-D4).
- `0442_handyman_quotation_pic_session_ledger_link.ts` — menutup **D1** yang ditunda 03B:
  `handyman_quotation_decisions.decided_by_pic_session_id` dan
  `handyman_execution_scopes.created_by_pic_session_id` (FK ke tabel sesi), kedua CHECK
  identitas-aktor dibangun ulang dalam bentuk penuh §6.1/§7.1, dan klausa sesi ditambahkan ke
  cabang INSERT guard ledger. `down()` mengembalikan body guard 0438 verbatim dan menolak peel
  bila sudah ada baris ledger yang memakai kolom sesi (forward-fix only). Tidak ada baris
  keputusan yang berubah; tidak ada endpoint decide baru.

**Runtime (5 file, `src/modules/handyman-pic-session/`, 1050 baris).** `index.ts`,
`pic-workspace-session.types.ts` (purposeliteral, prefix, ceiling, kunci wajib, knob TTL),
`pic-workspace-session.errors.ts` (2 kode, refusal seragam tanpa detail),
`pic-workspace-session.repository.ts` (lookup + lock + tombstone + insert + revocation),
`pic-workspace-session.service.ts` (admission, revalidasi per panggilan, logout),
`pic-workspace-session.routes.ts` (3 verb). `src/routes/index.ts` me-mount router ini **di
sebelah** router handoff dan care, bukan digabung. Perbaikan harness 03B/03B2 (lihat §7) ikut
dalam PART ini karena 0442 mengubah aturan yang mereka uji.

Urutan admission (rule 9): struktur → HMAC atas byte kanonik yang persis dikirim → window →
resolusi otoritas → tombstone+sesi dalam SATU transaksi → audit. Urutan use: `FOR UPDATE` pada
baris sesi dengan `expires_at > clock_timestamp()` → `FOR SHARE` pada otoritas → re-resolusi
`resolveHandoffContext` dari identitas TER SIMPAN dan bandingkan kelima field snapshot → principal.

## 3. Pemetaan 12 item scope ke bukti

| # | Item scope | Bukti |
|---|---|---|
| 1 | Verifikasi HEAD/branch/tree sebelum kerja | tabel §1 |
| 2 | Baca record handoff BM, sesi Care Workspace, RFQ vendor session, identitas PIC tenant, S1–S22 beku | §1 baris terakhir; implementasi memakai `resolveHandoffContext` sebagai satu-satunya master occupancy, dan `createIntegration`/capability milik `handoff-runtime`, tidak menyalin RFQ/vendor model |
| 3 | Pakai ulang infra kredensial/sesi TANPA menyamakan sesi PIC dengan Care Workspace | `handyman_pic_workspace_sessions` terpisah; `PIC_WORKSPACE_PURPOSE = 'HANDYMAN_PIC_WORKSPACE'`; prefix token sendiri; `parseHandoffCareActorClaim` TIDAK dipakai. Test "isolates purpose" + "refuses a care token at the PIC route…" membuktikan dua arah |
| 4 | Sesi ter-attest: audience terisolasi, namespace token, TTL, persist hash-saja, revoke, proteksi replay | `assertion()`/`sign()` + test "mints exactly the contracted shape and persists a hash, not a token" (scan string `hpw_`/raw token di DB = 0), "mints one session per assertion and collapses a duplicate into the 401", "enforces hash uniqueness and the immutable assertion tombstone", "clamps the deployment TTL knob…" |
| 5 | Identitas PIC diselesaikan server-side dari assertion; tenant/PIC/building/space pemanggil tidak pernah dipercaya | Test "refuses any deviation from the exact assertion vocabulary" (clientId/actor/requestId diselundupkan → 401) dan "refuses a foreign-tenant PIC, an unoccupied building, and an unrelated space"; kolom sesi diisi hasil resolusi, bukan body |
| 6 | PIC ACTIVE, membership tenant, occupancy/window, request binding ditegakkan | "requires an ACTIVE integration that holds the TENANT_PIC capability", "drops a live session on every authority transition named by rule 18", "drops a live session when occupancy lapses with nothing to trigger on", klausa guard di 0442 |
| 7 | Tolak cross-tenant, cross-building, PIC revoked, token expired, replay, token-type confusion | enam test di atas + "refuses an expired credential at logout rather than granting 204", "never authorizes a token that expired while it waited on a row lock", "refuses a care token at the PIC route, a PIC token at the care route, and any local bearer" |
| 8 | Permukaan sesuai kontrak: admission/exchange + introspeksi sesi + revoke | `POST` / `GET` / `DELETE` `/handyman/pic/session`; `openapi.yaml` mencatat 3 operasi itu saja |
| 9 | Audit untuk admission/revoke tanpa PII | `HANDYMAN_PIC_WORKSPACE_SESSION_ADMITTED` / `_REVOKED`, entityType `HANDYMAN_PIC_WORKSPACE_SESSION`, `actorUserId: null`, metadata = id + window saja; test "journals admission and revocation with ids only — no PII, no credential" membandingkan SET kunci dan menyapu string `email`/`phone`/`pic_name`/token di `JSON.stringify` |
| 10 | Tes runtime + tes keamanan negatif terfokus | 25 test, diorganisasi per §13 attack (replay, window, expiry-after-lock-wait, cross-tenant, revoked PIC, malformed keys, kind separation, hash-never-echoed, cross-building, expired, token-type confusion) + 3 kasus DB-floor |
| 11 | Dokumentasi integrasi BM Super App, lifecycle token, dependensi rollout | §5 dan §6 dokumen ini + `openapi.yaml` |
| 12 | Rekonsiliasi kontrak audit `reason`/`note` 03B2 — dokumen saja | §8; tidak ada satu baris pun perubahan logika bisnis untuk item ini |

## 4. Kontrak API (yang dijanjikan runtime PART ini)

`/api/v1/handyman/pic/session` — tiga operasi, tidak ada yang lain.

- `POST` (admission). Auth: `x-hub-signature-256` atas byte kanonik assertion; TIDAK ada Bearer,
  TIDAK ada `authenticationMiddleware`, TIDAK ada `requirePermission`. Body persis
  `{purpose, integrationCode, assertionId, issuedAt, expiresAt, representation{tenantCompanyId,
  buildingId, tenantPicId?, spaceId?}}`; kunci asing/kehilangan → 401 seragam. Query apa pun →
  400. Sukses `201 {success:true, data:{workspaceToken, expiresAt}, meta:{}}`; token muncul satu
  kali, hanya hash yang disimpan.
- `GET` (introspeksi). `Authorization: Bearer hpw_…` saja → `200` dengan
  `{sessionId, tenantCompanyId, tenantPicId, buildingId, spaceId, canDecide, issuedAt, expiresAt}`.
  Tidak pernah mengembalikan token, hash, assertion id, atau data pribadi.
- `DELETE` (revoke). Bearer saja; body/query berisi field konteks → 400; sesi tercabut yang masih
  belum kedaluwarsa dan masih dapat diselesaikan → `204` idempoten.
- Error seragam: `HANDYMAN_PIC_WORKSPACE_UNAUTHORIZED` (401) untuk SEMUA penolakan
  kredensial/otoritas, tanpa reason detail (pertahanan terhadap enumerasi);
  `AUTH_RATE_LIMITED` (429 + `Retry-After`); `VALIDATION_ERROR` (400) untuk query/body asing;
  500 tanpa fallback. `HANDYMAN_PIC_WORKSPACE_RESOURCE_NOT_FOUND` sudah dideklarasikan (A01 §10
  C15) untuk permukaan baca 03D — belum ada route yang memancarkannya di PART ini.
- Semua respons `Cache-Control: no-store`.

## 5. Lifecycle token dan integrasi BM Super App (sisi BM)

State sesi: `ADMITTED → (EXPIRED | REVOKED | INVALIDATED_BY_AUTHORITY)`, tanpa lintasan keluar
dari state terminal (guard UPDATE/DELETE menegakkan ini di DB, bukan hanya di kode).

1. BM menyiapkan SATU integration baris untuk kanal PIC dengan `actor_capability = 'TENANT_PIC'`
   dan secret di `HANDYMAN_HANDOFF_SECRET_<KODE-NORMAL>` — konvensi nama yang sama dengan kanal
   handoff/care yang sudah ada. Provisioning adalah tindakan administratif (surface handoff runtime
   atau SQL), bukan bagian dari PART ini.
2. Untuk tiap PIC yang akan memakai workspace, BM menyusun assertion, menandatangani byte
   kanonik-nya (stable JSON, kunci terurut rekursif), dan mengirim `POST`. `assertionId` bersifat
   **single-use per integration**: retry byte yang sama setelah 401 apa pun = replay = 401.
   Karena itu BM wajib membuat `assertionId` BARU untuk tiap upaya ulang, bukan mengulang request
   yang sama. Tidak ada toleransi clock skew: jam BM harus sinkron (NTP) — `issuedAt` di masa
   depan atau window > 5 menit ditolak.
3. `workspaceToken` (`hpw_` + 43 karakter) adalah SATU-SATUNYA nilai yang boleh dilihat klien.
   BM relay token ini ke user-nya sendiri lewat kanal terautentikasi BM; token tidak pernah masuk
   URL, query, fragment, referrer, cursor, atau log.
4. Pemakaian: setiap panggilan ke route PIC mengulang validasi otoritas (lihat §2). Tidak ada
   refresh, tidak ada sliding renewal, tidak ada perpanjangan TTL dari input. Kedaluwarsa
   default 15 menit; `HANDYMAN_PIC_WORKSPACE_TTL_SECONDS` hanya boleh MEMENDEKKAN (di-clamp ≤ 900).
5. 401 di rute mana pun = sinyal BM untuk melakukan admission baru dan me-relay token baru.
   Logout eksplisit (`DELETE`) dianjurkan saat user BM menutup layar PIC, supaya jejak audit
   menutup sesi lebih cepat daripada menunggu kedaluwarsa.
6. Kapasitas `canDecide` diturunkan dari kredensial itu sendiri: admission tanpa `tenantPicId`
   menghasilkan sesi read-only yang secara struktural tidak bisa mendukung keputusan (0442).
   Sisi keputusan (route decide) ada di **03E** dan sengaja tidak ada di sini.

## 6. Dependensi rollout (urutan, bukan anjuran)

1. `0441` wajib sebelum `0442` (kolom ledger FK ke tabel sesi); keduanya additive, tidak ada
   rewrite data, tidak ada backfill. Urutan peel: `0442` lalu `0441`; `down()` 0442 menolak
   bila ledger sudah memakai kolom sesi → forward-fix.
2. Belum ada satu pun konsumen bisnis route PIC: **B12 TIDAK diaktifkan**, tidak ada endpoint
   quotation-decision, tidak ada pembukaan fallback staff approval, semantik decision ledger yang
   ada tidak diubah, semantik akses staf C6 tidak diubah. Karena itu PART ini tidak bisa
   di-deploy sebagai "fitur"; yang berubah di runtime hanyalah tiga route kredensial.
3. Throttle admission memakai modul login-rate-limit proses-lokal (namespace sendiri
   `handyman-pic-workspace:<socket-address>`). Di belakang load balancer, rate limit ingress
   tetap wajib — sama seperti care workspace; state per-proses bukan klaim global.
4. CORS tidak diperlukan untuk ketiga route ini (server-to-server BM↔Handyman; tidak ada browser
   yang memanggilnya). Kalau 03D/03E nanti menambahkan permukaan yang dipakai browser, origin BM
   harus masuk `CORS_ORIGINS`.
5. Urutan rilis: 03C → 03D (baca terbatasi) → 03E (decide, memakai `decided_by_pic_session_id`)
   → 03G (rekonsiliasi dokumen) → 03H (sertifikasi E2E). Sebelum 03H, tidak ada klaim journey.
6. Integrasi `TENANT_PIC` harus ADA dan ACTIF sebelum BM dapat meng-admit; capability hilang atau
   integrasi non-ACTIF mencabut sesi hidup (trigger) dan menolak admission baru — fail-closed,
   tidak ada mode "boleh dulu, dibereskan nanti".

## 7. Bukti perintah

| Perintah | Hasil |
|---|---|
| `ASENTRA_USE_EMBEDDED_POSTGRES=true npx tsx --test --test-concurrency=1 tests/handyman-pic-workspace-session.test.ts` | **25 pass / 0 fail** (PG embedded sendiri di 55560) |
| `… tests/handyman-quotation-pic-binding-migration.test.ts` (03B, +1 kasus D1 baru) | **14 pass / 0 fail** |
| `… tests/handyman-quotation-approval-binding-runtime.test.ts` (03B2) | **10 pass / 0 fail** |
| `npx tsc --noEmit` (gerbang repo) | **exit 0** |
| `tests/config-perm-01-permission-registry.test.ts` | 16/16 (modul baru tidak menambah permission; katalog tetap 357) |
| `tests/handyman-handoff-runtime` / `-http` / `-care-actor-attestation` / `care-actor-persistence` / `care-actor-resolver` / `seeds` | 7/7, 7/7, 8/8, 13/13, 10/10, 1/1 |
| `tests/handyman-quotation-decision.test.ts` | 2 pass / 8 fail — **sama dengan baseline controlled standstill**; pesan kegagalan: `Only an attested Tenant PIC may decide a Handyman quotation.` (DB floor, bukan regresi PART ini) |
| `tests/openapi-contract.test.ts`, `tests/mobile-openapi-completeness.test.ts` | 5/1 dan 3/2 — **identik sebelum dan sesudah** patch OpenAPI (diverifikasi dengan menaruh ulang `openapi.yaml` versi HEAD); tidak satu pun pesan gagal menyebut `/handyman/pic/session` |
| Parse YAML `openapi.yaml` + census | valid; 1355 path; `post/get/delete` terdaftar; 4 skema `PicWorkspace*`; `securitySchemes.picWorkspaceSession` ada |
| `tests/r08-*`, `tests/fx02-part02…` tip-pin | merah di baseline (sudah tercatat di record 03B), tidak disentuh |

Catatan integritas bukti: `tsconfig.json` meng-`exclude` `tests/`, jadi `npm run typecheck`
TIDAK memeriksa file test. Ketiga file test (baru + 2 yang direparasi) maka dicek terpisah
dengan `npx tsc --noEmit` ad-hoc yang mengikutkan `tests/`; dua temuan nyata (satu cast dan satu
readonly-tuple) diperbaiki, sisanya artefak `moduleResolution` ad-hoc tersebut. Harness
03B/03B2 yang diperbaiki di PART ini: mint sesi PIC lewat SERVICE (bukan id palsu) karena 0442
memang menuntutnya; `SAVEPOINT`/`ROLLBACK TO` per kasus negatif supaya 25P02 tidak menyamar
menjadi "CHECK menolak"; scan string terlarang di sumber modul kini meng-strip komentar lebih
dulu (prosa modul menyebut nama yang justru TIDAK boleh dipanggil). Tidak ada satu pun fallback
yang ditambahkan ke source untuk membuat test hijau.

## 8. Rekonsiliasi item 12 — kontrak audit `reason`/`note` 03B2 (dokumen saja)

03B2 mencatat **B2-D3**: `note` (bind) dan `reason` (revoke) hidup di *operational journal*, bukan
sebagai kolom ledger, karena 0437 tidak punya kolom narasi dan `recordOperationalEvent` adalah
otoritas tunggal untuk itu. 03C **mengikuti kaidah yang sama dan tidak membukanya kembali**:

- Journal sesi PIC membawa id + window saja. Tidak ada kolom `note`/`reason`/`revoked_reason` di
  `handyman_pic_workspace_sessions`, dan **tidak ada input narasi sama sekali** di admission
  maupun logout. Alasannya normatif, bukan kemalasan: logout kredensial bukan tindakan
  administratif seseorang, melainkan pelepasan kredensial — menaruh "alasan" di sana akan
  menyiratkan seorang operator bisa menjelaskan retroaktif sebuah sesi, sementara yang menjelaskan
  sesi adalah assertion BM dan audit trail-nya.
- Kontras yang disengaja dengan 03B2: `POST …/approval-binding/revoke` WAJIB membawa `reason`
  karena revoke binding adalah keputusan staf yang mempengaruhi siapa yang boleh memutuskan
  (B12/§7.2 C22). Perbedaan bentuk itu (revoke-with-body vs `DELETE` tanpa body di A01 §9, yaitu
  B2-D2) tetap dilaporkan sebagai inkonsistensi antar-dokumen untuk direkonsiliasi di **03G**;
  PART ini tidak memutuskannya diam-diam dan tidak mengubah keharusan `reason` di jalur binding.
- Konsekuensi yang harus dibaca bersama: karena `reason`/`note` berada di journal, "audit event
  tanpa PII" (item 9) adalah properti journal, bukan properti ledger — persis seperti yang
  berlaku di 03B2, dan kini juga di 03C. Test §3 baris 9 menegakkannya untuk kedua event.
- Tidak ada perubahan kontrak 03B2 yang dibuat untuk rekonsiliasi ini: nol baris kode, nol kolom,
  nol pesan error berubah karena §8 ini.

## 9. Deviasi yang dicatat dari teks terbekukan (eksplisit, bukan diam-diam)

| Id | Deviasi | Alasan |
|---|---|---|
| **03C-D1** | Prefix token `hpw_` | A01 tidak menamai prefix. Preseden: care `hcw_`. Prefix adalah pembeda jenis di log/baris (rule 14), BUKAN otoritas — otoritasnya adalah tabel tempat kredensial dicari |
| **03C-D2** | Keunikan replay berupa `UNIQUE (integration_id, assertion_id)` pada baris sesi, bukan tabel replay terpisah seperti care | Satu-satunya cara menulis tombstone dan sesi secara atomik di transaksi yang sama: tidak ada jendela "sudah tercatat tapi sesi belum ada". Konsekuensi dicatat: baris tombstone tidak pernah boleh dihapus (guard menolak DELETE), dan sesi yang tercabut tidak dapat "dihidupkan ulang" |
| **03C-D3** | 0441 tidak memuat CHECK `no_revival`/`revocation_consistency` | Immutability ditegakkan `handyman_pic_workspace_guard` (UPDATE hanya untuk revocation pertama; DELETE selalu ditolak). Guard yang sama tidak bisa ditiru sebagai CHECK karena membandingkan OLD/NEW |
| **03C-D4** | Perluasan `handyman_handoff_integrations_actor_capability_check` ('TENANT_PIC') menumpang di 0441, bukan migrasi sendiri | Tabel sesi dan jalur admission sama-sama butuh kolom capability itu berisi 'TENANT_PIC'; memisahkannya menciptakan migrasi yang hanya berisi constraint bolak-balik. Perluasan ini TIDAK melonggarkan care: 'CUSTOMER_CARE' tidak berubah dan resolver care tetap menuntut capability-nya sendiri (dites: "treats TENANT_PIC as an attestation right and nothing else") |
| **03C-D5** | Klausa sesi 0442 adalah gerbang TERAKHIR cabang PIC dan sengaja tidak menilai kedaluwarsa/revoke ulang | Semua penolakan 0437/0438 yang sudah diratifikasi 03B/03B2 tetap punya preseden yang sama (terbukti: test 03B tetap hijau tanpa mengubah ekspektasi pesannya). Ledger adalah history immutabel; revoke setelah keputusan tidak boleh memalsukan siapa yang berwenang saat itu — liveness ditegakkan di setiap panggilan, di jalur service (rule 17) |
| **03C-D6** | Verb ketiga `GET /handyman/pic/session` ditambahkan | A01 §13 baris 03B menyebut `POST`/`DELETE`; owner meminta introspeksi sesi sebagai bagian item 8. Permukaan lain tidak ikut ditambah (dites: "keeps the surface credential-only") |
| **03C-D7** | BLK-2 dianggap diberi bekukan oleh directif owner ("RATIFIED-BY-OWNER-DIRECTIVE", 2026-10-11, sha `e895e0d` sebagai dasar kerja) | Teks normatif CR-HM-01 D7 TIDAK diubah; hanya pointer note di baris BLK-2 A01 §12. Konsekuensi yang harus diingat owner: pembekuan ada di record PART ini, bukan di dokumen otoritas terpisah — kalau owner ingin bentuk formal lain, itu pekerjaan dokumen di 03G |
| **03C-D8** | Tidak ada permukaan baca PIC terbatasi (03D) dan tidak ada route decide (03E) | Direktif release-safety PART ini: tidak membuka B12, tidak menambah endpoint keputusan. Kolom sesi di ledger sudah ada justru supaya 03E tidak bisa lagi menulis keputusan tanpa attribution |
| **03C-D9** | Kode `HANDYMAN_PIC_WORKSPACE_RESOURCE_NOT_FOUND` dideklarasikan tanpa pemancar | Additive sesuai A01 §10 C15 (satu-satunya bentuk error baca), supaya 03D tidak menciptakan bentuk ketiga; tidak mengubah perilaku apa pun |

## 10. Yang secara sadar TIDAK dikerjakan di PART ini

- Route decision/quotation-decision apa pun; enablement B12; perubahan semantik ledger keputusan
  yang sudah ada (hanya kolom + CHECK + klausa guard yang diminta D1); pembukaan kembali `C6`
  (akses staf); perubahan `handyman_quotation_decisions_binding_check`; perubahan bentuk
  `reason`/`note` 03B2.
- Fallback antar jenis kredensial (staf → PIC, PIC → care, care → exchange) — tidak ada, dan
  secara struktural tidak bisa ada karena masing-masing hanya membaca tabelnya sendiri.
- Kolom `idempotency_key`/`note`/`revoked_reason` di tabel sesi; `UPDATE`/`DELETE` apa pun untuk
  history sesi; pencatatan token; pencatatan PII di journal.
- Deploy produksi, migrate di environment nyata, klaim E2E selesai, klaim "PIC bisa menyetujui"
  (belum: 03E).
- Backfill/rotasi secret integrasi, provisioning self-service untuk BM (butuh keputusan owner,
  dicatat di §11).

## 11. Blocker yang masih menunggu keputusan manusia

| Id | Status | Yang dibutuhkan |
|---|---|---|
| BLK-2 | **RATIFIED-BY-OWNER-DIRECTIVE** (2026-10-11, sha `e895e0d`); pointer note ditambahkan di A01 §12 | Tidak ada lagi untuk implementasi 03C. Owner tetap dapat mengganti bentuk pembekuannya lewat dokumen otoritas terpisah di 03G tanpa mengubah kode |
| BLK-8 | TERBUKA (tidak memblokir 03C) | Preferensi TTL lebih pendek adalah knob deployment (`HANDYMAN_PIC_WORKSPACE_TTL_SECONDS`, clamp ≤ 900); keputusan UX owner tetap ditunggu |
| BLK-3 / BLK-GAP-1 / BLK-BIND-BACKFILL | TERBUKA, pemilik DBA+Operations | Pengukuran staging (rate PIC-linked, pemegang `tenant_company.manage`, request `tenant_pic_id` NULL, duplikat `idempotency_key`) sebelum klaim populasi/urutan rilis nyata |
| B2-D2 (inkonsistensi bentuk revoke) | TERBUKA, pemilik dokumen | Rekonsiliasi ADD-A §7.2 C22 vs A01 §9 di 03G; PART ini hanya melaporkan, tidak memutuskan |
| Provisioning integrasi `TENANT_PIC` + rotasi secret untuk BM | TERBUKA, owner BM+Handyman | Jalur operasional (apakah lewat surface handoff admin atau runbook SQL) dan kebijakan rotasi; tanpa ini BM tidak bisa menandatangani admission di environment nyata |

## 12. Pernyataan integritas

Seluruh perubahan PART ini additive terhadap skema dan aditif terhadap permukaan API; tidak ada
satu pun jalur yang melonggarkan MC1–MC5′, tidak ada `'USER'` yang kembali ke ledger, dan tidak
ada route bisnis yang dibuka. Tidak ada file di luar repository ini, tidak ada commit paksa, dan
tidak ada PR. Klaim pengujian terbatas pada suite terfokus yang tercantum di §7 pada satu
environment (Postgres embedded, satu instance, `--test-concurrency=1`); hasil suite DB penuh dan
verifikasi environment bersama TIDAK diklaim dan TIDAK dijalankan di sini, sesuai direktif
validasi PART ini.
