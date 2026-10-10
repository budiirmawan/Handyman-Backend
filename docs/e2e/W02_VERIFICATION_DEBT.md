# W02 Verification Debt & Permission Registry Reconciliation

Dokumen ini adalah register tunggal untuk debt verifikasi W02 dan hasil reconciliation permission registry (PART 02B).
Baseline: `9522f99`. Branch: `arena/c6fc25e1-handyman-backend`.

## 1. Reconciliation: ROUTE-TO-REGISTRY (`config-perm-01` test 13)

### Akar masalah (terbukti)

- Test `config-perm-01` memeriksa bahwa setiap `requirePermission(...)` yang di-mount ada di `FOUNDATION_PERMISSIONS`.
- `handyman.payment.report` dan `handyman.payment.verify` dipakai oleh route ledger/payment (`handyman-customer-ledger-api.routes.ts`).
- Kedua kode didaftarkan hanya di migration `0432_handyman_care_actor_payment_permission`. Tidak ada di seed `FOUNDATION_PERMISSIONS`.
- Akibatnya test gagal sejak PART 05/06. Sudah dibuktikan dengan menjalankan test pada HEAD `954a013` (stash sementara), hasilnya sama.

### Keputusan registry (PART 02B)

| Kode | Nama (sama dengan migration 0432) | Terdaftar di seed | Default grant | Batasan |
|---|---|---|---|---|
| `handyman.payment.report` | Report Handyman Customer Payments | Ya | Tidak ada (UNASSIGNED) | Satu-satunya kode yang boleh ada pada grant Care Actor (CHECK 0432) |
| `handyman.payment.verify` | Verify Handyman Customer Payments | Ya | Tidak ada (UNASSIGNED) | User RBAC saja. Tidak boleh pada Care Actor. Maker-checker tetap berlaku |

Perubahan:
- `src/database/seeds/foundation-access.seed.ts`: dua kode ditambahkan ke `FOUNDATION_PERMISSIONS` dan `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`.
- `tests/config-perm-01-permission-registry.test.ts`: jumlah katalog 353 menjadi 355, dan dua kode masuk daftar unassigned yang diharapkan.

Tidak berubah: migration 0432 (tidak diedit), route, controller, payment workflow, C6, dan semua grant yang ada.

### Bukti tidak ada auto-grant

Test `tests/handyman-payment-permission-registry.test.ts` (5 test, PASS) pada DB yang baru di-migrate:
1. Kedua kode terdaftar tepat sekali, ACTIVE, dengan nama migration 0432.
2. Sebelum seed: tidak ada grant role untuk kedua kode.
3. Setelah seed foundation yang sebenarnya dijalankan (`foundationAccessSeed.run`): tetap tidak ada grant role. Sebagai sanity check, seed memang berjalan, karena PLATFORM_ADMIN memegang `tenant_company.read`.
4. User dengan role PLATFORM_ADMIN: `resolvePermissionsForUser` tidak mengembalikan kedua kode, sementara `tenant_company.read` tetap resolve.
5. CHECK allowlist Care Actor (`handyman_care_actor_perm_grants_code_check`) menolak `handyman.payment.verify` dengan SQLSTATE 23514.

## 2. Hasil test

### Focused (PART 02B)

| File | Hasil |
|---|---|
| `config-perm-01-permission-registry.test.ts` | 13 PASS (termasuk ROUTE-TO-REGISTRY yang sebelumnya gagal) |
| `handyman-payment-permission-registry.test.ts` | 5 PASS |
| `handyman-payment-verification-authority.test.ts` | PASS |
| `handyman-care-workspace-payment-report.test.ts` | PASS |
| `handyman-care-admin-provisioning.test.ts` | PASS |
| `handyman-customer-care-ledger.test.ts` | PASS |
| `handyman-customer-care-transport-certification.test.ts` | PASS, 2 SKIP (lihat §3, D-2) |
| **Total** | **61 PASS, 0 FAIL, 2 SKIP** (63 test) |

Typecheck: `npx tsc --noEmit` exit 0.

### Mutation check

Tidak dijalankan untuk PART 02B. Tidak ada perubahan runtime authorization. Bukti tidak ada auto-grant berasal dari test runtime di §1.

## 3. Verification debt register

