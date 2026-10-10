# W03 PART 03B — Quotation PIC Approval Schema Foundation (working record)

**Tanggal:** 2026-10-10 · **Branch:** `arena/44e8ce22-handyman-backend` · **HEAD saat kerja:** `1b0e713` (baseline bersih, `ANCESTRY_OK`, 0 behind / 27 ahead `main`)
**Tipe:** SKEMA-SAJA (fondasi). Tiga migrasi aditif + satu berkas test terfokus. **Nol** perubahan pada service, route, repository, proyeksi publik, `docs/api/openapi.yaml`, permission catalogue, role, dan seed.
**Kontrak sumber:** `CR-HM-06/A01` v1.1 RATIFIED (§6.1, §6.2, §7.1, §7.2, §13) + `CR-HM-06_ADDENDUM_A_TENANT_PIC_BINDING_AUTHORITY.md` v1.0 (§3.1, §3.2, §3.4, §4, §5, §6, §7.1) — keduanya diratifikasi di `1cdaffe` (PART 03A).
**Status klaim:** **DIPASANG DAN DIUJI pada PostgreSQL nyata; BUKAN sertifikasi, BUKAN peluncuran.** Gate B12 (bind-before-present) **tidak diaktifkan**; jalur tulis/revoke binding belum ada; keputusan PIC belum bisa dibuat oleh layanan mana pun. Yang berubah secara perilaku hanyalah: **keputusan staff baru ditolak di database** — dan itu didokumentasikan di §6 sebagai controlled standstill, bukan ditambal.

---

## 1. Baseline yang diverifikasi sebelum menulis apa pun

| Check | Perintah | Hasil |
|---|---|---|
| HEAD + branch | `git log -1` / `git --abbrev-ref HEAD` | `1b0e713` di `arena/44e8ce22-handyman-backend` |
| Worktree | `git status --porcelain` | kosong sebelum PART ini mulai |
| Ancestry ke `main` | `git merge-base --is-ancestor origin/main HEAD` | `ANCESTRY_OK` |
| Posisi branch | `git rev-list --left-right --count origin/main...HEAD` | `0 27` |
| Nomor migrasi terakhir | `ls src/database/migrations` | tertinggi `0436_…triage_permission.ts` ⇒ **0437 bebas**; setelah PART ini: 439 migrasi terdaftar (dikonfirmasi oleh query `schema_migrations` di DB nyata) |
| Permukaan yang dilindungi | `git diff --name-only 2db34f2..HEAD` (03A) | hanya 5 berkas docs; tidak ada `src/`, `tests/`, `docs/api/` |

Dibaca penuh sebelum implementasi: `CR-HM-06_DECISION_FREEZE.md` (F6 asli + blok "F6 — REVISED v1.1"), A01 §5–§7 + §13, ADD-A §1–§9, `W03_PART03A_…`, `W03_QUOTATION_PIC_APPROVAL_RECONCILIATION.md` §9; lalu migrasi `0391`, `0393`, `0394`, `0395`, `0378`, `0427`, `0431`, `0432`, `0436` sebagai sumber idiom (bukan asumsi).

## 2. Yang diimplementasikan

