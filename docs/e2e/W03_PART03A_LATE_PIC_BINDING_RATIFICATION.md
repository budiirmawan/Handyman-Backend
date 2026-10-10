# W03 PART 03A — F6 Ratification & Late PIC Binding Authority (working record)

**Tanggal:** 2026-10-10 · **Branch:** `arena/44e8ce22-handyman-backend` · **HEAD saat kerja:** `2db34f2` (sesuai expected HEAD)
**Tipe:** DOCUMENTATION ONLY. Nol perubahan pada `src/`, `tests/`, `src/database/migrations/`, `docs/api/`. Tidak ada Docker, tidak ada PostgreSQL, tidak ada full suite.
**Yang diratifikasi:** `CR-HM-06/A01` v1.0 → **v1.1** (amandemen F6) + **`CR-HM-06_ADDENDUM_A_TENANT_PIC_BINDING_AUTHORITY.md` v1.0** (otoritas binding PIC akhir). Revisi freeze tercatat eksplisit di `CR-HM-06_DECISION_FREEZE.md` (blok "F6 — REVISED v1.1"; teks F6 asli dipertahankan verbatim).
**Status klaim:** **FROZEN AS CONTRACT** — nol kontradiksi P0 di dalam kontrak. **BUKAN** sertifikasi. Satu blocker P0 tetap terbuka dan dilaporkan: **BLK-GAP-1** (kontinuitas approval saat cutover). Dokumen ini tidak mengklaim FROZEN untuk urutan rilis.

---

## 1. Disposition 9 keputusan yang diratifikasi

| # | Keputusan | Ditempatkan | Efek pada kontrak |
|---|---|---|---|
| 1 | Limited authenticated PIC session via secure BM handoff | A01 A1, §4–§5 (S1–S22) | tidak berubah dari v1.0; masih butuh freeze otoritas sesi (BLK-2) |
| 2 | Approval komersial hanya oleh TENANT_PIC | A01 A4/A5, §6.2 INSERT guard, ADD-A B9 | binding memilih penanda-tangan, **bukan** menandatangani |
| 3 | PIC **tidak wajib** saat Customer Care intake | ADD-A §1; intake tidak berubah | `0378` `tenant_pic_id` tetap nullable; **tidak ada** precondition baru di request |
| 4 | PIC approver boleh diikat **setelah intake, sebelum presentasi** | ADD-A B12 (gate di `issueHandymanQuotationVersion`) + B13 pin | inilah yang menyelesaikan F-06 |
| 5 | Binding authoritative, audited, scoped, tak berubah setelah keputusan | ADD-A §3.1 (append-only + granter + jendela), B1–B5 (scoped), B18 (frozen after decision), `approval_binding_id` di ledger | rantai audit: decision → binding → granter → occupancy snapshot |
| 6 | Tanpa perubahan diam-diam ke request immutable / ledger historis | ADD-A §2 (anchor request dan version ditolak), A01 A8/A9 | `request.tenant_pic_id` **tidak pernah** ditulis; baris `USER` historis tidak ditafsir ulang |
| 7 | Tidak ada staff approval fallback | A01 §6.2 (INSERT menolak kelas `USER`), ADD-A B9 | jendela rilis tetap harus diakui → **BLK-GAP-1** |
| 8 | Maker-checker fail-closed | ADD-A §6 MC0–MC5' | `M` kini memuat **granter binding**; gagal-evaluasi = tolak |
| 9 | `handyman_quotation_decisions` tetap satu-satunya ledger keputusan | ADD-A §5 (satu kolom additif), §7.1 M1 | objek baru hanya **tabel binding** (bukan ledger keputusan) |

## 2. Jawaban atas 11 item scope

