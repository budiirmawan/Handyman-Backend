# W03 PART 03H-01 — E2E Certification Preflight

| Field | Value |
|---|---|
| Status | **E2E NOT CERTIFIED** — P0 exit gate belum terpenuhi |
| Tanggal | 2026-10-11 (Asia/Jakarta) |
| Branch | `arena/c3a50946-handyman-backend` |
| Baseline | HEAD = `origin/arena/c3a50946-handyman-backend` = `2694c68` (ancestor HEAD, ahead/behind 0/0, tree bersih saat mulai) |
| Sifat turn | **Preflight only.** Tanpa perubahan runtime, migrasi, B12, atau test. Tanpa full suite, tanpa PR, tanpa deploy. |
| Bahasa | Indonesia (istilah teknis tetap Inggris) |

> Aturan: E2E tidak boleh dinyatakan CERTIFIED sebelum seluruh P0 exit gate terpenuhi. Dokumen ini hanya mencatat kesiapan, bukti yang dijalankan, dan gap.

---

## 1. Ringkasan eksekutif

1. **Kontrak S1 dan 03G konsisten.** Route staff decide ditutup dengan 403 `PERMISSION_DENIED`, `Deprecation`, dan `successor-version`, tanpa `Sunset`. Test kontrak 03G 14/14 PASS.
2. **Jalur PIC inti hijau pada bukti runtime turn ini:** `handyman-pic-portal-decide` 30/30, `handyman-quotation-approval-binding-runtime` 10/10.
3. **Regresi langsung akibat S1 (BLOCKER):** fixture legacy yang memanggil `decideHandymanQuotation` sebagai APPROVE staff sekarang gagal. Sampel `handyman-arrival-challenges` 0/10 PASS dengan `PERMISSION_DENIED`. Dari 38 file legacy, 34 belum dijalankan dan diasumsikan merah sampai dibuktikan sebaliknya.
4. **B12 belum diimplementasikan.** `issueHandymanQuotationVersion` tidak memeriksa binding, dan tidak ada flag. Kriteria masuk B12 (03B2 §8 a/b/c) belum terpenuhi. B12 tetap OFF.
5. **P0 aktif yang belum tertutup:** BLK-GAP-1 (cutover approval continuity), BLK-BIND-BACKFILL (P0 rollout, urutan enable B12), dan BLK-3 (ukuran staging, oleh DBA + Operations). BLK-3 belum bisa diukur dari sandbox.
6. **Staging, integration provisioning, dan cutover tidak dapat diverifikasi dari sandbox.** Semua ditulis **UNVERIFIED**.

**Hasil: E2E NOT CERTIFIED.** Alasan utama: BLOCKER berikut masih terbuka (lihat §7).

---

## 2. Otoritas yang dibaca

| Dokumen | Bagian yang relevan |
|---|---|
| `docs/handyman/CR-HM-06_AMENDMENT_01_TENANT_PIC_APPROVAL_ACTOR.md` | §9 (B2-D2), §10.4 (S1), §12 (tabel BLK-1…BLK-10), §13 (tabel PART, exit gate 03H) |
| `docs/handyman/CR-HM-06_ADDENDUM_A_TENANT_PIC_BINDING_AUTHORITY.md` | Status baris 9 ("one P0 release-sequencing decision is open"), §3 (B12, baris ~104), §8 (BLK-GAP-1 baris ~213, BLK-BIND-BACKFILL baris ~216) |
| `docs/handyman/CR-HM-06_DECISION_FREEZE.md` | F6 v1.1 |
| `docs/e2e/W03_PART03A_*` | Ratifikasi governance |
| `docs/e2e/W03_PART03B_*`, `W03_PART03B2_*` | 03B2 §8: kriteria masuk B12 |
| `docs/e2e/W03_PART03C_*` … `03F_*` | Record shipped per PART |
| `docs/e2e/W03_PART03G_OPENAPI_CONTRACT_RECONCILIATION.md` | Record 03G (commit `2694c68`) |

Catatan: status "frozen" dibaca dari dokumen. Dokumen ini tidak mengubah otoritas tersebut.

---

## 3. Matriks E2E