| Migrasi | Objek | Isi |
|---|---|---|
| `0437_handyman_quotation_approval_bindings` | tabel baru `handyman_quotation_approval_bindings` + 3 index + fungsi/trigger guard `handyman_quotation_approval_binding_guard` | anchor thread (`quotation_id → handyman_quotations`), snapshot turunan yang **dicocokkan ke baris request oleh trigger** (bukan suplai pemanggil), `tenant_pic_id`, `binding_version ≥ 1`, `supersedes_binding_id` (self-FK komposit → rantai eksplisit, bukan overwrite), `status ACTIVE/REVOKED`, jendela efektivitas, `occupancy_authority_id` NOT NULL + `space_authority_id` (wajib bila request berspace), `granted_by_user_id`, kolom revoke. Guard: **DELETE selalu ditolak; UPDATE hanya ACTIVE→REVOKED** (perbandingan `to_jsonb` dikurangi kolom revoke); INSERT memvalidasi B1/B2/B3/B4/B5, B13 (pin), B14 (versi + rantai), B18 (frozen after decision), R-1.2, MC0 |
| `0438_handyman_quotation_decision_actor_identity` | `ALTER TABLE handyman_quotation_decisions` + **recreate** guard | `decision_actor_type NOT NULL DEFAULT 'USER'`, `decided_by_tenant_pic_id`, `approval_binding_id`, `decided_by_user_id DROP NOT NULL`, CHECK `…_actor_identity_check` + `…_binding_check` (R-1.3). Fungsi yang sama (`handyman_quotation_decision_block_mutation`) diperluas dengan cabang INSERT; trigger `handyman_quotation_decision_no_write` **direcreate dengan timing `BEFORE INSERT OR UPDATE OR DELETE`** — replace-function saja tidak cukup (A01 §6.2) |
| `0439_handyman_execution_scope_actor_identity` | `ALTER TABLE handyman_execution_scopes` | `created_by_actor_type NOT NULL DEFAULT 'USER'`, `created_by_tenant_pic_id`, `created_by_user_id DROP NOT NULL`, CHECK `…_actor_identity_check`. **Tanpa** kolom binding: `quotation_decision_id NOT NULL` (`0395:34-35`) sudah merantai scope → decision → binding (ADD-A §5). **Tanpa** guard INSERT: itu langkah 03F yang terbekukan (E1–E3) |
| `src/database/migrations/index.ts` | registrasi | +3 impor, +3 entri array di ujung (0437 → 0438 → 0439) |
| `tests/handyman-quotation-pic-binding-migration.test.ts` | test terfokus | 13 test, self-boot `embedded-postgres` (PostgreSQL 18.4) saat `ASENTRA_USE_EMBEDDED_POSTGRES=true`, skip sesuai konvensi repo bila tidak ada DB |

Tidak ada berkas lain yang berubah. `git status --porcelain` di akhir kerja = 4 berkas baru + `index.ts`.

## 3. Pemetaan 12 item scope PART 03B ke bukti

| # | Item tugas | Di mana | Bukti (nama test) |
|---|---|---|---|
| 1 | Verifikasi HEAD/branch/ancestry/tree | §1 | tabel §1 |
| 2 | Baca dokumen normatif + migrasi terkait | §1 baris terakhir | kutipan §/halaman di header setiap migrasi |
| 3 | Migrasi aditif untuk binding level-thread | `0437` | `applies from scratch with the ratified shape (fresh)` |
| 4 | Lifecycle append-only: ACTIVE→REVOKED, ≤1 ACTIVE, atribusi immutable, constraint referensial | guard `0437` + `…_one_active` + `…_one_per_version` + self-FK | `keeps the binding lifecycle append-only (revoke, pin, freeze)`, `keeps exactly one ACTIVE binding per thread under concurrent writers` |
| 5 | Kolom actor-aware di ledger keputusan | `0438` | test fresh (kolumn, default, nullability, constraint) |
| 6 | Keputusan `USER` historis dipertahankan — tanpa UPDATE/backfill massal | `DEFAULT 'USER'` = backfill; nol DML di `up()` | `preserves historical USER decisions and never rewrites them` (termasuk pemindaian sumber: tidak ada `UPDATE handyman_`, `DELETE FROM handyman_`, `TRUNCATE`) |
| 7 | Rekonsiliasi `decided_by_user_id` nullable + CHECK eksklusivitas + koherensi binding | `0438` (DROP NOT NULL, dua CHECK, cabang INSERT guard) | `refuses an incoherent actor row even with the guard out of the way`, `authorises a PIC decision only through a live, coherent binding` |
| 8 | Skema Execution Scope direkonsiliasi supaya keputusan `TENANT_PIC` dapat direferensikan tanpa ledger kedua | `0439` (nol kolom baru selain identitas aktor) | `lets a scope reference a PIC decision without a second ledger (E2)` — satu join scope→decision→binding teresolusi |
| 9 | Guard waktu-INSERT di DB yang memblokir persetujuan staff baru (prospective-only) | cabang INSERT `0438` | `blocks every new non-PIC decision at the ledger (prospective-only ban)` — termasuk APPROVE **dan** REJECT, dan satu test yang memanggil `decideHandymanQuotation` asli |
| 10 | Trigger immutable yang sudah ada tetap bekerja | tidak ada perubahan nama/pesan/SQLSTATE; guard parent tidak disentuh | test yang sama: pesan `…immutable authoritative facts.` + `P0001`, `Handyman quotation identity facts are immutable`, `…roots are never deleted`, `…version facts are immutable`, `Handyman execution scopes are immutable authority records.` |
| 11 | Test migrasi terfokus: fresh, rerun, rollback-kosong, rollback-ditolak-saat-berisi, pelestarian legacy, actor invalid, binding invalid, konkurensi | berkas test | `is rerun-safe and re-entrant`, `rolls back while empty, then restores forward`, `refuses to roll back a populated ledger (forward-fix only)`, `enforces binding eligibility (B1-B5, MC0, snapshot coherence, R-1.2)`, `freezes a decided thread and leaves existing immutability intact (B18)` |
| 12 | Dokumentasi urutan migrasi, penolakan rollback, strategi forward-fix | §5 dokumen ini | — |

