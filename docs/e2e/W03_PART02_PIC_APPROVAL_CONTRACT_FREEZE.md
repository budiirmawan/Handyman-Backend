# W03 PART 02 — F6 Amendment & PIC Approval Contract Freeze (working record)

**Tanggal:** 2026-10-10 · **Branch:** `arena/44e8ce22-handyman-backend` · **HEAD saat kerja:** `21a7b47`
**Tipe:** DOCUMENTATION ONLY. Nol perubahan pada `src/`, `src/database/migrations/`, `docs/api/`, dan `tests/`.
**Artifact normatif:** `docs/handyman/CR-HM-06_AMENDMENT_01_TENANT_PIC_APPROVAL_ACTOR.md` (id `CR-HM-06/A01`, v1.0, **PROPOSED — belum diratifikasi**).
**Dokumen ini:** catatan kerja W03 — verifikasi baseline, rantai bukti tiap klaim, acceptance criteria untuk PART coding berikutnya, dan rute blocker ke pemilik keputusan. Bila dokumen ini dan amendment bertentangan, **amendment yang normative**; bila amendment bertentangan dengan freeze CR-HM-06 yang belum diamandemen, **freeze yang berlaku** (amendment masih proposal).

---

## 1. Status vs 7 keputusan yang disetujui

| # | Keputusan (verbatim user) | Ditempatkan di | Status |
|---|---|---|---|
| 1 | PIC memakai limited authenticated session dari BM Super App secure handoff | A1, §4–§5 amendment | DITERIMA, dengan syarat: butuh freeze otoritas sendiri (BLK-2) — presedennya CR-HM-CARE-WORKSPACE-01 PART 01 §2 |
| 2 | Tidak ada kewajiban akun User internal untuk PIC | A2, §6.1 (`DROP NOT NULL`), §7.1 | DITERIMA; residual MC4 didefinisikan eksplisit, tidak disembunyikan |
| 3 | Reuse existing quotation decision ledger, bukan ledger baru | A3, §6 (additif pada `0394`) | DITERIMA; tabel baru ditolak, hanya kolom + guard |
| 4 | Actor identity eksplisit, immutable, auditable | A3 + §6.1 (`decision_actor_type`, `decided_by_tenant_pic_id`, `decided_by_pic_session_id`) | DITERIMA |
| 5 | Hanya keputusan TENANT_PIC yang menghasilkan Execution Scope baru | A4, §7.2 E1–E5 | DITERIMA, dua lapis (service + trigger INSERT) |
| 6 | Staff tidak boleh menyetujui via permission administratif | A5, §6.2 (INSERT guard menolak kelas USER), §10.4 | DITERIMA; disposition rute staff (soft-close vs hapus) = BLK-4 |
| 7 | C6 dan staff building scope tidak diperluas | A7, §10 C13–C14, gate 03D | DITERIMA; ada test wajib "predikat PIC tidak menyentuh `user_building_assignments`" |

**Konsekuensi yang belum disetujui siapa pun dan karena itu menjadi blocker:** BLK-1 (lihat §4). Bukan penolakan terhadap 1–7; ini konsekuensi struktural dari 2 + 5 + 6 yang tidak bisa dicode diam-diam.

## 2. Yang saya baca (review scope, read-only)

| Kelompok | File |
|---|---|
| Authority frozen | `CR-HM-06_DECISION_FREEZE.md` (F1–F12 + token + tabel PART), `HANDYMAN_BUSINESS_JOURNEY_v1.3_FROZEN.md` (§1, §2, §4, §5, §6, §8, §9), `CR-HM-01_AMENDMENT_01_CUSTOMER_CARE_ACTOR_HANDOFF.md` (D4–D8, §3.6, §4), `CR-HM-CARE-WORKSPACE-01_PART01_AUTHORITY_CONTRACT_FREEZE.md` (§1, §2, §7, §8) |
| Ledger & immutability | `0394` (decision ledger + guard unconditional), `0391` (versions; guard berupa daftar kolom), `0395` (scopes; `created_by_user_id NOT NULL`; guard unconditional), `0396`–`0405`, `0410`, `0416`, `0418`–`0422` (konsumen scope) |
| Preseden actor identity | `0431` (pay: additif + guard extension), `0430` (purpose CHECK + trigger baru, bukan replace), `0427` (no-borrow trigger lintas namespace), `0426`, `0425` (capability enum), `0432` (allowlist grant non-User) |
| Sesi & admission | `0429` (session table, tombstone, revocation triggers, guard), `care-workspace.service.ts`, `care-workspace.routes.ts`, `care-create-exchange.service.ts/.scope.ts`, `care-representation.service.ts`, `handoff-context.service.ts`, `handoff-runtime.types.ts` |
| Jalur keputusan | `handyman-quotation-decision.service.ts`, `.repository.ts`, `.types.ts`, `handyman-quotation-access.ts`, `handyman-execution-scope.service.ts/.repository.ts`, `handyman-quotations-api.routes.ts/.controller.ts`, `handyman-lifecycle-api.routes.ts`, `rbac.middleware.ts`, `operational-events/index.ts`, `0080`, `0378`, `0145`, `0148`, `0002`, `shared/errors.ts`, `database/migrate.ts` |