| Item | Jawaban | Di mana |
|---|---|---|
| 1 Verifikasi HEAD/branch/tree | `2db34f2` · branch sesi · tree bersih sebelum dokumen ini | §9 |
| 2 Review F-06 + constraint request/quotation/scope | 12 constraint diverifikasi satu per satu; dua kandidat anchor **dibuktikan** tak layak | §3, §4 |
| 3 Desain binding authoritative (sumber, eligibility, effective period, tenant/building/occupancy, versi, revoke, reassignment) | B1–B5 (eligibility), `effective_from/until`, `occupancy_authority_id` (bukti, bukan otoritas), `binding_version` + `supersedes_binding_id`, B14/B15/B16 | ADD-A §3 |
| 4 Request vs quotation version | **Keduanya ditolak; anchor = `handyman_quotations` (thread)** — dibuktikan invariant, bukan preferensi | §3 |
| 5 Bagaimana `tenantPicId=NULL` memperoleh approver tanpa memalsukan attribution | binding = fakta **baru** yang terpisah; attribution dan kolom lineage tidak disentuh; R-1.2 melarang binding yang bertentangan dengan PIC yang sudah diatestasi BM | ADD-A §5, §1 |
| 6 Rekonsiliasi CHECK ledger + Execution Scope + trigger immutable | `approval_binding_id` + CHECK-nya di `ALTER` yang sama; scope **tanpa kolom baru** (rantai `quotation_decision_id` sudah cukup); guard decision/ scope direcreate dengan cakupan INSERT | A01 §6.1/§6.2 + ADD-A §5, M2 |
| 7 Maker-checker identity equivalence, finalisasi | `M = {root author, version author, **granter**}`, `C = {pic, pic.user_id}`; MC0 menolak "memilih diri sendiri sebagai penanda-tangan" | ADD-A §6 |
| 8 Actor/session trust boundary + replay protection | tidak diubah addendum; tetap S1–S22 A01 §4–§5 (HMAC, tombstone `(integration, assertion)`, TTL ≤900s, hash-only, no-fallback antar jenis token) | A01 §4–§5 |
| 9 Migration safety, backward compat, consumer impact | M1–M6 + C17–C24 + compatibility matrix (termasuk biaya jujur: fixture issue ikut berubah) | ADD-A §7 |
| 10 Ratifikasi dengan revisi eksplisit + catatan governance | blok "F6 — REVISED v1.1" di freeze (asli utuh), status A01 → RATIFIED, footer freeze mencatat v1.1 | §5 |
| 11 Coding sequence + acceptance criteria | §6 (03B…03H, AC-19…AC-36) | §6 |

## 3. Kenapa request dan version bukan anchor (invariant yang membuktikan, bukan opini)

| Bukti | Isi | Konsekuensi untuk anchor |
|---|---|---|
| `0378:37-38` | `channel_attribution_id UUID NOT NULL UNIQUE REFERENCES handyman_channel_attributions (id)` | request adalah **cermin** attribution yang append-only + ber-guard no-borrow (`0427`). Menulis `request.tenant_pic_id` belakangan = merevisi apa yang BM atestasi → ditolak keputusan 6 |
| grep update path | tidak ada satu pun statement `UPDATE handyman_service_requests` yang menulis `tenant_pic_id` | kolom itu faktanya create-time-only; menjadikannya mutable mengejutkan setiap pembaca lama (C6, Operations Queue, SLA) |
| `0378:71-73` | `CHECK (status IN ('INTAKE'))` — "frozen D3", triage milik CR-HM-03 | status request **tidak tersedia** sebagai gerbang eligibility → gerbangnya harus state quotation (B7) |
| `0391` header + `:79-113` | UPDATE root diblokir kecuali `updated_at`; UPDATE version hanya kolom proyeksi (`status`, `valid_until`, `updated_at`); guard berupa daftar kolom | menambah kolom "binding" ke version = kolom itu writable diam-diam, atau memaksa perluasan guard di tabel yang tidak boleh disentuh addendum |
| `0391` constraints | `handyman_quotations_request_unique UNIQUE (handyman_request_id)` | thread = request secara kardinalitas ⇒ **anchor thread menjangkau sebatas request tanpa menyentuh request** |
| `0393` | `CREATE UNIQUE INDEX … ON handyman_quotation_versions (quotation_id) WHERE status='ISSUED'` | invariant "maksimal satu ISSUED per thread" **sudah DB-enforced** ⇒ aturan pin B13 murah dan deterministik |
| `0432` | `handyman_care_actor_permission_grants`: `ACTIVE→REVOKED`, partial unique one-ACTIVE, guard menolak DELETE/non-revoke | idiom repo yang persis untuk binding: history, bukan kolom mutable |
| `handyman-service-request.service.ts:232` | request menurunkan `tenantPicId` dari attribution | membuktikan lineage adalah satu-satunya sumber hari ini — dan oleh karenanya buntu (F-06) |
| `handyman-quotation-lifecycle.service.ts:85,234` | `issueHandymanQuotationVersion`, `supersedeHandymanQuotationVersion` | titik penegakan B12 (presentasi) dan jalur pemulihan B16 (revisi) |
| `handyman-quotation-access.ts:23-41` | BE-02G exact-Building guard thread | otoritas granter B8 memakai guard yang sudah ada, tidak melebarkan apa pun (A01 A7) |
| `tenant-pic.repository.ts:47-52` + `handoff-context.service.ts:91-100` | PIC lookup by PK; resolusi PIC dengan cek ACTIVE dan keanggotaan tenant | B1/B2 memakai resolver yang sama; tidak ada master baru |
| `care-create-exchange.service.ts:26-31` | whitelist body create-care = `tenantCompanyId, buildingId, spaceId` | asal F-06; addendum **tidak** mengubahnya (keputusan 3 membiarkan intake tanpa PIC) |

