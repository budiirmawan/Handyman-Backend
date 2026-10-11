# W03 PART 03H-05 — Integrated E2E Journey

| Field | Value |
|---|---|
| Status | **BLOCKED — integrated journey SKIP 1/1 (G9). E2E NOT CERTIFIED.** |
| Expected baseline | `80af13776bc8a297a26763bb9bf00ecde8b209f5` |
| Validation branch | `arena/b4a8612c-handyman-backend` |
| Validation date | 2026-10-11 (Asia/Jakarta) |
| Language | Indonesia |

## 1. Keputusan

**Journey penuh tidak dapat disahkan tanpa provisioning TENANT_PIC yang berotorisasi.** Route `POST /api/v1/handyman/pic/session` membutuhkan integrasi aktif dengan capability `TENANT_PIC`, tetapi pada kontrak yang diperiksa tidak ada route HTTP atau seed untuk memberikan capability tersebut. Satu-satunya setter yang ditemukan, `handymanCareActorService.setIntegrationActorCapability()`, tidak menerima acting user dan tidak memiliki route HTTP. `handoffRuntimeRepository.createIntegration()` juga merupakan pemanggilan repository, bukan jalur provisioning berotorisasi.

Sesuai blocker G9 dari `W03_PART03H-01_E2E_CERTIFICATION_PREFLIGHT.md`, pemanggilan internal tersebut **tidak dianggap** bukti otorisasi dan tidak digunakan dalam artefak akhir. Test final fail-closed dengan **SKIP 1/1**; tidak ada percobaan provisioning di dalamnya. Test tidak boleh diaktifkan sampai Operations/Security menetapkan kontrak provisioning yang dapat diotorisasi dan diaudit.

Batas blocker: tanpa capability TENANT_PIC yang sah, test tidak dapat memperoleh sesi PIC melalui HTTP; karena itu PIC read, PIC `APPROVE`, dan pembuatan Execution Scope tidak dapat dijalankan sebagai rantai terotorisasi. Tidak ada bypass melalui SQL, service internal tanpa actor, atau weakening guard.

## 2. Hasil PASS / FAIL / SKIP

| Pemeriksaan | Hasil | Batas interpretasi |
|---|---:|---|
| `tests/handyman-w03-03h05-integrated-journey.test.ts` (artefak akhir) | **SKIP 1/1** | Alasan skip menyatakan blocker G9 secara eksplisit. Ini bukan PASS E2E. |
| `tests/handyman-intake-triage-journey.test.ts` | **PASS 27/27** | Regresi Customer Care intake → Operations triage, termasuk negative authority, replay, dan audit pada test terkait. |
| `tests/handyman-quotation-approval-binding-runtime.test.ts` — 4 subtest relevan yang dipilih dengan `--test-name-pattern` | **PASS 4/4** | Bind/replay/audit/HTTP regression lulus dengan fixture test yang ada; **tidak** membuktikan otorisasi provisioning integrasi (G9). |
| `tests/handyman-execution-scope-approval-gate.test.ts` — subtest rollback DB-floor yang dipilih dengan `--test-name-pattern` | **PASS 1/1** | Rollback ledger/lifecycle/scope/journal dan same-key retry lulus. Bukan validasi rantai E2E atau G9. |
| **Regresi terpilih yang diterima** | **PASS 32/32 · FAIL 0 · SKIP 0** | Terpisah dari test E2E yang berstatus SKIP. |
| E2E terintegrasi / sertifikasi | **SKIP / NOT CERTIFIED** | G9 tetap terbuka; tidak ada klaim cutover atau sertifikasi. |

### Catatan atas draft eksplorasi yang tidak diterima sebagai bukti

Draft sebelumnya sempat menjalankan seluruh journey setelah fixture memanggil `handoffRuntimeRepository.createIntegration()` dan `handymanCareActorService.setIntegrationActorCapability()` secara langsung. Setelah peninjauan blocker G9, jalur fixture itu ditolak sebagai **tidak membuktikan provisioning yang berotorisasi**. Green run draft tersebut **tidak dihitung sebagai PASS** dan tidak boleh dikutip sebagai sertifikasi. Delapan percobaan awal draft juga gagal pada setup/asersi test (relasi space, tipe/alias query read-only, correlation ID, dan bentuk read setelah approval); kegagalan itu diperbaiki di draft, tetapi keseluruhan draft tetap tidak valid untuk penerimaan G9. Artefak akhir sekarang hanya mencatat SKIP dan tidak berisi pemanggilan provisioning tersebut.

## 3. Regresi yang dijalankan dan metode database