## 3. Rantai bukti (setiap klaim di amendment)

| Klaim kunci | Bukti (file:line, diverifikasi di `21a7b47`) |
|---|---|
| Teks F6 lama menuntut user lokal | `CR-HM-06_DECISION_FREEZE.md` §F6 "Actor = authenticated local user with required Client/RBAC authority…" + footer "any deviation requires an explicit revised freeze before implementation" |
| Journey menuntut PIC, bukan login | journey §2 baris "Tenant / PIC … Tidak login langsung"; §4.3 "Quotation disetujui oleh Tenant/PIC" |
| `decided_by_user_id NOT NULL → users` | `0394` (`decided_by_user_id    UUID NOT NULL REFERENCES users (id)`) |
| Execution Scope juga menuntut user | `0395:47-48` (`created_by_user_id UUID NOT NULL REFERENCES users (id)`); F9 mencantumkan `createdByUserId` sebagai minimum authority |
| Satu-satunya konsumen DB atas ledger keputusan | `grep -rln handyman_quotation_decisions src/database/migrations/` → hanya `0394`, `0395`, `index.ts`; FK `0395:34-35` |
| Guard 0394/0395 tidak mencakup INSERT | `0394` `BEFORE UPDATE OR DELETE`; kontras `0412:226-230` `BEFORE INSERT OR UPDATE OR DELETE` (karena itu `0431` cukup replace function) |
| Additive + DEFAULT sebagai backfill tanpa UPDATE | `0431` (`ADD COLUMN recorded_by_actor_type TEXT NOT NULL DEFAULT 'USER'` + CHECK exactly-one + `DROP NOT NULL`) |
| Guard versi = allow-by-omission | `0391:79-113` membandingkan daftar kolom tertentu saja; `updateVersionLifecycle` hanya menulis `status, valid_until, updated_at` (`handyman-quotation.repository.ts:195-212`); tidak ada kolom `issued_by`/`issued_at` di `0391` |
| `down()` 0431 tidak mengembalikan NOT NULL | `0431.down()` hanya DROP CONSTRAINT/COLUMN, tanpa `SET NOT NULL` → preseden asimetri yang dihindari R3 |
| migrateDown satu langkah dalam satu tx | `src/database/migrate.ts:76-90` |
| Reuse PIC resolution sudah ada | `handoff-context.service.ts:88-106` — PIC harus ada, `tenantCompanyId` cocok, `status='ACTIVE'`; `:89` "no session created"; link user opsional |
| Template freshness check per-call | `care-representation.service.ts:31-88` (re-resolve, bandingkan 7 field, `FOR SHARE`, `clock_timestamp()`); **`hasCarePropertyScope` di baris terakhir TIDAK dipakai untuk PIC** |
| Template replay/tombstone/immutability sesi | `0429` (`UNIQUE (integration_id, assertion_id)`, `CHECK expires_at <= created_at + INTERVAL '15 minutes'`, guard "only revocation permitted", trigger invalidasi pada actor/integration) |
| Capability enum harus widen | `0425` `CHECK (actor_capability IN ('NONE','CUSTOMER_CARE'))`; tidak ada `ALTER CONSTRAINT` di Postgres → drop+add |
| Tidak ada registry paralel untuk PIC | `0425` header: registry care "intentionally stores NO local-user, Tenant PIC, tenant-company… linkage"; CARE-WORKSPACE §1 "Reuse these sources without parallel masters" |
| Jalur keputusan staff itu tunggal | `handyman-quotations-api.routes.ts:96-97`; `handyman-lifecycle-api.routes.ts:36` (quotations out of scope) + satu-satunya any-of `:50` adalah `triageRead` |
| Replay tidak memeriksa actor | `handyman-quotation-decision.service.ts:168-185` (hanya key + fingerprint + decision) |
| `recordOperationalEvent` membolehkan actor NULL | `operational-events/index.ts:39` (`actorUserId?: string \| null`), `:165`; `0080` `actor_user_id UUID REFERENCES users(id)` tanpa NOT NULL |
| Tidak ada join `users` atas `created_by_user_id` scope | grep konsumen scope (`handyman-scope-assignments`, `handyman-sla-status-api`, `handyman-settlement`, `handyman-financial-entitlements`, `handyman-customer-transactions`, `handyman-requests`) → nol pemakaian kolom itu |
| **MAINLINE: care-assisted intake tidak bisa menautkan PIC** | `care-create-exchange.service.ts:26-31` whitelist body persis `['tenantCompanyId','buildingId','spaceId']`; `handyman-service-request.service.ts:232` menurunkan `tenantPicId` dari attribution; `0378:40` kolomnya nullable (kontras `0148:20` NOT NULL) |
| Tidak ada trigger pembatalan pada `tenant_pics` | grep `ON tenant_pics` di `src/database/migrations/` → hanya index (`0145:38,40,43`); `0427` hanya *membaca* `tenant_pics` di trigger attribution |
| `ERROR_CODES` additif, bukan enum tertutup | `src/shared/errors.ts:3` dan `:1068-1069` (peta literal) |