## 4. Yang ditolak atau ditunda secara sadar (supaya tidak "diselesaikan" diam-diam nanti)

1. **Menulis `request.tenant_pic_id`** — ditolak (§3 baris 1–3). Kalau kelak ada yang mengusulkannya sebagai "perbaikan kecil", dia melanggar keputusan 6 dan invariant attribution.
2. **Kolom binding di `handyman_quotation_versions`** — ditolak: guard 0391 adalah daftar kolom sehingga kolom baru writable diam-diam, dan authority terduplikasi per versi.
3. **Binding oleh Customer Care workspace principal** — ditunda (BLK-CARE-BIND), bukan ditolak permanen: granter masuk `M`, dan granter non-User membuat kesetaraan identitas tak terbukti tanpa aturan lintas-namespace baru.
4. **Permission code khusus untuk binding** — ditunda (BLK-BIND-SCOPE) karena menyentuh katalog + gate registry di PART ber-kode; V1 memakai `tenant_company.manage` + BE-02G.
5. **Bulk auto-backfill binding untuk thread lama** — tidak diputuskan di sini (BLK-BIND-BACKFILL); hanya agregat yang boleh mengukur, dan tidak ada angka yang saya klaim. Termasuk tidak diputuskan: **kapan B12 diaktifkan** (lihat §7 baris BLK-BIND-BACKFILL) - 03B2 boleh mendarat sebagai tabel+guard+rute dark; gate issue tidak.
6. **Mengklaim FROZEN untuk urutan rilis** — tidak dilakukan; BLK-GAP-1 terbuka.

## 5. Ratifikasi: perubahan persis di dokumen governance

| File | Perubahan | Jenis |
|---|---|---|
| `CR-HM-06_DECISION_FREEZE.md` | blok "F6 — REVISED v1.1" + penanda di baris status + catatan footer; **teks F6 asli utuh verbatim**; tabel Frozen tokens lama **tidak** ditulis ulang (token baru hidup di blok revisi) | revisi eksplisit berlabel (+56/−1; −1 = baris status yang diperluas, bukan konten hilang) |
| `CR-HM-06_AMENDMENT_01_…` | v1.0 → v1.1: status RATIFIED; §6.1 menambah `approval_binding_id` + CHECK; §6.2 aturan koherensi diganti R-1.1; §8 `M` + MC0; §9 tiga rute binding + field decision; §12 BLK-1 RESOLVED / BLK-5 SUPERSEDED; §13 part 03B2 + dependensi; §14.2 status pointer | revisi eksplisit berlabel |
| `CR-HM-06_ADDENDUM_A_…` | baru — B0–B20, R-1, MC0–MC5', M1–M6, C17–C24, compat matrix, blocker | kontrak normatif |
| `HANDYMAN_BUSINESS_JOURNEY_v1.3_FROZEN.md` | **tidak disentuh**; OD-7 (siapa berhak menetapkan approver setelah intake) diajukan ke pemilik kontrak bisnis | sengaja tidak diedit |
| `docs/e2e/W03_PART02_…` §6 | tidak diedit; baris BLK-1/BLK-5 di sana **digantikan** oleh §7 dokumen ini | jejak audit dipertahankan |

## 6. Coding sequence + acceptance criteria (lanjutan AC-1…AC-18 PART 02)

Urutan: **03A ✓ (PART ini) → 03B (sesi) → 03B2 (binding) → 03C (ledger) → 03D (baca PIC) ∥ 03E (decide + soft-close staff) → 03F (hardening hilir) → 03G (OpenAPI) → 03H (sertifikasi)**.
03B2 **harus** sebelum 03C (FK `approval_binding_id`) dan sebelum 03E (tanpa binding, approver tidak pernah ada). 03E tidak boleh shipped sebelum BLK-GAP-1 dijawab; **B12 (gate issue) tidak boleh menyala sebelum kebijakan BLK-BIND-BACKFILL diputuskan** - kalau tidak, presentasi quotation berhenti untuk semua tenant yang belum punya binding.