Legenda bukti:
- **RUN-PASS (turn ini)**: dijalankan pada turn ini dan lulus.
- **RUN-GAP (turn ini)**: dijalankan dan ada kegagalan (lihat §5 dan §7).
- **EXISTS**: test ada (dibaca dari nama dan isi), tidak dijalankan pada turn ini.
- **UNVERIFIED**: tidak dapat diverifikasi dari sandbox.

| # | Langkah rantai | Test yang ada | Bukti | Catatan |
|---|---|---|---|---|
| 1 | Assisted intake (Customer Care, provenance 8-channel) | `tenant-intake-provenance-part02` (11 kasus), `handyman-intake-triage-journey` J1 | EXISTS | Tidak dijalankan pada turn ini. |
| 2 | Operations queue dan triage (INTAKE → INSPECTION_REQUIRED) | `handyman-operations-queue` (19), `handyman-intake-triage-journey` J2–J4, N1–N4 | EXISTS | Tidak dijalankan pada turn ini. |
| 3 | Quotation create dan issue | `handyman-quotation` (10), `handyman-quotation-lifecycle` (10), `handyman-quotations-api` (10/10 pada record 03G, dengan DB) | EXISTS | Issue belum punya gate binding karena B12 OFF. Ini perilaku yang diharapkan saat ini, bukan bukti B12. |
| 4 | Approval binding (bind, revoke, read) | `handyman-quotation-approval-binding-runtime` (10) | **RUN-PASS (turn ini) 10/10** | Mencakup MC1′ (self-binding), uniform 404, lock serialisasi, replay idempotency. |
| 5 | PIC secure session (admission, introspect, revoke) | `handyman-pic-workspace-session` (25) | **RUN-GAP (turn ini) 24/25** | Kasus 4 dan 5 gagal, lihat §5. |
| 6 | PIC read | `handyman-pic-portal-read` (25) | EXISTS | Tidak dijalankan pada turn ini. |
| 7 | PIC APPROVE / REJECT | `handyman-pic-portal-decide` (30) | **RUN-PASS (turn ini) 30/30** | Mencakup C2, MC1′, expiry saat lock wait, rollback atomik, replay. |
| 8 | Execution Scope (APPROVE membuat scope, REJECT tidak) | `handyman-execution-scope-approval-gate` (17) | EXISTS | Tidak dijalankan pada turn ini. File ini memakai helper PIC. |
| 9 | Jalur staff decide ditutup (S1) | Asersi di `handyman-pic-portal-decide` dan `handyman-quotations-api` | RUN-PASS (decide), 03G 14/14 | Route staff memang 403. Tetapi fixture legacy (§4) yang memanggil fungsi service langsung ikut gagal. |
| 10 | Regresi konsumen scope `0396`–`0422` | Suite masing-masing | **Tidak dijalankan** | Syarat 03H-§13. Lihat VERIFICATION DEBT. |
| 11 | Rantai penuh satu test (intake → triage → issue → bind → PIC decide → scope) | **Tidak ditemukan** | — | Tidak ada test tunggal yang merangkai seluruh langkah berdasarkan nama dan grep. |

---

## 4. Kontrol keamanan