## 4. Temuan baru PART 02

**F-06 (P0, blocker utama — mengubah urutan kerja, bukan desain).** Kombinasi keputusan 2 + 5 + 6 membuat **setiap request hasil assisted intake tidak dapat disetujui siapa pun**. Rantai: journey §4.1 hanya Customer Care yang membuat request → requestCare men-tautkan PIC lewat exchange (`care-create-exchange.service.ts:26-31` **tidak** menerima `tenantPicId`) → `resolved.tenantPicId` null → attribution null → `handyman_service_requests.tenant_pic_id` null → dan CHECK koherensi `tenant_pic_id IS NOT DISTINCT FROM decided_by_tenant_pic_id` (§6.2) membuat PIC tidak bisa "diisi saat keputusan". Jadi bukan kasus tepi: jalur utama. Tiga opsi ada di amendment §12 BLK-1; **saya tidak memilih salah satunya** karena (a) menyentuh kontrak CR-HM-02/CARE-WORKSPACE dan sisi BM. Rekomendasi teknis saya (bukan keputusan): wajibkan seleksi PIC pada create-exchange untuk request yang akan di-quote — perubahan terkecil, sudah punya rute discovery PIC-nya, dan `isCurrentCareRepresentation` sudah membandingkan `tenantPicId` sehingga tidak ada master baru.

**F-07.** Sesi PIC **tidak boleh** menumpang `handyman_handoff_care_actors`: D4 membekukan "actor is never a PIC" dan registry itu sengaja tanpa linkage apa pun. Yang layak di-reuse adalah **mesin kredensialnya** (HMAC `stableJson`, `timingSafeEqual`, `token_hash`, tombstone `(integration, assertion)`, guard revocation, trigger invalidasi), bukan actor store-nya. Karena PIC sudah punya master lokal (`tenant_pics`), **tidak ada tabel registry baru** — admission cukup nama representasi (tenant/building/PIC[/space]) lalu diselesaikan server-side oleh `resolveHandoffContext` yang sudah ada.

**F-08.** Keputusan 5 + 6 paling murah ditegakkan **di ledger, bukan di middleware**: INSERT guard yang menolak `decision_actor_type='USER'` membuat approval staff tidak bisa tercatat *oleh siapa pun*, termasuk jalur internal/bug/scr— sekaligus menjadikan amandemen ini **prospective-only secara struktural** (baris lama tak tersentuh, tanpa backfill). Syarat teknis: trigger `0394`/`0395` harus di-*recreate* dengan cakupan INSERT; `CREATE OR REPLACE FUNCTION` saja tidak cukup (0394/0395 adalah `BEFORE UPDATE OR DELETE`).

**F-09.** Maker-checker lintas namespace **hanya bisa dibuktikan lewat link**: `M = {creator root, creator version}`, `C = {pic_id} ∪ {tenant_pics.user_id}`. Kalau `user_id` NULL, tidak ada fakta tersimpan yang bisa membuktikan perbedaan identitas (MC4) — dan issuer versi tidak tersimpan di `handyman_quotation_versions` (MC5), sehingga `M` adalah *author*, bukan *presenter*. Konsekuensi: klaim "maker-checker terpenuhi struktural" harus diucapkan dengan batas ini, bukan tanpa syarat.