| ID | Debt | Status | Bukti / alasan | Rencana |
|---|---|---|---|---|
| D-1 | ROUTE-TO-REGISTRY (payment codes tidak terdaftar di seed) | **RESOLVED (PART 02B)** | §1, `config-perm-01` 13/13 PASS | — |
| D-2 | Dua assertion historis di `handyman-customer-care-transport-certification` (commit `b87d72f` dan `2fcfad9`) | SKIP eksplisit (sudah ada) | Commit tidak ada di repo atau remote. Skip diberi alasan eksplisit. Pemeriksaan struktural tetap berjalan | Hanya bisa diverifikasi jika baseline historis tersedia |
| D-3 | Test `r08-part01b-operational-detail-evidence` dan `r08-part02b-operational-detail-finding` mengasumsikan 348 migration. Repo sekarang 434 file migration (`0001`–`0434`) | Belum diverifikasi, ini bukan regresi PART 02B | Tidak dijalankan di PART ini | Perbaikan terpisah, di luar W02 |
| D-4 | Seed dijalankan pada DB non-embedded dalam test runtime (`handyman-payment-permission-registry`) | Risiko kecil | Di mode embedded, DB direset. Di mode non-embedded, seed menambah grant ke PLATFORM_ADMIN di DB bersama | Gunakan embedded untuk CI atau isolasi DB |
| D-5 | Payment registry tidak punya route guard test baru | Di luar cakupan | Route guard dicakup oleh test payment authorization yang sudah ada | — |
| D-6 | Frontend Customer Care dan Operations | UNVERIFIED | Tidak ada di repo ini | Repo frontend |
| D-7 | E2E lintas repo | Tidak diklaim | Tidak ada bukti | — |
| D-8 | Provisioning role Operations produksi (`handyman.operations.request.read`) | Keputusan terbuka | Tidak ada grant dari kode | Lihat `W02_OPERATIONS_QUEUE_HANDOFF.md` §2 |
| D-9 | Reporter, PIC approval, notifikasi, dan audit create W02 | Belum diimplementasi | Lihat gap reconciliation | PART 10 sampai PART 12 |

## 4. Residual

- Tidak ada kegagalan P0 yang bersifat registry atau authorization dari PART 02B.
- Keputusan terbuka tetap: R-2 (operator building melihat semua tenant di building) dan provisioning role Operations (D-8).
- PLATFORM_ADMIN tidak menerima `handyman.payment.report` maupun `handyman.payment.verify` secara default. Jika bisnis ingin memberikannya, itu harus lewat keputusan provisioning terpisah dan tercatat.

## 5. W02 PART 03 — Reporter identity, contact & request provenance

### Pemisahan peran (data only, tanpa authority)

| Peran | Disimpan di | Authority |
|---|---|---|
| Tenant Company (penerima layanan) | `handyman_service_requests.tenant_company_id` (dari attribution) | Tidak berubah |
| Actual Reporter (yang menyampaikan) | `handyman_service_request_contacts.reporter_*` | Tidak ada. Data snapshot |
| Contact Person (untuk koordinasi) | `handyman_service_request_contacts.contact_person_*` | Tidak ada. Data snapshot |
| PIC Approver (approval quotation) | `tenant_pics` (tidak diubah) | Aturan approval quotation tidak diubah |
| Customer Care Actor (pencatat) | `captured_by_care_actor_id` (dari attestasi exchange) | Permission care tidak diubah |

### Perubahan schema (additive)

- Migration `0435_handyman_service_request_contacts`: tabel baru, 1:1 dengan request (`UNIQUE handyman_request_id`).
- Kolom: `reporter_name` (wajib), `reporter_phone`, `reporter_email`, `contact_person_name`, `contact_person_phone`, `contact_person_email`, `captured_by_care_actor_id`, `captured_at` (`clock_timestamp()`), `channel_attribution_id`.
- CHECK database: panjang nama 1-120 (setelah trim), format telepon `^[+]?[0-9]{6,15}$`, format email dan panjang ≤254, dan contact person wajib nama plus telepon atau email.
- Append-only: trigger BEFORE UPDATE dan BEFORE DELETE memblokir perubahan.
- Tidak ada kolom baru di `handyman_service_requests`, tidak ada perubahan di `handyman_channel_attributions`, dan tidak ada FK ke `tenant_pics`, `users` atau permission.

### Perubahan API (additive)

- `POST /handyman/requests/care` menerima `reporter` dan `contactPerson` (opsional). `required` tetap `[exchangeToken, serviceCatalogId]`. Field lain tetap ditolak.
- Tanpa `reporter`, perilaku lama dipertahankan dan tidak ada snapshot yang disimpan.
- `GET /handyman/operations/requests[/:id]` menambah `contact` (nullable): `{ capturedAt, reporter, contactPerson }`. Akses tetap lewat permission `handyman.operations.request.read` dan assignment Building.
- Respons create dan semua read C6 tidak berubah. Snapshot tidak diekspos di sana.
- OpenAPI: `CreateCareHandymanServiceRequest` (+ `reporter`, `contactPerson`), komponen baru `HandymanRequestContactInput` dan `HandymanRequestContactSnapshot`, serta `HandymanOperationsRequest.contact`.