| Kontrol | Test yang mencakup | Status |
|---|---|---|
| Maker-checker MC1′ (author ≠ PIC decider) | `handyman-pic-portal-decide` "refuses self-approval by the thread's own author (MC1′)"; `handyman-quotation-approval-binding-runtime` "refuses self-binding (MC1′)"; `handyman-pic-portal-read` "sees a maker-checker conflict (MC1′)" | EXISTS, sebagian RUN-PASS |
| Maker-checker MC2 | Tidak ada nama test `MC2` pada grep test PIC, binding, dan execution scope | **Belum terbukti**, VERIFICATION DEBT |
| Replay C2 (replay oleh PIC lain ditolak) | `handyman-pic-portal-decide` "refuses another PIC of the same tenant a replay that is not theirs (C2)" | RUN-PASS |
| Session expiry (DB clock, termasuk saat lock wait) | `handyman-pic-portal-decide` "rolls back all decision effects when the session expires during a version-lock wait"; `handyman-pic-portal-read` "expires against the database clock, including while blocked on a lock"; `handyman-pic-workspace-session` "never authorizes a token that expired while it waited on a row lock" | RUN-PASS untuk decide. Read dan session EXISTS / RUN-GAP (kasus 4) |
| Session revoke (idempotent, sekali, tanpa resurrect) | `handyman-pic-workspace-session` "permits exactly the first revocation…" dan "drops a live session on every authority transition"; `handyman-pic-portal-read` "loses all three reads at once when the session is revoked" | EXISTS, sebagian RUN-GAP (kasus 5 pada shared DB) |
| Replay assertion (`UNIQUE (integration_id, assertion_id)`) | `handyman-pic-workspace-session` "mints one session per assertion and collapses a duplicate into the 401" | RUN-PASS (dalam file yang gagal 24/25) |
| Cross-tenant | Kasus "foreign-tenant PIC" di `handyman-pic-workspace-session` dan `handyman-quotation-approval-binding-runtime` ("refuses an unknown, inactive, or foreign PIC with ONE uniform 404"); `handyman-pic-portal-read` "cannot tell another tenant" | EXISTS, sebagian RUN-PASS |
| Audit (ids only, tanpa PII/credential) | `handyman-pic-workspace-session` "journals admission and revocation with ids only"; `handyman-quotation-approval-binding-runtime` "binds an eligible PIC with server-derived lineage and an id-only audit trail" | EXISTS |
| Rollback (ledger, scope, lifecycle bersama) | `handyman-pic-portal-decide` "rolls back ledger, scope and lifecycle together on a scope failure"; `handyman-execution-scope-approval-gate` "rolls back ledger, lifecycle, scope and journals on a DB-floor refusal" | RUN-PASS untuk decide |
| Migrasi rollback (populated ledger di-refuse) | `handyman-quotation-pic-binding-migration` "refuses to roll back a populated ledger (forward-fix only)"; `handyman-execution-scope-approval-gate` "refuses rollback after PIC facts exist" | EXISTS |

---

## 5. Hasil validasi turn ini

Semua perintah dijalankan dengan embedded PostgreSQL (port 55504, proses latar) dan `npm`/`tsx` yang sudah terpasang. Setiap perintah dibatasi 120 detik. Tidak ada full suite.

| Test | Lingkungan | Hasil | Catatan |
|---|---|---|---|
| `tests/handyman-w03-03g-openapi-contract.test.ts` | tanpa DB | **14/14 PASS** | Sama dengan record 03G. |
| `tests/handyman-pic-portal-decide.test.ts` | DB | **30/30 PASS** | |
| `tests/handyman-quotation-approval-binding-runtime.test.ts` | DB | **10/10 PASS** | |
| `tests/handyman-pic-workspace-session.test.ts` | DB bersama (setelah run lain) | **24/25** | Kasus 5 "requires an ACTIVE integration that holds the TENANT_PIC capability": `2 !== 1`. |
| `tests/handyman-pic-workspace-session.test.ts` | DB bersih, run 1 | **24/25** | Kasus 4 gagal: `401 !== 201` di baris 656. Kasus 5 lulus. |
| `tests/handyman-pic-workspace-session.test.ts` | DB bersih, run 2 | **24/25** | Kasus 4 gagal lagi di baris 656. |
| `tests/handyman-arrival-challenges.test.ts` (legacy, sampel S1) | DB | **0/10 — RUN-GAP** | Semua `PERMISSION_DENIED` dari `staffApprovalForbiddenError` (`handyman-quotation-decision.service.ts:123`). |

### 5.1 Analisis kegagalan `handyman-pic-workspace-session`

- **Kasus 5 (count TENANT_PIC).** Asersi menghitung `handyman_handoff_integrations` dengan `actor_capability='TENANT_PIC'` tanpa scoping. Pada DB bersama, baris dari file lain (decide, binding) ikut terhitung (count 2). Pada DB bersih, kasus ini lulus. **Kesimpulan: isolasi test.** Bukan regresi kontrak.
- **Kasus 4 (jendela waktu).** Asersi `edge` membuat `expiresAt` sekitar 1 detik dari sekarang. Setelah enam admission lain, request sering sudah kedaluwarsa, lalu server benar-benar menjawab 401. Ini konsisten dengan kontrak (sesi kedaluwarsa ditolak). **Kesimpulan: margin test terlalu sempit untuk latensi DB sandbox.** Hipotesis ini belum diukur langsung. Bukti: gagal 2/2 pada DB bersih, dan baris 656 adalah persis asersi `edge`.
- Turn ini tidak mengubah test. Perbaikan yang disarankan (untuk PART terpisah): menggeser `issuedAt` ke sekitar `now-2s` agar margin ~298s, dan menscope count kasus 5 ke integrasi fixture.