Hasil run penuh test ini: **13/13 pass** di PostgreSQL 18.4 nyata dengan rantai 439 migrasi diterapkan dari nol (`# pass 13 # fail 0 # skipped 0`, 23.9s).

## 4. Deviasi yang dicatat dari teks terbekukan (eksplisit, bukan diam-diam)

| # | Teks beku | Yang dilakukan | Alasan |
|---|---|---|---|
| D1 | A01 §6.1 menambahkan `decided_by_pic_session_id UUID REFERENCES handyman_pic_workspace_sessions (id)` ke ledger keputusan (juga di §7.1 untuk scope) | **kolum sesi DITUNDA**; kedua CHECK dipakai dalam bentuk tanpa klausa sesi | Tabel sesi belum ada — ia milik PART sesi ("03B — session foundation" di §13). Menambahkan FK ke tabel yang tidak ada gagal di migrasi; menambahkan UUID tanpa FK menciptakan kolom "kredensial" yang tidak bisa dibuktikan, lebih buruk daripada tidak ada. **Kewajiban PART sesi nanti:** `ADD COLUMN … REFERENCES handyman_pic_workspace_sessions (id)` lalu DROP + re-create `…_actor_identity_check` (dan `handyman_execution_scopes_actor_identity_check`) dalam bentuk §6.1/§7.1 penuh, plus menambahkan klausa sesi ke guard INSERT. Selama belum ada, tidak ada jalur layanan yang bisa memproduksi baris `TENANT_PIC`, sehingga penundaan ini tidak meninggalkan celah |
| D2 | A01 §6.2 menulis fungsi baru bernama `handyman_quotation_decision_guard()` | nama fungsi **dipertahankan**: `handyman_quotation_decision_block_mutation()` | instruksi normative di §6.2 sendiri adalah "rename-by-replacement: pertahankan nama objek yang ada supaya runbook/test yang menyebutnya tetap akurat; yang tumbuh hanya daftar timing". Membuat fungsi baru akan meninggalkan fungsi yatim dari `0394` |
| D3 | A01 §6.2 body guard memuat `M = {root author, version author}` | `M` diperluas dengan **`binding.granted_by_user_id`** | diwajibkan ADD-A §6 MC1' (granter menutup loop "memilih penanda-tangan yang adalah diri sendiri"). Body §6.2 ditulis sebelum addendum; ADD-A §6 adalah teks yang diratifikasi setelahnya |
| D4 | Item tugas 03B tidak menyebut pin B13 | guard INSERT `0437` **menolak re-binding** saat ada versi `ISSUED` yang belum diputuskan | ini lantai DB dari B13 (ADD-A §3.4); murah (existence check di index `0393`) dan mencegah pergantian orang yang berhak menyetujui di tengah presentasi. Penolakan di level **layanan** dengan kode error yang benar tetap pekerjaan 03B2. Revoke tetap selalu boleh (B15) dan diuji |
| D5 | Label PART | PART ini = irisan skema dari **03B2 (ADD-A §3)** + **03C (A01 §6.1/§6.2, §7.1)**, tanpa gate B12 dan tanpa route | instruksi tugas 03B mendefinisikan scope ini; dependensi §13 ("03B2 sebelum 03C karena FK ledger harus menunjuk tabel yang sudah ada") dihormati **di dalam** urutan 0437 → 0438 |
| D6 | ADD-A M3 menuliskan satu kondisi `down()` gabungan | ditolak per-migrasi: `0437.down()` melihat tabelnya sendiri; `0438.down()` melihat `decision_actor_type <> 'USER' OR approval_binding_id IS NOT NULL OR decided_by_tenant_pic_id IS NOT NULL` | `down()` dieksekusi LIFO satu per satu; setelah `0438` di-rollback, kolumnya sudah tidak ada sehingga `0437` tidak boleh mereferensikannya. Urutan LIFO menjaga makna M3 utuh |