### Alur penulisan (transaksi tunggal)

Validasi input dilakukan SEBELUM exchange dikonsumsi, sehingga input tidak valid tidak membakar token. Di dalam satu transaksi, exchange dikonsumsi, attribution dibuat, request dibuat, lalu snapshot ditulis. Jika salah satu gagal, semuanya di-rollback.

### Bukti keamanan (runtime, `tests/handyman-request-reporter-contact.test.ts`)

- Input tidak valid (16 kasus: nama kosong/terlalu panjang/karakter kontrol, telepon, email, field tidak dikenal, `tenantPicId` dan `userId` yang disuntikkan, contact person tanpa reporter, contact person tanpa telepon/email) menghasilkan 400. Nilai input tidak pernah di-echo ke respons. Exchange tetap bisa dipakai setelah semua penolakan itu.
- Replay satu exchange menghasilkan 401. Snapshot asli tidak ditimpa.
- Dua penggunaan simultan satu exchange menghasilkan tepat satu 201 dan satu 401, dengan satu snapshot.
- Sesi care workspace yang dicabut tidak bisa menerbitkan exchange. Tidak ada request atau snapshot baru.
- Operations queue: operator Building lain (client lain) tidak melihat baris dan mendapat 404 pada detail yang sama. Operator tanpa assignment mendapat 403.
- C6: pengecekan rekursif memastikan tidak ada key `reporter`, `contact`, `contactPerson`, `contactCapturedAt` atau `capturedAt` di respons. Nilai snapshot tidak muncul, walaupun request yang sama terlihat di C6 oleh PIC tenant.
- Isolasi PIC approval: nama dan email yang sama dengan PIC tidak membuat baris `tenant_pics` atau `users`, tidak mengubah assignment dan role PIC, dan tidak memberi akses ke Operations queue (403). `tenant_pic_id` request tetap berasal dari attribution.
- Append-only: UPDATE dan DELETE ditolak database. Constraint UNIQUE dan CHECK juga ditest langsung.

### Hasil test (PART 03)

| Suite | Hasil |
|---|---|
| `handyman-request-reporter-contact.test.ts` (baru) | 11 PASS, 0 FAIL, 0 SKIP |
| Run final: `handyman-request-reporter-contact` + `handyman-operations-queue` + `handyman-care-request-create` | 40 PASS, 0 FAIL, 0 SKIP |
| 7 file care/operations/intake (`care-request-create`, `operations-queue`, `care-workspace-create-exchange`, `service-request-intake-scope-guard`, `care-workspace-requests`, `care-workspace-request-detail`, `care-workspace-admission`) | 95 PASS, 0 FAIL, 0 SKIP |
| `config-perm-01`, `handyman-payment-permission-registry`, `handyman-payment-verification-authority` | 25 PASS, 0 FAIL |
| `npx tsc --noEmit` | exit 0 |

Catatan proses: satu test registry (PART 02B) gagal pada DB bersama yang persisten, karena test lain membuat role fixture `SCOPED_*` yang memegang kode payment. Itu bukan auto-grant seed atau migration. Assertion diubah menjadi delta seed dan pengecekan khusus PLATFORM_ADMIN. Test PART 02B tetap membuktikan bahwa seed tidak menambah grant dan PLATFORM_ADMIN tidak mewarisi kedua kode.

### Ekspektasi test yang diubah (perlu ditinjau)

- `tests/handyman-care-request-create.test.ts` (test DTO OpenAPI): daftar properti persis ditambah `reporter` dan `contactPerson`. `required` tidak berubah. Ini perubahan kontrak aditif yang disengaja.

### Residual PART 03

- R-P3-1: `reporter` belum wajib di API. Ini sengaja demi kompatibilitas mundur. Keputusan bisnis diperlukan jika wajib.
- R-P3-2: nilai reporter dan contact tidak diverifikasi identitasnya. Ini hanya snapshot yang dicatat Customer Care.
- R-P3-3: C6 `actorReference` sudah ada sebelum PART 03 dan tetap dikembalikan. Field ini bukan bagian dari PART 03 dan tidak diubah.
- R-P3-4: tidak ada baris audit event terpisah. Provenans diwakili oleh `captured_by_care_actor_id`, `captured_at`, dan `channel_attribution_id`.
- R-P3-5: R-2 (operator Building melihat semua tenant di Building) tetap terbuka. Operations queue kini juga menampilkan data kontak pelapor untuk baris yang terlihat.
- R-P3-6: E2E lintas repo belum dibuktikan. Frontend Customer Care dan Operations tetap UNVERIFIED (D-6).
- R-P3-7: DB test non-embedded bersifat persisten. Assertion yang bergantung pada state global harus memakai delta (lihat catatan proses di atas).