### 5.2 Kegagalan legacy S1 (`handyman-arrival-challenges`)

- Fixture memanggil `decideHandymanQuotation(version.id, …)` dari `src/modules/handyman-quotations` secara langsung (baris 380). Fungsi itu sekarang melempar `staffApprovalForbiddenError` (S1, `PERMISSION_DENIED`).
- Ini regresi langsung dari S1, bukan debt lama. **Diklasifikasikan sebagai BLOCKER** (lihat G5). Perbaikannya membutuhkan desain ulang fixture ke jalur PIC (binding, sesi, decide PIC), dan itu bukan pekerjaan preflight.
- Tidak diperbaiki pada turn ini sesuai batas scope (preflight only).

---

## 6. Fixture lama yang masih memakai staff approval

Sumber: `/tmp/w03g/staff-approval-fixture-files.txt` (38 file) dan `/tmp/w03g/classify.txt` (jumlah penolakan per file). Artefak ini ada di luar repo dan bukan commit.

| Kategori | Jumlah | Keterangan |
|---|---|---|
| File yang memanggil staff decide (service) | **38** | Semua legacy, kecuali `handyman-execution-scope-approval-gate` yang memakai helper PIC. |
| Dengan asersi penolakan S1 (eksplisit) | 4 | `handyman-customer-care-transport-certification`, `handyman-pic-portal-read`, `handyman-quotation-pic-binding-migration`, `handyman-quotation-decision`. Perlu ditinjau satu per satu. |
| Tanpa asersi penolakan (kandidat fixture lama) | **34** | Diasumsikan merah. Hanya 1 sampel (`handyman-arrival-challenges`, 0/10) yang sudah dibuktikan. |
| Dampak pada fixture chain | 56 file mengimpor `tests/helpers/handyman-fixtures.ts` | Helper ini perlu ditinjau bersama. Komentar baris 188 menyatakan "B12 remains OFF". |

Catatan: beberapa baris `decideHandymanQuotation` di `handyman-pic-portal-decide.test.ts` adalah pemeriksaan string sumber (`indexOf`), bukan pemanggilan runtime. File itu tidak masuk daftar fixture lama.

---

## 7. Readiness dan klasifikasi gap

Legenda kategori:
- **BLOCKER**: menghalangi E2E CERTIFIED, cutover, atau enable B12.
- **VERIFICATION DEBT**: harus ditutup dengan bukti sebelum CERTIFIED, tetapi bukan keputusan atau desain yang hilang.
- **DEFERRED**: di luar cakupan sertifikasi, dengan pemilik dan pemicu yang jelas.

### 7.1 Gap