- Digunakan satu server PostgreSQL 18.4 terisolasi (`127.0.0.1:43217`) dan satu template `w03h05_template` yang dimigrasikan **sekali**: `appliedNow=443`.
- Setiap regresi berjalan pada database klon terisolasi dari template tersebut: `w03h05_intake`, `asentra_test`, dan `w03h05_scope`. Hook test menjalankan migration runner, tetapi klon sudah berasal dari template bermigrasi.
- Test journey draft yang tidak diterima pernah memakai klon terpisah; hasilnya tidak masuk hitungan PASS di §2.
- Server PostgreSQL dihentikan setelah validasi dan launcher sementara dihapus. Tidak ada database atau launcher sementara yang ditambahkan ke Git.
- Semua focused run selesai di bawah batas 120 detik.

| Perintah terfokus | Cakupan yang lulus |
|---|---|
| `tsx --test --test-concurrency=1 tests/handyman-intake-triage-journey.test.ts` | 16 test W02 PART 04 + 11 test W02 PART 04A: **27/27**. |
| `tsx --test --test-concurrency=1 --test-name-pattern='binds an eligible PIC with server-derived lineage and an id-only audit trail|keeps a caller out of a thread it is not assigned to, and a manage-holder out of a binding|replays an identical Idempotency-Key and conflicts on a different body|serves bind, revoke and read over HTTP and structurally ignores smuggled keys' tests/handyman-quotation-approval-binding-runtime.test.ts` | **4/4** subtest terpilih. |
| `tsx --test --test-concurrency=1 --test-name-pattern='rolls back ledger, lifecycle, scope and journals on a DB-floor refusal; same-key retry is safe' tests/handyman-execution-scope-approval-gate.test.ts` | **1/1** subtest rollback terpilih. Penolakan DB-floor adalah bagian dari test rollback yang diharapkan. |
| `tsx --test --test-concurrency=1 tests/handyman-w03-03h05-integrated-journey.test.ts` | **SKIP 1/1** karena G9; test akhir tidak membutuhkan/menyentuh database. |

Full `handyman-pic-portal-decide` dan full `handyman-execution-scope-approval-gate` tidak dijalankan karena file tersebut berisi fixture yang menulis langsung ke record keputusan/binding/Execution Scope yang dilindungi. Hanya subtest rollback yang dipilih dan telah dipastikan relevan dijalankan. Tidak ada full suite, repo-wide typecheck, atau perubahan runtime.

## 4. Intended chain dan assertions yang belum dapat disertifikasi

Test yang direncanakan adalah satu tenant/building/request thread:

1. Customer Care signed session, property exchange, assisted intake, dan replay penolakan exchange.
2. Operations queue/detail, triage, diagnosis.
3. Quotation create, issue; staff approval mencoba dan harus menerima 403.
4. Staff approval binding melalui API dengan `Idempotency-Key`.
5. PIC session dan read; wrong-tenant serta wrong-building harus sama-sama menghasilkan uniform 404.
6. Scope harus tidak ada sebelum PIC `APPROVE`; keputusan dan scope hanya boleh dibuat oleh jalur API produksi.
7. Replay PIC approval tidak boleh menambah keputusan, scope, atau audit; verifikasi ledger/audit bersifat read-only.

Rantai dan assertions tersebut **belum diterima sebagai hasil 03H-05**. Draft yang sempat menjalankannya memakai provisioning TENANT_PIC tanpa acting-user authorization, sehingga hasilnya tidak dapat mengatasi G9. Regression yang PASS di §2 hanya bukti pada cakupan masing-masing.

## 5. Guardrails dan certification limits

- G9 tetap **OPEN / BLOCKER untuk rollout**: Operations + Security harus menetapkan jalur provisioning TENANT_PIC yang sah, dengan atribusi actor dan kontrol/audit operasional yang sesuai. Tidak ada actor atau prosedur yang dikarang oleh test.
- B12 tetap **OFF**. Tidak ada perubahan ke rollout flag, runtime, migration, ledger, atau otoritas Execution Scope.
- Tidak ada SQL write ke keputusan, approval binding, atau Execution Scope pada artefak akhir. Protected writes pada regresi yang dipilih tetap melewati API/service yang diuji; query inspeksi hanya read-only.
- Bukti staging, provisioning produksi, dan secret lifecycle tetap **UNVERIFIED**.
- Karena test integrated berstatus SKIP, tidak ada klaim bahwa seluruh rantai Customer Care → Operations → PIC → Execution Scope telah lulus atau bahwa E2E telah CERTIFIED.
- Tidak ada PR atau deploy.

## 6. Langkah penutupan blocker

1. Operations/Security mendefinisikan dan mendokumentasikan provisioning integrasi/capability TENANT_PIC dengan acting-user authorization, atribusi, dan audit.
2. Setelah jalur itu tersedia, siapkan fixture isolated yang melalui jalur berotorisasi tersebut; jangan mengaktifkan test dengan direct repository call atau setter tanpa actor.
3. Jalankan ulang satu integrated journey dan hanya regresi relevan pada PostgreSQL nyata, satu template migrasi, dan database terisolasi.
4. Perbarui status PASS/FAIL/SKIP dan batas sertifikasi berdasarkan run yang sah; sampai saat itu **E2E NOT CERTIFIED**.