## 6. W02 PART 04 — Intake → Operations triage runtime journey

Test: `tests/handyman-intake-triage-journey.test.ts` (16 test: 4 journey J1–J4, 9 negatif N1–N9, 3 replay R1–R3). Tidak ada perubahan source. Tidak ada endpoint, permission, atau schema baru.

### Journey (real endpoint, real authority)

| Step | Hasil | Bukti |
|---|---|---|
| J1 Customer Care intake → create-exchange (tenant + unit) → POST care intake → INTAKE + reporter snapshot | PASS | status INTAKE, tenant/building/space sesuai pilihan, `originChannel` BM_SUPER_APP, 1 snapshot |
| J2 Operations queue (`status=INTAKE`) dan detail konsisten dengan intake | PASS | tenant, location, attribution (careActorId), contact, PIC id dari attribution |
| J3 Triage (`POST .../triage`, authority existing) → INSPECTION_REQUIRED | PASS | 201, 1 decision record, 1 audit `HANDYMAN_REQUEST_TRIAGED` (actor, building, disposition; tanpa teks note) |
| J4 Queue setelah triage: hilang dari INTAKE, muncul di INSPECTION_REQUIRED, tetap ada di default list; tenant, lokasi, dan snapshot tidak berubah; triage read 200 | PASS | |

### Negative cases

| Case | Hasil |
|---|---|
| N1 operator hanya punya queue permission mencoba triage | 403, status tetap INTAKE, 0 event |
| N2 cross-building (operator Building A2, request di A): triage 403; queue detail 404 | PASS |
| N3 cross-client: 403 triage, 404 detail | PASS |
| N4 assignment dicabut: triage 403, queue 403 | PASS |
| N5 tanpa assignment / tanpa permission / token tidak valid | 403, 403, 401 |
| N6 Care workspace token sebagai operator (triage dan queue) | 401 |
| N7 disposition tidak valid, note kosong atau >500, field body asing | 400 (5 payload), status tetap INTAKE |
| N8 triage ulang request yang sudah TRIAGED | 400 `HANDYMAN_SERVICE_REQUEST_NOT_INTAKE`, status tidak mundur |
| N9 request di luar scope / id tidak dikenal / id bukan UUID | 404 / 400. Field `status` di body tidak berpengaruh |

### Replay & idempotency

| Case | Hasil |
|---|---|
| R1 triage berulang 3 kali | 3x 400, tepat 1 decision, tepat 1 event |
| R2 dua triage paralel | tepat 1 x 201 dan 1 x 400, 1 decision, 1 event, status = disposition pemenang |
| R3 replay care exchange | 401, tidak ada request atau snapshot baru |

### Hasil regresi (run bersama)

| Suite | Hasil |
|---|---|
| `handyman-intake-triage-journey` (baru) | 16 PASS |
| `handyman-lifecycle-api` | PASS (termasuk triage existing) |
| `handyman-building-scope-guard-part02` | PASS |
| `handyman-operations-queue` | PASS |
| `handyman-request-reporter-contact` | PASS |
| Subtotal 5 file | 65 PASS, 0 FAIL, 0 SKIP |
| `npx tsc --noEmit` | exit 0 |

### Temuan authority (keputusan, belum diubah)

- `POST /handyman/requests/:id/triage` dijaga `tenant_company.manage` dan Building scope. `GET .../triage` dijaga `tenant_company.read`. Permission queue `handyman.operations.request.read` saja tidak cukup untuk triage atau membaca hasil triage.
- (Diperbarui di W02 PART 04A, §7: POST triage sekarang memakai `handyman.operations.request.triage`.)
- Ini mengikuti authority triage yang sudah ada pada saat PART 04 ditulis dan tidak diubah di PART itu. Operator Operations yang hanya diberi queue permission tidak bisa menyelesaikan triage. Jika bisnis ingin permission triage khusus Operations (misalnya `handyman.operations.request.triage`), itu perubahan authority dan route yang perlu keputusan tersendiri.

### Residual gap menuju W02 closure