| ID | Gap | Pemilik | Kategori | Alasan dan bukti |
|---|---|---|---|---|
| G1 | **BLK-GAP-1** — cutover approval continuity (ADD-A §8). P0, memblokir 03E. | Product owner + release manager | **BLOCKER** | ADD-A baris 9 masih mencatat satu keputusan P0 release-sequencing terbuka. Tidak ada keputusan tercatat di repo. |
| G2 | **BLK-BIND-BACKFILL** — backfill binding dan urutan enable B12. P0 rollout. | Product owner + Operations + RM | **BLOCKER** | Syarat 03B2 §8 (a) dan (c) belum terpenuhi. |
| G3 | **BLK-3** — staging measurement (PIC-linked rate, MC4, NULL PIC, duplicate key). | DBA + Operations | **BLOCKER** (prasyarat G4 dan G2) | **UNVERIFIED**: staging tidak dapat diakses dari sandbox. Query agregat sudah ditentukan di `W03_PART01` §3. |
| G4 | **BLK-7** — idempotency scoping (`handyman_quotation_decisions_key_unique` masih global, `0394`). | Architecture + DBA | **BLOCKER** untuk cutover | Migrasi tersendiri, hanya setelah duplicate count G3 = 0. |
| G5 | **Fixture legacy merah akibat S1** (§5.2, §6). | QA + Engineering | **BLOCKER** untuk CERTIFIED | Terbukti 0/10 pada sampel. 34 file belum dijalankan. |
| G6 | **B12 belum diimplementasikan.** `issueHandymanQuotationVersion` tanpa cek binding, tanpa flag. | Engineering (setelah G1–G3) | **BLOCKER** untuk enable B12 dan untuk langkah "bind before present" | Kriteria 03B2 §8 (a)(b)(c) belum terpenuhi. B12 tetap OFF. |
| G7 | **BLK-6 / MC5** — authorship maker set. 03C exit gate. Sign-off Architecture/CR-HM-06 owner outstanding (03F record). | Architecture + CR-HM-06 owner | **BLOCKER** | Belum ada sign-off tertulis. |
| G8 | **BLK-8** — TTL 600s vs 900s. Kode saat ini `PIC_WORKSPACE_MAX_TTL_SECONDS = 900` dan default 900 (`pic-workspace-session.types.ts:25–26`). | Product owner + BM | **BLOCKER** | Keputusan terbuka. Konstanta 900 berlaku sementara. |
| G9 | **Provisioning integrasi TENANT_PIC.** Ada fungsi service `setIntegrationActorCapability` yang menerima `TENANT_PIC`, tetapi **tidak ada route HTTP dan tidak ada seed**. Secret per-integrasi (`HANDYMAN_HANDOFF_SECRET_<CODE>`) juga bergantung proses operasional. | Operations + Security | **BLOCKER** untuk rollout | Tanpa integrasi aktif, sesi PIC tidak bisa dimint. **UNVERIFIED** di staging. |
| G10 | **Grant `handyman.quotation.approval.binding.manage`** tidak default (sengaja, `foundation-access.seed.ts`). Tanpa grant, ketiga route binding 403 untuk semua orang termasuk PLATFORM_ADMIN. | Product owner + tenant management | **BLOCKER** untuk rollout | Ini desain yang disengaja. Grant per tenant harus menjadi bagian backfill G2. |
| G11 | **BLK-ISSUER** (`issued_by_user_id` opsional). | Architecture | **DEFERRED** | Opsional. Tergantung G7. Tidak ditambahkan di 03F. |
| G12 | **BLK-10** — tanggal Sunset untuk route staff decide. | Product owner (jadwal rollout) | **DEFERRED** | Owner memutuskan: deprecation dan successor Link dipertahankan. Tanggal Sunset menunggu jadwal rollout. **Tidak ada tanggal yang dikarang.** Tidak memblokir sertifikasi. |
| G13 | **Mutation checks** pada setiap guard test (03H exit gate, A01 §13). | QA | **VERIFICATION DEBT** | Belum dijalankan. |
| G14 | **Regresi konsumen `0396`–`0422`.** | QA | **VERIFICATION DEBT** | Belum dijalankan. |
| G15 | **Rantai penuh satu test** (intake → … → scope). | QA | **VERIFICATION DEBT** | Tidak ada test tunggal. |
| G16 | **MC2** tanpa test bernama eksplisit. | QA + Architecture | **VERIFICATION DEBT** | Perlu pemetaan ke definisi MC2. |
| G17 | **E1–E3 DB-level guard** (03F exit gate: ratified atau waived). Guard DB ada di `0443`. Status ratifikasi tidak tercatat. | Architecture | **VERIFICATION DEBT** | Perlu pointer ratifikasi. Belum diverifikasi ulang pada turn ini. |
| G18 | **Flakiness `handyman-pic-workspace-session`** (kasus 4 margin waktu; kasus 5 isolasi DB). | QA | **VERIFICATION DEBT** | Perbaikan disarankan di §5.1. Belum diterapkan. |
| G19 | **Test belum dijalankan pada turn ini:** `pic-portal-read`, `execution-scope-approval-gate`, `intake-triage-journey`, `operations-queue`, `quotation-lifecycle`, `quotation-pic-binding-migration`, dan 33 file legacy lainnya. | QA | **VERIFICATION DEBT** | Sengaja tidak dijalankan (validasi ringan saja). |
| G20 | **Debt lama (baseline `3332a92`, terbukti bukan regresi 03G):** `handyman-scope-assignments-api` 9/10 gagal; `handyman-material-execution-api` test 6 (`9 !== 8`). | Owner modul masing-masing | **VERIFICATION DEBT** | Dicatat, tidak diperbaiki. |