| PART | Isi (ringkas) | Acceptance criteria baru |
|---|---|---|
| **03B2** | `handyman_quotation_approval_bindings` + guard; B1–B5; B12 issue-gate; B13/B14/B15/B16; B18; rute staff POST/DELETE/GET; modul `handyman-quotation-approval-bindings` | **AC-19** hanya satu baris `ACTIVE` per thread (partial unique); binding kedua tanpa revoke lebih dulu → gagal. **AC-20** INSERT menolak PIC non-ACTIF, PIC tenant lain, tidak ada occupancy efektif, dan request ber-`space_id` tanpa relasi space aktif. **AC-21** R-1.2: binding yang bertentangan dengan lineage PIC yang sudah ada → 409. **AC-22** `supersede` ditolak selama ada versi `ISSUED` belum diputuskan; **diperbolehkan** saat DRAFT dan saat versi sudah SUPERSEDED/EXPIRED/REJECTED. **AC-23** revoke selalu berhasil (termasuk saat ISSUED) dan setelah itu keputusan → 401/404 seragam, tanpa fallback ke snapshot. **AC-24** begitu ada baris keputusan, semua tulis binding untuk thread itu ditolak guard (B18). **AC-25** endpoint binding menolak field selain `{tenantPicId, effectiveUntil}`. **AC-26** granter = user yang terlink ke PIC target → ditolak di binding **dan** di decision (MC0). **AC-27** `GET` binding hanya mengekspos id/status/jendela/granter id (tanpa nama, tanpa kontak). **AC-28** issue tanpa binding aktif → ditolak; dengan binding aktif → sukses (B12) |
| **03C** | ledger additif + guard INSERT (A01 §6 + R-1) | **AC-29** `approval_binding_id` wajib untuk `TENANT_PIC` dan harus NULL untuk `USER` (CHECK). **AC-30** decision yang menunjuk binding non-ACTIF atau binding thread lain → ditolak trigger. **AC-31** `down()` menolak bila binding atau baris `TENANT_PIC` sudah ada (M3) |
| **03D** | baca PIC terbatas | **AC-32** read PIC menampilkan state binding sebagai alasan mengapa sebuah versi bisa/tidak diputuskan (id saja), tanpa membocorkan granter ke pihak tanpa otoritas baca |
| **03E** | decide PIC + soft-close staff | **AC-33** end-to-end: intake tanpa PIC → bind → issue → sesi PIC → approve → decision (`TENANT_PIC`) + scope + 2 event dalam satu tx. **AC-34** setiap fixture yang memanggil issue butuh binding; regresi test quotation diperbaiki **dengan binding**, bukan dengan melebarkan permission |
| **03F** | hardening hilir (E1–E3 DB guard) + regresi konsumen scope | **AC-35** INSERT scope yang menunjuk keputusan `USER` → gagal; `0396`–`0422` tetap hijau tanpa logika baru |
| **03G** | OpenAPI: 3 rute binding + field decision/scope baru | **AC-36** skema menandai `approvalBindingId` read-only dan `decidedByUserId` nullable; tidak ada rute duplikat untuk fakta yang sama (journey §8) |
| **03H** | sertifikasi W03 + update debt register | semua gate di atas + mutation check pada test guard (buji yang melepas aturan harus membuat suite gagal) |

## 7. Blocker — yang benar-benar butuh keputusan manusia