- R-T1: keputusan authority triage Operations (lihat di atas).
- R-T2: quotation, PIC approval, cancellation, notification, dan frontend tidak diimplementasikan di PART ini (sesuai scope).
- R-T3: runtime E2E belum mencakup inspection, diagnosis, atau transisi setelah TRIAGED. Hanya triage dan status projection yang dibuktikan.
- R-T4: DB test bersama bersifat persisten. Test memakai data unik dan membaca per-operator, tetapi assertion global tetap perlu delta bila ditambah.
- R-2 (operator Building melihat semua tenant di Building) dan provisioning role Operations produksi tetap terbuka.

## 7. W02 PART 04A — Operations triage authority separation

Menutup R-T1 (§6) untuk sisi POST. Lifecycle, C6, dan Customer Care tidak diubah.

### Authority (sebelum → sesudah)

| Route | Sebelum | Sesudah |
|---|---|---|
| `POST /handyman/requests/:id/triage` | `tenant_company.manage` + Building scope | `handyman.operations.request.triage` + Building scope (ACTIVE assignment) |
| `GET /handyman/requests/:id/triage` | `tenant_company.read` + Building scope | `tenant_company.read` ATAU `handyman.operations.request.read` (any-of) + Building scope yang sama dengan Operations Queue |

- Permission baru `handyman.operations.request.triage` didaftarkan di katalog (`foundation-access.seed.ts`) dan migrasi `0436` (additive, `ON CONFLICT DO NOTHING`).
- Masuk `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`. Tidak ada grant ke role mana pun, termasuk PLATFORM_ADMIN. Tidak ada auto-grant.
- Tidak ada fallback ke `tenant_company.manage`. Itu keputusan eksplisit yang belum diambil.
- Generic `/handyman/requests*` tidak diperluas. Queue permission tidak membuka generic request.
- Middleware baru `requireAnyPermission` (additive) di `rbac.middleware.ts`, dipakai hanya untuk GET triage.
- Validasi bisnis, status transition, audit (`HANDYMAN_REQUEST_TRIAGED`), concurrency, dan idempotency tidak berubah. Perubahan hanya di gate route.

### Dampak kompatibilitas dan provisioning

- Pengguna dengan `tenant_company.manage` saja tidak bisa lagi POST triage (403). Ini perubahan perilaku yang disengaja.
- PLATFORM_ADMIN tidak lagi menerima triage secara implisit. Akses triage harus diberikan lewat provisioning eksplisit (`handyman.operations.request.triage`) ke role Operations.
- Caller GET triage existing (`tenant_company.read`) tidak terdampak.
- Operator queue (`handyman.operations.request.read`) sekarang bisa GET triage pada request di Building yang di-assign. Ini disengaja karena scope-nya sama dengan queue.
- Data produksi tidak diubah. Operator Operations yang ada perlu diberi permission triage oleh provisioning sebelum bisa triage.
- Down-migration `0436` hanya menghapus katalog bila tidak ada grant.

### Bukti (runtime)

- `tests/handyman-intake-triage-journey.test.ts`: 27/27 PASS (16 lama + 11 authority PART 04A). Mencakup read-only ditolak, triage permission + assignment diterima tanpa `tenant_company.read`, manage-only ditolak, tanpa assignment, cross-building, cross-client, revoked role, inactive user (401), GET sesuai read authority, generic C6 tidak berubah, registry, dan no-auto-grant.
- `tests/handyman-lifecycle-api.test.ts`: triage memakai operator triage khusus. Admin tanpa triage mendapat 403 di POST. GET tetap 200 untuk admin.
- `tests/handyman-building-scope-guard-part02.test.ts`: aktor triage diberi permission eksplisit di fixture (`extraCodes`). Negatif tetap ditolak oleh Building scope.
- `tests/config-perm-01-permission-registry.test.ts`: katalog 355 → 356, daftar unassigned ditambah.
- Regresi `handyman-operations-queue` dan `handyman-request-reporter-contact` PASS.
- `npx tsc --noEmit -p .` exit 0. Full suite tidak dijalankan (sesuai instruksi).
- Focused total: 62/62 PASS (lifecycle, building-scope, operations-queue, reporter-contact, config-perm-01). Building-scope membutuhkan PostgreSQL via `DB_*`.

### Residual PART 04A

- R-P4A-1: keputusan fallback `tenant_company.manage` untuk triage belum diambil. Saat ini tidak ada fallback.
- R-P4A-2: provisioning role Operations produksi (grant `handyman.operations.request.triage`) belum dilakukan. Itu operasi administratif, bukan perubahan kode.
- R-P4A-3: tidak ada UI untuk memberi permission ini. Dikelola lewat RBAC yang ada.
- R-T2, R-T3, R-T4 dari §6 tetap berlaku. Quotation, PIC approval, cancellation, dan notification tetap di luar scope.