## 5. Urutan migrasi, rollback, dan strategi forward-fix

**Urutan dan mengapa.** `0437` (tabel binding) → `0438` (ledger keputusan + guard) → `0439` (ledger scope). 0438 tidak boleh mendahului 0437 karena `approval_binding_id REFERENCES handyman_quotation_approval_bindings (id)`; 0439 belakangan karena tidak ada yang mereferensikannya. Urutan ini diuji sebagai invarian (`applies from scratch…` membandingkan indeks di array `migrations`, dan assert bahwa 0439 adalah entri terakhir).

**Idempoten / re-entrant.** Semua `up()` ditulis `IF NOT EXISTS` / `CREATE OR REPLACE FUNCTION` / `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`, dan constraint ditambahkan lewat blok `DO` yang memeriksa `pg_constraint`. `migrateUp()` kedua kali = no-op, dan memanggil ulang ketiga `up()` di dalam satu transaksi tidak menghasilkan duplikat objek maupun error (diuji; `pg_trigger` tetap 1 baris untuk guard ledger).

**Rollback saat kosong.** `migrateDown()` mengembalikan `0439…`, kolom hilang, `created_by_user_id` kembali `NOT NULL`; `migrateUp()` kemudian menerapkan tepat satu migrasi itu kembali. `down()` 0438 + 0437 diuji dalam transaksi yang di-rollback: tabel binding benar-benar hilang, guard ledger kembali ke timing `BEFORE UPDATE OR DELETE` (0394), dan ROLLBACK mengembalikan semuanya.

**Rollback saat berisi = DITOLAK.** `0437.down()` melempar bila ada satu baris binding; `0438.down()` bila ada baris non-legacy; `0439.down()` bila ada scope beralamatkan PIC. Semuanya `ERRCODE '23514'` dengan pesan yang diawali `Rollback refused:` (diuji). Ini keputusan sadar dan **tidak** meniru asimetri `0431.down()` (yang menjatuhkan kolom tanpa memeriksa dan tidak pernah memulihkan NOT NULL).

**Strategi forward-fix.** Karena rollback ditolak begitu data produksi masuk, perbaikan pasca-deploy dilakukan maju: (a) tabel/kolumn hanya ditambah, tidak pernah di-rename; (b) aturan guard yang salah ditulis ulang lewat migrasi baru dengan `CREATE OR REPLACE FUNCTION` (nama objek stabil, jadi tidak ada runbook yang patah); (c) baris binding yang salah tidak pernah di-UPDATE — dibatalkan dengan revoke lalu baris berversi berikutnya; (d) CHECK yang perlu diperluas (mis. klausa sesi D1) di-drop dan di-re-add dalam migrasi yang sama saat kolumnnya ditambahkan; (e) kegagalan guard tidak pernah "diperbaiki" dengan pelonggaran CHECK — bila sebuah write sah tertolak, itu temuan kontrak dan naik sebagai blocker, bukan alasan men-disable trigger.

## 6. Controlled standstill — dilarang diam-diam, dilaporkan terukur

Guard INSERT `0438` menolak **setiap** baris keputusan baru yang kelasnya bukan `TENANT_PIC`. Konsekuensi yang sekarang berlaku di HEAD ini:

- `POST /api/v1/handyman/quotation-versions/:id/decision` (satu-satunya jalur staff) **masih terpasang dan masih lolos RBAC** — route tidak dihapus, tidak ada permission baru — tetapi gagal saat INSERT di ledger dengan pesan guard. Karena perubahan service bukan bagian PART ini, error muncul sebagai **500 INTERNAL_SERVER_ERROR** (bukan 409 `HANDYMAN_QUOTATION_DECISION_CONFLICT`).
- Berlaku untuk **APPROVE dan REJECT**: yang dilarang adalah kelas aktornya, bukan kosakata keputusannya.
- Tidak ada fallback: tidak ada "boleh kalau belum ada binding", tidak ada penanda mode, tidak ada jalur tulis langsung. Sesuai instruksi tugas dan keputusan 7.
- Replay tetap aman: keputusan yang **sudah tercatat** dibaca, tidak ditulis ulang (`handyman-quotation-decision.service.ts:169-187`), sehingga riwayat dan idempotensi tidak berubah makna.
- Karena `insertDecision` mendahului `insertScope` dalam transaksi yang sama, **scope baru juga tidak bisa lahir** dari jalur staff (E5). Tidak ada keputusan otomatis dan tidak ada binding otomatis di mana pun.
- Refinement (menolak di service dengan kode 409/404 yang benar, plus B12 gate) adalah pekerjaan **03C/03B2**, bukan tambalan di sini.

**Dampak terukur** (DB nyata, dijalankan langsung setelah migrasi; bukan prediksi):

| Suite terfokus yang dijalankan | Hasil | Penyebab gagal |
|---|---|---|
| `tests/handyman-quotation-decision.test.ts` | 10 test: **2 pass / 8 fail** | `Only an attested Tenant PIC may decide a Handyman quotation.` |
| `tests/handyman-quotations-api.test.ts` | 10 test: **7 pass / 3 fail** | `500 !== 201` pada test APPROVE/REJECT HTTP; log server: pesan guard yang sama, stack `handyman-quotation-decision.repository.ts:59` di `insertDecision` |
| `tests/handyman-arrival-results.test.ts` (konsumen CR-HM-07, memakai fixture bersama) | 10 test: **0 pass / 10 fail** | sama — `scopeFixture()` menyetujui sebagai staff untuk memperoleh Execution Scope |

Ekstrapolasi yang **dianalisis, belum diukur satu per satu**: 55 berkas test mengimpor `tests/helpers/handyman-fixtures.ts` (yang `scopeFixture()`-nya memanggil `decideHandymanQuotation` dengan user staff) dan 39 berkas memanggil `decideHandymanQuotation` langsung; A01 §6.3 memperkirakan "existing 54 quotation tests akan gagal by design", dan ADD-A §7.3 menegaskan perubahan jalur issue menyentuh **lebih banyak** test daripada A01 saja. Semua kegagalan itu adalah konsekuensi yang diharapkan dari ratifikasi, **bukan regresi**, dan tidak boleh "diperbaiki" dengan memberi staff wewenang kembali. Yang benar: 03C/03E mengirim principal PIC + service path, lalu fixture diubah memakai jalur yang sah (atau fixture menyetujui lewat insert kelas `TENANT_PIC` yang sah, bukan bypass). Full suite **tidak** dijalankan pada PART ini (instruksi); angka di atas adalah hasil tiga suite terpilih.

## 7. Bukti perintah

| Perintah | Hasil |
|---|---|
| `npx tsc --noEmit` (script `typecheck` repo, mencakup `src/**`) | **bersih**, exit 0 |
| `ASENTRA_USE_EMBEDDED_POSTGRES=true npx tsx --test --test-concurrency=1 tests/handyman-quotation-pic-binding-migration.test.ts` | `# tests 13 # pass 13 # fail 0 # skipped 0` (PostgreSQL 18.4, 439 migrasi dari nol, 23.9s) |
| query DB `SELECT count(*) FROM schema_migrations` di DB uji | `439` — seluruh rantai termasuk 0437/0438/0439 terapan |
| run tanpa DB (`ensureTestDatabase()` → null) | 13 test **skip** rapi, exit 0 — konvensi repo tetap utuh untuk runner yang tidak punya DB |
| tiga suite terdampak (§6) | angka terukur di §6 |
| `git status --porcelain` | 4 berkas baru + `src/database/migrations/index.ts`; tidak ada `src/modules/**`, `docs/api/**`, `package.json`, `tests/helpers/**` yang berubah |
| `tests/r08-part01b…`, `r08-part02b…` (`migrations.length === 348`) | **sudah merah sebelum PART ini** (diwarisi sejak sebelum 03A; dicatat agar tidak disalahkan pada PART ini) |