| ID | Level | Pertanyaan | Pemilik | Gate |
|---|---|---|---|---|
| **BLK-GAP-1** | **P0** | Kontinuitas approval saat cutover. Selama 03B/03B2/03C belum di-deploy, satu-satunya pihak yang secara teknis *bisa* approve adalah jalur staff; keputusan 7 melarangnya sebagai **kebijakan** tapi tidak menghapus kenyataan deploy. Pilihan: (i) tutup rute staff **di rilis yang sama** dengan binding + sesi (disarankan; urutan §6 sudah begitu), atau (ii) hentikan approval (commercial standstill) sampai 03E. Tidak ada dokumen yang boleh memilih ini sendiri | Product owner + release manager | **03E** (03B–03D berjalan tanpa menunggu ini) |
| **BLK-2** | P0 (proses, bukan desain) | Freeze otoritas sesi PIC terhadap CR-HM-01 D7 ("exchange = satu-satunya kredensial") | Architecture | 03B |
| BLK-CARE-BIND | P1 | Bolehkah principal care workspace membuat binding (B10 menunda)? | Architecture | hardening |
| BLK-BIND-SCOPE | P1 | Binding tetap di `tenant_company.manage` + BE-02G, atau kode permission sendiri? Residual: pemegang `manage` **memilih** penanda-tangan | Product owner + Security | hardening |
| BLK-BIND-BACKFILL | **P0 untuk rollout** (P1 untuk desain) | Kebijakan thread yang butuh baris binding agar bisa lanjut (ADD-A §7.3) **dan urutan pengaktifan B12**: begitu gate issue menyala, thread tanpa binding tidak bisa dipresentasikan - jadi B12 wajib mendarat bersama/setelah kebijakan backfill, atau diaktifkan per-tenant. Menyalakan B12 lebih dulu = standstill presentasi buatan sendiri, bukan kemenangan keamanan | Product owner + Operations + release manager | **urutan ship 03B2** (tabel + guard + rute boleh dark-launch; gate-nya tidak) |
| BLK-ISSUER | P1 | Tambah `issued_by_user_id` ke versi (+ perluas guard 0391) atau terima `M` berbasis author (MC5') | Architecture + CR-HM-06 owner | exit gate 03C |
| **BLK-3** | P0 untuk pengukuran | Agregat staging: thread dengan lineage PIC vs NULL; PIC yang terlink ke pemegang `tenant_company.manage` tenant-nya sendiri; jumlah binding yang dibutuhkan saat cutover. **Tanpa angka ini BLK-BIND-BACKFILL tidak bisa ditaksir** | DBA + Operations | cutover plan |
| BLK-4 / 7 / 8 / 9 | P1/P2 | disposition rute staff (S1 default), scoping `idempotency_key`, TTL sesi, daftar baca portal | seperti tercatat di A01 §12 | seperti tercatat |

## 8. Yang secara sadar TIDAK dikerjakan 03A

1. Tidak ada perubahan source/test/migration/schema/OpenAPI — termasuk tidak membuat tabel binding, tidak menambah kode error, tidak menyentuh katalog permission.
2. Tidak menjalankan PostgreSQL, Docker, maupun full suite; `tsc` tidak dijalankan (tidak ada yang dikompilasi berubah).
3. Journey v1.3 tidak diedit; OD-7 diajukan ke pemilik kontrak bisnis.
4. Tidak ada angka populasi. Semua pernyataan di sini adalah **logika-skema** yang terbaca dari DDL/service; yang butuh data ditandai UNVERIFIED (BLK-3).
5. Tidak menghapus atau menulis ulang jejak: temuan F-06 dan baris BLK di PART 02 dibiarkan utuh lalu **digantikan secara eksplisit** (§5, §7).
6. Tidak mendeklarasikan FROZEN untuk hal yang belum disepakati manusia: kontrak ya, rilis tidak.

## 9. Bukti perintah

| Perintah | Hasil |
|---|---|
| `git log --oneline -1` · `git rev-parse --abbrev-ref HEAD` · `git status --porcelain` | `2db34f2` · `arena/44e8ce22-handyman-backend` · tree bersih sebelum dokumen ini |
| `grep -n "tenant_pic_id" 0378_*.ts` · `grep -rn "ON handyman_service_requests" src/database/migrations/*.ts` | `:40` nullable; **nol trigger** di tabel request (hanya 4 index) |
| grep `UPDATE handyman_service_requests` + filter `tenant_pic_id` | kosong ⇒ kolom tidak pernah di-update |
| `sed` 0391 (`20,60`) dan 0393 (`1,40`) | `handyman_quotations_request_unique`; guard root/version; partial unique one-ISSUED |
| `grep -n "export async function" handyman-quotation-lifecycle.service.ts` | `:85` issue · `:185` expire · `:234` supersede · `:283` read-current |
| `sed -n "36,74p" 0378_*.ts` | `channel_attribution_id NOT NULL UNIQUE`; `CHECK (status IN ('INTAKE'))` |
| validasi markdown tiga dokumen (fence, tabel, CJK) | amendment v1.1: 498 baris, fences OK, 16 tabel 0 mismatch, CJK 0 · ADD-A: 239 baris, fences OK, 13 tabel 0 mismatch, CJK 0 · freeze: 202 baris, 2 tabel 0 mismatch, paragraf F6 asli verbatim utuh (dicek dengan `sed -n '64,74p'`), diff +56/−1 |