## 8. W02 PART 05 — Request create audit & notification closure

Menutup gap "create request tanpa audit event" dan memberi notification handoff yang bisa ditelusuri. Journey (PART 04) dan kontrak lifecycle tidak diubah.

### Rekonsiliasi (sebelum PART 05)

- Create request tidak menulis event apa pun. Event Handyman yang sudah ada: `HANDYMAN_REQUEST_TRIAGED`, `HANDYMAN_INSPECTION_RECORDED`, `HANDYMAN_DIAGNOSIS_RECORDED`, `HANDYMAN_REFERRAL_CREATED`, dan event care-grant. Tidak ada event untuk request-created.
- `recordHandymanEvent` (seam audit Handyman, admission fail-closed) dan `emitHandymanNotificationIntent` (seam intent notifikasi) sudah ada, tetapi sebelumnya tidak dipakai di jalur create.
- Pembedaan yang dipakai:
  - **Audit event**: baris `operational_events` (append-only, fakta bisnis).
  - **Domain event**: event yang sama, dengan `factKind: DOMAIN` di kontrak audit.
  - **Notification intent**: keluaran `emitHandymanNotificationIntent`. Tidak dibuat untuk create (lihat di bawah).
  - **Delivery receipt**: baris `notification_outbound_deliveries` / `notifications`. Tidak dibuat untuk create.
- Tidak ada migrasi. `operational_events.event_type` berupa TEXT tanpa CHECK allowlist. Tidak ada perubahan API, sehingga OpenAPI tidak diubah.

### Event contract: `HANDYMAN_REQUEST_CREATED`

- Ditulis oleh `recordHandymanEvent` di **executor transaksi yang sama** dengan insert request (atomik). Berlaku untuk jalur Customer Care (`createCareHandymanServiceRequest`) dan jalur local-user (`createHandymanServiceRequest`, sekarang juga dibungkus transaksi).
- Entity: `HANDYMAN_SERVICE_REQUEST` / `entity_id` = request ID.
- Kolom: `client_id`, `building_id` (dari snapshot attribution), `actor_user_id` (null pada Care path), `request_id` dan `source` (korelasi HTTP, tidak bisa di-override), `occurred_at`.
- `metadata`: `channelAttributionId`, `tenantCompanyId`, `spaceId`, `actorType`, `careActorId`, `originChannel`, `notificationHandoff`.
- `summary`: `Handyman service request created.` (tanpa data pribadi).
- Tidak berisi: nama, telepon, email reporter atau contact person, exchange token, workspace token, assertion, password, atau key rahasia. Metadata ikut dibawa ke payload outbox integrasi, sehingga hanya identitas yang boleh masuk.

### Notification handoff

- Status: **`BLOCKED_BY_POLICY`**, reason `RECIPIENT_CHANNEL_POLICY_NOT_DEFINED`.
- Alasan: kontrak notifikasi Handyman menyatakan audience `SUBSCRIPTION_RULE` (BE-26D). Resolusi penerima BE-26C dapat menjangkau `TENANT_PIC`. Itu tidak boleh dinotifikasi tanpa kontak terverifikasi dan kebijakan channel. Tidak ada recipient atau channel policy Handyman untuk create, sehingga intent tidak dipanggil.
- Tidak ada delivery yang diklaim. Test A3 membuktikan tidak ada baris notification intent atau delivery yang dibuat.
- Entri kontrak `HANDYMAN_REQUEST_CREATED` ditambahkan ke `HANDYMAN_NOTIFICATION_CONTRACT` (audience `SUBSCRIPTION_RULE`, templateKey `HANDYMAN_REQUEST_CREATED`) sebagai seam siap aktivasi.
- Fan-out integrasi (outbox) mengikuti mekanisme existing: baris outbox hanya ada jika ada endpoint webhook aktif. Default-nya dark, dan test A3 memastikan tidak ada baris outbox untuk event create.

### Keamanan (bukti runtime)

- A2: event tidak memuat nama, telepon, email reporter/contact, exchange token, atau kata `assertion`. Data reporter tetap di store kontak PART 03.
- D1: key credential-like di body HTTP ditolak 400 sebelum transaksi (tidak ada request, tidak ada event, exchange tidak terkonsumsi).
- D2: seam audit membuang key sensitif (`token`, `accessToken`, `assertion`, `authorization`) sebelum persist, dan mempertahankan key non-sensitif.

### Hasil test