## 8. Yang secara sadar TIDAK dikerjakan di PART ini

- Gate **B12** (tolak presentasi tanpa binding aktif) di `issueHandymanQuotationVersion` — C17, 03B2. Tabel binding karenanya **dorman**: tidak ada kode `src/**` yang menulisnya.
- Modul `handyman-quotation-approval-bindings/` + route staff bind/revoke/read (C21/C22) dan proyeksi `approvalBindingId` (C20) — tidak ada endpoint baru sama sekali.
- Apapun untuk sesi PIC: `handyman_pic_workspace_sessions`, admission/revoke, kolom `decided_by_pic_session_id` (D1).
- Guard INSERT Execution Scope E1–E3 (03F) — sengaja, supaya jalur staff yang masih hidup tidak diubah diam-diam oleh PART skema.
- Perbaikan pesan error HTTP (409/404), `Deprecation` pada route staff (S1), dan pemutakhiran fixture bersama.
- BLK-7 (idempotensi global) tidak ditumpangkan (M6); `handyman_quotation_versions` tidak disentuh (BLK-ISSUER tetap opsional); tidak ada perubahan `request.tenant_pic_id`, C6, BE-02G, `docs/api/openapi.yaml`, permission catalogue, atau journey v1.3.
- Full regression suite tidak dijalankan (instruksi). Angka populasi tetap **UNVERIFIED** — tidak ada query agregat staging yang dilakukan pada PART ini.

**Syarat masuk PART berikutnya.** 03B2 (gate B12 + route tulis/baca): mulai dari tabel yang sudah ada, tinggal menambahkan service + assertion `0393`/`0395`; jangan memindahkan aturan guard ke service saja (B20). 03C-proyeksi: tambahkan `approvalBindingId` read-only dan `decidedByUserId` nullable di OpenAPI (03G). PART sesi: kerjakan D1 (kolumn + re-create dua CHECK + klausa guard) **sebelum** 03E membuka jalur keputusan PIC, karena tanpa sesi tidak ada kredensial yang bisa diaudit.

## 9. Blocker yang masih menunggu keputusan manusia

| ID | Butuh keputusan dari | Memblokir | Status |
|---|---|---|---|
| BLK-GAP-1 | Product owner (release sequencing) | penutupan jalur staff di rilis yang sama vs standstill; 03E | **P0 terbuka**. PART ini membuatnya konkret: tiga suite terdampak terukur di §6 |
| BLK-BIND-BACKFILL | Product owner + DBA | urutan rilis B12 (jangan menyalakan gate sebelum kebijakan backfill binding) | **P0 for rollout** sejak 03A; makin mendesak: begitu B12 dinyalakan tanpa binding, tenant tidak bisa mempresentasikan maupun meminta keputusan |
| BLK-2 (otoritas sesi vs CR-HM-01 D7) | Architecture | PART sesi (D1) | terbuka; D1 tidak bisa ditutup tanpanya |
| BLK-3 (jumlah populasi agregat staging) | DBA | penggunaan angka apa pun di dokumen | tetap UNVERIFIED |
| BLK-BIND-SCOPE | Architecture (registry gate) | permission `…:approval-binding:manage` | ditunda by design (B8: `tenant_company.manage` + BE-02G) |

## 10. Pernyataan integritas

Record ini adalah working record PART skema, bukan sertifikasi. Semua klaim struktural dapat dilacak ke migrasi/test di HEAD ini dan ke §/baris yang dikutip di header setiap berkas. Yang **diklaim**: tiga migrasi aditif terpasang bersih pada PostgreSQL nyata, lifecycle binding dan actor identity sesuai kontrak ratified, guard waktu-INSERT menolak persetujuan staff baru, riwayat `USER` utuh tanpa satu pun UPDATE, rollback kosong bekerja dan rollback berisi ditolak. Yang **tidak diklaim**: jalur PIC hidup, gate B12 aktif, kontrak OpenAPI mutakhir, atau suite hijau — dan ketidakcocokan test yang terdokumentasi di §6 sengaja dibiarkan sebagai standstill terkendali, bukan ditambal dengan fallback.
