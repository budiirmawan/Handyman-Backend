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