- `tests/handyman-request-create-audit-part05.test.ts`: 10/10 PASS.
  - A1 create sukses: tepat satu event, dengan request, tenant, building, attribution, actor type, timestamp, dan korelasi HTTP.
  - A2 tidak ada data sensitif di event.
  - A3 notification handoff `BLOCKED_BY_POLICY`, tanpa intent, delivery, atau outbox.
  - A4 request tetap `INTAKE`.
  - B1 create gagal (service tidak dikenal): tanpa event, tanpa request, exchange tidak terkonsumsi, retry berhasil dengan tepat satu event.
  - B2 rollback: fault injection di level DB (trigger sementara yang melempar saat event create ditulis). Request, attribution, dan contact tidak tersisa. Exchange tidak terkonsumsi. Retry tanpa fault menghasilkan tepat satu request dan satu event. Trigger dihapus setelah test.
  - C1 replay exchange: 401, tanpa request, event, atau contact kedua.
  - C2 concurrent (3 request paralel, satu exchange): tepat satu 201, satu request, satu event.
  - D1, D2 seperti di atas.
- Regresi fokus (bersama): **164/164 PASS**. Termasuk journey PART 04 (27), lifecycle, building-scope, operations-queue, care-request-create, api, channel-attributions, reporter-contact, handoff attribution (2), audit/integration part03, notification contract part02, dan config-perm-01.
- Dua test kontrak (`HANDYMAN_AUDIT_EVENT_CONTRACT` 15→16, `HANDYMAN_NOTIFICATION_CONTRACT` 12→13) diperbarui secara sadar. Teks `meaning` sempat memuat kata "channel" dan gagal test channel-free. Sudah diperbaiki menjadi "origin attribution snapshot".
- `npx tsc --noEmit -p .`: exit 0. Full suite tidak dijalankan.

### Residual PART 05

- R-P5-1: recipient dan channel policy untuk `HANDYMAN_REQUEST_CREATED` belum didefinisikan. Aktivasi memerlukan keputusan: siapa penerimanya (PIC hanya dengan kontak terverifikasi dan consent), channel apa, dan apakah emisi dilakukan setelah commit lewat `emitHandymanNotificationIntent`.
- R-P5-2: `notificationHandoff` adalah snapshot saat create. Jika policy diaktifkan nanti, status delivery harus dilacak di ledger notifikasi yang ada, bukan dengan memperbarui event (append-only).
- R-P5-3 (DITUTUP di final validation): jalur local-user diuji F1–F3 (atomik, rollback, tanpa assignment).
- R-P5-4 (DITUTUP di final validation): fan-out outbox dengan endpoint aktif diuji di E1 (satu marker, payload bersih, replay tidak menambah marker).
- R-P5-5: komentar header journey PART 04 masih menyebut `tenant_company.manage` untuk triage. Itu komentar stale. Perilaku yang berlaku diuji di PART 04A. Journey dibiarkan tidak berubah karena frozen.
- R-P5-6: fault trigger dibuat di DB uji bersama dan dihapus setelah test. Risiko R-T4 (DB uji persisten) tetap berlaku.

### Final validation (W02 PART 05, run lanjutan)

- Audit atomik: care-path (A1, B2) dan local-user path (F1, F2) menulis event pada executor transaksi yang sama dengan insert request. Kegagalan audit membatalkan request, attribution, dan contact (B2, F2).
- Replay (C1, E1), concurrency (C2), rollback (B2, F2), dan fault injection tidak meninggalkan duplicate event, request, atau outbox marker.
- Event dan outbox payload (E1) tidak memuat nama, telepon, email, exchange token, workspace token, atau assertion. Metadata hanya berisi identitas (`channelAttributionId`, `tenantCompanyId`, `spaceId`, `actorType`, `careActorId`, `originChannel`, `notificationHandoff`).
- Notification intent tidak diterbitkan karena recipient/channel policy belum ditetapkan (A3). Status `BLOCKED_BY_POLICY` adalah **status evaluasi** yang dicatat di event. Ini bukan klaim delivery. Tidak ada baris `notifications` atau `notification_outbound_deliveries` yang dibuat.
- Test: `tests/handyman-request-create-audit-part05.test.ts` 14/14 PASS (A1–A4, B1–B2, C1–C2, D1–D2, E1, F1–F3).
- Regresi fokus (run final, 14 file): **168 PASS, 0 FAIL, 0 SKIP**. File: part05 (14), journey PART 04 (27), care-request-create, api, channel-attributions, reporter-contact, audit-integration part03, notification-contract part02, handoff attribution-binding, handoff care-actor-attribution, building-scope-guard part02, lifecycle-api, operations-queue, config-perm-01.
- `npx tsc --noEmit -p .`: exit 0. `git diff --check`: bersih.