**F-10.** Additive ledger di tabel immutable punya jebakan yang sudah pernah ada di repo ini: `0431.down()` menurunkan kolom identitas **tanpa** mengembalikan `NOT NULL`, jadi rollback meninggalkan schema lebih lemah dari awalnya. Karena `migrateDown` hanya bisa undo satu migration terakhir (`migrate.ts:76-90`), kebijakan R3/R4 amendment (down menolak rollback bila ada baris non-USER; sesudah itu forward-fix only) bukan formalitas.

## 5. Acceptance criteria untuk PART coding berikutnya (setiap baris = test yang bisa gagal)

| ID | Kriteria | PART |
|---|---|---|
| AC-1 | `handyman_quotation_decisions.decided_by_user_id` nullable; `decision_actor_type` NOT NULL DEFAULT `'USER'`; CHECK exactly-one per kelas; **tidak ada satu pun statement UPDATE** di migration | 03C |
| AC-2 | Semua baris lama tetap terbaca via proyeksi publik yang sama; `decidedByUserId` null hanya untuk baris baru berkelas `TENANT_PIC` | 03C |
| AC-3 | INSERT baris `decision_actor_type='USER'` **ditolak trigger** dengan `ERRCODE 23514` (test negatif) | 03C |
| AC-4 | INSERT dengan `tenant_pic_id` ≠ `decided_by_tenant_pic_id` ditolak; INSERT dengan PIC dari tenant lain ditolak; INSERT dengan PIC non-ACTIVE ditolak | 03C |
| AC-5 | INSERT oleh PIC yang `user_id`-nya = creator version/root ditolak (no-borrow) | 03C |
| AC-6 | Guard scope menolak INSERT scope yang `quotation_decision_id`-nya menunjuk keputusan non-TENANT_PIC atau `tenant_pic_id` berbeda | 03F |
| AC-7 | Admission PIC menolak: signature salah, window > 300s, `issuedAt` masa depan, key tidak dikenal, key hilang, `purpose` care/handoff, assertion replay (tombstone), `req.query` berisi, secret tidak ada → **semua 401 seragam**, tanpa detail aktor/integration | 03B |
| AC-8 | Sesi menolak: token jenis lain (bearer user / care) → 401; `revoked_at` terisi → 401; kedaluwarsa *saat menunggu row lock* → 401; logout 2× → 204 dan 204 | 03B |
| AC-9 | PIC di-revoke (atau tenant di-suspend) di tengah sesi → panggilan berikutnya 401 **dan** baris sesi terisi `revoked_at` oleh trigger; reaktivasi tidak menghidupkan sesi | 03B |
| AC-10 | `GET` PIC atas request milik tenant lain / building lain / request tanpa PIC → 404 seragam (bukan 403, bukan beda-sisa-tenant) | 03D |
| AC-11 | Predikat baca PIC **tidak** menyebut `user_building_assignments` (test source-text, analog GUARD di `config-perm-01`) | 03D |
| AC-12 | `POST` keputusan PIC tidak menerima field identitas apa pun di body selain `decision`; `Idempotency-Key` header wajib; replay oleh sesi dengan PIC berbeda → 409 | 03E |
| AC-13 | Approve sukses: decision row + proyeksi `APPROVED` + Execution Scope + 2 event dalam **satu tx**; kegagalan scope me-rollback semuanya (sudah ada di staff path — wajib tetap hijau untuk jalur PIC) | 03E |
| AC-14 | Route staff `POST /handyman/quotation-versions/:id/decision` menolak principal user dengan 409 dan header `Deprecation` (S1) **atau** tidak ada (S2) — tidak ada keadaan ketiga | 03E |
| AC-15 | Tidak ada kode permission baru, tidak ada grant baru, tidak ada `users`/`user_sessions` baru yang dibuat oleh jalur PIC (assert via grep/source-text) | 03B–03E |
| AC-16 | Token mentah, `token_hash`, `actor_reference`, raw assertion, dan PII kontak **tidak** muncul di log, respons, error, atau cursor (source-text + response-shape test) | 03B–03G |
| AC-17 | `migrateDown` atas migration ledger **gagal dengan pesan khusus** bila sudah ada baris `TENANT_PIC`; sukses bersih bila belum | 03C |
| AC-18 | Suite fokus konsumen hilir (`0396`–`0422`) tetap hijau tanpa perubahan logika mereka | 03G |