### 7.2 Ringkasan per kategori

- **BLOCKER (9):** G1, G2, G3, G4, G5, G6, G7, G8, G9, G10. (G3 bergantung pada staging, UNVERIFIED.)
- **VERIFICATION DEBT (8):** G13–G20.
- **DEFERRED (2):** G11, G12.

---

## 8. Ratifikasi dan keputusan owner (turn ini)

### 8.1 B2-D2 — revoke binding — **RATIFIED**

- **Keputusan:** revoke binding dilakukan lewat `POST /handyman/quotations/{quotationId}/approval-binding/revoke`, dengan `reason`, idempotency, dan audit. **Tidak ada alias `DELETE`.**
- **Implementasi:** sudah sesuai. Route POST revoke ada di `src/modules/handyman-quotations-api/handyman-quotations-api.routes.ts:47`. Tidak ditemukan route `DELETE` untuk approval-binding.
- **Pointer yang perlu diedit pemilik dokumen (tidak diedit sepihak di sini):**
  - `docs/handyman/CR-HM-06_AMENDMENT_01_TENANT_PIC_APPROVAL_ACTOR.md` baris 349 masih menulis `DELETE /handyman/quotations/{quotationId}/approval-binding`. Teks itu tertinggal dan perlu diperbarui oleh pemilik Amendment 01.
  - Pointer serupa perlu ditambahkan ke ADD-A pada bagian yang relevan, oleh pemilik ADD-A.

### 8.2 BLK-10 — deprecation dan successor Link — **dipertahankan**

- Route staff decide tetap `Deprecation` + `successor-version` Link, tanpa `Sunset`.
- Tanggal Sunset menunggu jadwal rollout dari owner. Tidak ada tanggal yang dikarang.
- Test yang menegakkan ini: `handyman-quotations-api` ("no Sunset date (owner decision)") dan `handyman-pic-portal-decide` ("no Sunset date may be advertised…").

---

## 9. P0 exit gate

| Item | Status |
|---|---|
| BLK-GAP-1 | **NOT MET** (G1) |
| BLK-BIND-BACKFILL | **NOT MET** (G2) |
| BLK-3 staging measurement | **UNVERIFIED** (G3) |
| BLK-7 | **NOT MET** (G4) |
| Fixture chain hijau | **NOT MET** (G5) |
| B12 criteria (03B2 §8) | **NOT MET** (G6) |
| Integration provisioning | **UNVERIFIED** (G9) |

**Kesimpulan: E2E NOT CERTIFIED.**

---

## 10. Langkah berikutnya (tanpa keputusan produk baru)

Semua langkah di bawah membutuhkan PART terpisah atau keputusan owner. Tidak ada yang dikerjakan pada turn ini.

1. Owner (Product + RM) memutuskan G1 dan G2. Hasilnya dicatat di ADD-A §8.
2. DBA dan Operations menjalankan query agregat BLK-3 di staging, lalu mencatat hasilnya. Ini membuka G4.
3. Owner (Product + BM) memutuskan G8 (TTL).
4. Architecture dan CR-HM-06 owner memberikan sign-off G7 (BLK-6).
5. QA memutuskan strategi fixture legacy (G5): migrasi ke jalur PIC, atau pengelompokan ulang. Pilihan ini adalah keputusan desain, bukan perbaikan kecil.
6. Operasional menetapkan prosedur provisioning integrasi TENANT_PIC dan grant `binding.manage` (G9, G10).
7. Setelah G1–G10 tertutup, baru PART 03H (sertifikasi) dapat menjalankan G13–G20 dan mengubah status menjadi CERTIFIED.

---

## 11. Yang tidak dilakukan pada turn ini

- Tidak ada perubahan runtime, migrasi, B12, atau test.
- Tidak ada full suite, typecheck seluruh repo, audit repo-wide, atau test loop panjang.
- Tidak ada PR, deploy, atau perubahan pada dokumen frozen (pointer diserahkan ke pemilik).
- Tidak ada akses staging. Semua item staging ditandai UNVERIFIED.