### NOT VERIFIED (jujur, belum dibuktikan)

- Full suite tidak dijalankan (sesuai instruksi PART 05).
- Migrasi down (`0436` dan migrasi PART 05 bila ada) tidak diuji rollback-nya.
- Create path di luar test fokus (mis. modul lain yang memanggil `createHandymanServiceRequest`) hanya dicakup regresi fokus, tidak diuji event-nya secara khusus.
- Pengiriman notifikasi nyata (email, WhatsApp, push, in-app) tidak diuji karena memang BLOCKED_BY_POLICY. Tidak ada klaim delivery.
- Fan-out webhook ke endpoint nyata (HTTP keluar) tidak diuji. Hanya marker outbox yang diverifikasi (E1).

### Residual notification (tetap terbuka)

- R-P5-1: policy recipient dan channel untuk `HANDYMAN_REQUEST_CREATED` belum ditetapkan. Keputusan yang dibutuhkan: penerima (PIC hanya dengan kontak terverifikasi dan consent), channel, dan titik emisi (setelah commit lewat `emitHandymanNotificationIntent`).
- R-P5-2: status `BLOCKED_BY_POLICY` adalah snapshot saat create. Saat policy aktif, status delivery harus dilacak di ledger notifikasi yang ada. Event tidak boleh diperbarui (append-only).

## 9. Verifikasi ulang pasca-reprovision (2026-10-10, sandbox pemulihan)

- Konteks pemutusan. Sesi sebelumnya berhenti tepat setelah commit `43b4b05` ("record final focused results and NOT VERIFIED items", 14:59:37 UTC). Sandbox lalu direprovision menjadi shallow clone `main` (`9602991`): working tree lokal tidak memuat PART 05, `aaf2191` bahkan bukan objek valid di repo lokal, dan tidak ada stash maupun dangling object. Tidak ada pekerjaan yang hilang — seluruh PART 05 sudah ter-push di `origin/arena/c6fc25e1-handyman-backend` (tip `43b4b05`, 18 ahead / 0 behind terhadap `main`). Yang tidak dapat diverifikasi: seandainya ada edit working tree setelah `43b4b05` yang belum di-commit.
- Pemulihan. `43b4b05` di-fast-forward ke branch sesi `arena/44e8ce22-handyman-backend` lalu di-push ke origin. Tidak ada reset, tidak ada rewrite, tidak ada PR. Tree terhadap `43b4b05` identik sampai commit dokumentasi ini.
- Dependensi. `npm ci` = 307 paket, exit 0. Di sandbox ini tidak ada Docker dan tidak ada PostgreSQL sistem.
- PostgreSQL uji. Embedded PostgreSQL 18.4 (paket `embedded-postgres`) dijalankan sebagai server uji tunggal pada 127.0.0.1:55599 dengan database `asentra_test`. File yang memakai `ensureTestDatabase()` diarahkan lewat env `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`/`DB_SSL`; file dengan `ASENTRA_USE_EMBEDDED_POSTGRES=true` membangun klaster sendiri. Ini berbeda dari run §8 yang memakai DB uji persisten (risiko R-T4) — angka di bawah adalah reproduksi independen pada cluster fresh, bukan pengulangan run yang sama.
- Reproduksi hasil. `tests/handyman-request-create-audit-part05.test.ts`: 14/14 PASS. Regresi fokus 14 file, dieksekusi berurutan dengan `--test-concurrency=1`: **168 PASS, 0 FAIL, 0 SKIP** — part05 14, journey PART 04 27, care-request-create 10, api 11, channel-attributions 13, reporter-contact 11, audit-integration part03 9, notification-contract part02 6, handoff attribution-binding 6, handoff care-actor-attribution 10, building-scope-guard part02 9, lifecycle-api 10, operations-queue 19, config-perm-01 13. Identik dengan "Final validation" di §8.
- Static. `npx tsc --noEmit -p .` exit 0. `git diff --check` bersih.
- Yang tidak berubah. Tidak ada file `src/` atau `tests/` yang disunting pada langkah pemulihan. Full suite tetap tidak dijalankan. Daftar NOT VERIFIED dan residual R-P5-1 sampai R-P5-6 di §8 tetap berlaku, termasuk R-P5-1 (recipient dan channel policy `HANDYMAN_REQUEST_CREATED` belum ditetapkan) yang masih menunggu keputusan produk.
- Catatan housekeeping. Repo ini tidak punya `.gitignore`, sehingga `node_modules/` hasil `npm ci` tampil untracked. Sengaja tidak di-commit dan tidak dibuatkan `.gitignore` di sini karena di luar cakupan PART 05.