## 6. Rute keputusan (hanya yang benar-benar butuh manusia)

| Blocker | Pemilik | Tidak boleh dimulai sebelum |
|---|---|---|
| BLK-1 (F-06) request tanpa PIC tidak punya approver | Product owner + CR-HM-02/CARE-WORKSPACE owner + BM | 03E dan rilis penutupan jalur staff |
| BLK-2 freeze otoritas sesi (reuse mesin, bukan actor store) | Architecture | 03B |
| BLK-3 pengukuran staging (aggregate-only; query sudah ada di PART 01 §3) | DBA + Operations | sizing BLK-1, remediasi MC4, BLK-7 |
| BLK-4 S1 soft-close vs S2 hapus route staff | Product owner + FE owners | 03E |
| BLK-5 aturan provisioning link PIC↔User (MC4) | Product owner + Security | 03C (DB) / 03E (service) |
| BLK-6 `M` berbasis author vs menambah `issued_by` | Architecture + CR-HM-06 owner | exit gate 03C |
| BLK-7 scoping tenant untuk `idempotency_key` (global UNIQUE saat ini) | Architecture + DBA | 03F (migration terpisah, R6) |
| BLK-8 TTL sesi (≤600s vs 900s vs single-use) | Product owner + BM | konstanta 03B |
| BLK-9 daftar baca portal PIC | Product owner | 03D |

## 7. Yang secara sadar TIDAK dilakukan PART 02

1. Tidak ada perubahan `src/`, migration, schema, permission, grant, index, atau OpenAPI — termasuk tidak menambah kode error yang disebut §5 amendment.
2. Tidak mengubah `CR-HM-06_DECISION_FREEZE.md` maupun journey v1.3; patch pointer **diusulkan** di amendment §14.2 dan diterapkan pemilik dokumen saat ratifikasi.
3. Tidak memilih opsi BLK-1, BLK-4, BLK-6, BLK-8, BLK-9 (keputusan manusia), dan tidak menyamar memilih lewat "default implementasi".
4. Tidak menjalankan PostgreSQL maupun full suite; tidak ada angka populasi — seluruh klaim struktural bersifat source-level, seluruh klaim populasi tetap UNVERIFIED.
5. Tidak menulis migration, `up`/`down` SQL sebagai file — SQL di amendment adalah spesifikasi normatif untuk PART 03C.
6. Tidak menyentuh T-05/T-06 (`findCurrentIssued` mengabaikan `valid_until`; global idempotency) — keduanya tetap defect terdaftar; BLK-7 hanya mengatur skema, bukan memperbaiki keduanya diam-diam.
7. Tidak membuka read surface customer di `handyman-api.routes.ts`; jalur baca PIC adalah modul baru (03D), bukan perluasan yang ada.

## 8. Bukti perintah

| Perintah | Hasil |
|---|---|
| `git log --oneline -1` / `git rev-parse --abbrev-ref HEAD` / `git status --porcelain` | `21a7b47` · `arena/44e8ce22-handyman-backend` · tree bersih sebelum dokumen ini |
| `grep -rln handyman_quotation_decisions src/database/migrations/` | `0394`, `0395`, `index.ts` — satu konsumen FK |
| `grep -rn "ON tenant_pics" src/database/migrations/` | hanya 3 index (`0145:38,40,43`), nol trigger |
| `grep -n "CREATE TRIGGER" -A5 …0412… ; grep -rn "BEFORE INSERT OR UPDATE OR DELETE" src/database/migrations/*.ts` | 0412 guard sudah mencakup INSERT; 0394/0395 tidak |
| `grep -rn "created_by_user_id" <konsumen scope>` | nol pemakaian pada konsumen scope (E4) |
| `sed` baca 0391/0394/0395/0425/0427/0429/0430/0431/0432, `care-workspace.service.ts`, `care-create-exchange.service.ts`, `care-representation.service.ts`, `handoff-context.service.ts`, `handyman-quotation-decision.service.ts`, `migrate.ts` | kutipan §3 terverifikasi satu per satu |
| `npx tsc --noEmit -p .` | **tidak dijalankan** — nol perubahan kode (run tanpa alasan = melanggar aturan hemat) |
| Full suite | **tidak dijalankan** (aturan standing) |
