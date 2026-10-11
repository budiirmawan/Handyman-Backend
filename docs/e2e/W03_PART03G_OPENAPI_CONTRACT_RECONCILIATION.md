# W03 PART 03G — OpenAPI dan Rekonsiliasi Kontrak

**Tanggal:** 2026-10-11
**Baseline:** `3332a92` (W03 PART 03F), HEAD = remote tip, 0 ahead / 0 behind sebelum edit.
**Otoritas:** CR-HM-06/A01 (F6 v1.1) §9, §10, §13 (baris 03G); ADD-A B1–B5, B8, B13–B18, C21/C22; record 03B, 03B2, 03C, 03D, 03E, 03F.
**Batas:** dokumentasi kontrak dan test kontrak saja. **Tidak ada** perubahan `src/`, migrasi, ledger, decision authority, Execution Scope, atau B12 (tetap OFF). S1 soft-close, 403 staff, dan semua keputusan owner yang sudah diratifikasi dipertahankan. Tidak ada PR, deploy, atau 03H.

## 1. Inventaris kontrak vs kode aktual

| Permukaan | Runtime (sumber) | OpenAPI sebelum 03G | Hasil 03G |
|---|---|---|---|
| PIC session `POST` / `GET` / `DELETE /handyman/pic/session` | `pic-workspace-session.routes.ts` | sudah ada | sesuai, tidak diubah |
| PIC `GET /handyman/pic/requests/{id}` dan `…/approval-eligibility` | `pic-portal.routes.ts` | sudah ada | sesuai, tidak diubah |
| PIC `GET` / `POST /handyman/pic/quotation-versions/{id}/decision` | `pic-portal.routes.ts` | sudah ada | sesuai; respons 201 sudah envelope |
| **Staff binding `POST /handyman/quotations/{id}/approval-binding`** | `handyman-quotations-api.routes.ts` (`bindingPath`) | **tidak ada** | **ditambahkan** (bind, 201) |
| **Staff binding `GET …/approval-binding`** | idem | **tidak ada** | **ditambahkan** (200) |
| **Staff binding `POST …/approval-binding/revoke`** | idem | **tidak ada** | **ditambahkan** (200), dengan catatan B2-D2 (lihat §3) |
| Staff `POST /handyman/quotation-versions/{id}/decision` (S1) | `handyman-quotations-api.routes.ts` + service 403 | sudah ada, `deprecated`, 403 + `Deprecation` + `Link` | respons 201 **dibungkus envelope** (lihat §2 G3) |
| Staff `GET …/decision` | idem | sudah ada | respons 200 **dibungkus envelope** (G3) |
| `decisionActorType` enum | `HANDYMAN_QUOTATION_DECISION_ACTOR_TYPES` = `USER`, `TENANT_PIC`; CHECK `0438` | ada `SYSTEM` di skema PIC | **`SYSTEM` dihapus** (G2) |

## 2. Gap yang terbukti dan diperbaiki

- **G1 — Rute binding staff tidak terdokumentasi.** Tiga operasi PART 03B2 sudah dimount dan dites, tetapi tidak ada di `docs/api/openapi.yaml`. Ditambahkan path, `operationId`, `security: bearerAuth`, `Idempotency-Key` (`IdempotencyKeyHeader`), status 201/200/400/401/403/404/409, dan skema: `HandymanQuotationApprovalBinding`, `…BindingHistoryEntry`, `…Status`, `…BindingRead`, `…BindRequest`, `…BindResult`, `…RevokeRequest`, `…RevokeResult`. Field skema dicocokkan dengan tipe runtime `PublicHandymanQuotationApprovalBinding`, `…Status`, dan `…HistoryEntry` lewat test.
- **G2 — `SYSTEM` tercantum sebagai `decisionActorType` di skema PIC.** Bukti: CHECK `0438` hanya menerima `USER` dan `TENANT_PIC`; `HANDYMAN_QUOTATION_DECISION_ACTOR_TYPES` berisi dua nilai itu; deskripsi skema decision record sendiri menyatakan `SYSTEM` tidak legal. Enum pada skema PIC dikoreksi menjadi `[TENANT_PIC, USER]`.
- **G3 — Envelope respons staff decision tidak sesuai runtime.** Runtime memakai `sendSuccess` (`{success, data, meta}`), sedangkan OpenAPI mendeklarasikan body telanjang. Dikoreksi untuk operasi yang disentuh 03E: POST 201 dan GET 200 `…/decision`, memakai pola `allOf: SuccessEnvelope` yang sama dengan permukaan PIC.

## 3. Deviasi yang dibuka untuk keputusan owner (TIDAK diputuskan di 03G)

- **B2-D2 — Verb revoke binding: POST (shipped) vs DELETE (A01 §9).** A01 §9 mencantumkan `DELETE …/approval-binding` (204). ADD-A C22 secara eksplisit menyebut `POST …/revoke`, dan runtime mengikuti C22 karena `reason` dan cutoff harus dibawa di body. 03G **mendokumentasikan bentuk yang sudah dikirim** (POST), dengan penanda OPEN di deskripsi operasi. **Tidak ada alias DELETE yang ditambahkan.** Keputusan final ada di owner: (a) ratifikasi POST dan revisi baris A01 §9; atau (b) pilih DELETE, yang berarti perubahan runtime dan kontrak di part terpisah. Sampai diputuskan, bagian ini dihentikan.
- **BLK-10 — Tanggal Sunset staff decide.** Tetap terbuka. Tidak ada `Sunset` yang didokumentasikan atau dikirim. Test 03G menguncinya.
- **Penamaan skema PIC.** A01 §9 menyebut `PicWorkspaceBearer`; kontrak memakai `picWorkspaceSession`. Persyaratan substansinya terpenuhi (skema http bearer terpisah, tidak pernah `bearerAuth`), jadi nama tidak diubah.
- **Drift dokumen 03D.** Record 03D menyebut `GET|DELETE /handyman/pic/session/current`. Kode dan OpenAPI memakai `/handyman/pic/session`. Dicatat sebagai drift dokumen, bukan gap kontrak.

## 4. Debt yang sudah ada sebelum 03G (tidak diperbaiki)

- **Validasi OpenAPI penuh belum bersih di baseline.** `@apidevtools/swagger-parser` gagal di `3332a92` dengan ribuan error yang sama polanya (`allOf` + `SuccessEnvelope`). Redocly lint: **670 error di baseline; 670 setelah 03G**, dengan kelas pesan yang identik. Tidak ada error baru pada permukaan yang disentuh.
- **Operasi quotation PART 07A masih telanjang.** 11 operasi (create/read quotation, revisi, lines GET/POST, totals, issue, expire, supersede, presented, execution-scope) dideklarasikan tanpa envelope, padahal runtime memakai envelope. Di luar 03B–03F; tidak diubah.
- **Test `handyman-scope-assignments-api.test.ts`: 9 dari 10 gagal di baseline `3332a92`.** Fixture memanggil decide sebagai staff dan kena S1 `PERMISSION_DENIED`. Ini sisa fixture 03E/03F yang belum dipindah ke PIC. Dibuktikan dengan menjalankan file yang sama di snapshot `3332a92`.
- **Test `handyman-material-execution-api.test.ts` test 6: `9 !== 8` di baseline.** Census `material-lines` di OpenAPI berjumlah 9 path (termasuk root list) sedangkan test mengharapkan 8. Milik modul CR-HM-09, di luar 03G.

## 5. Test kontrak

- `tests/handyman-w03-03g-openapi-contract.test.ts` (baru, 14 test, tanpa database): census dua arah untuk PIC (7 operasi) dan binding staff; tidak ada DELETE alias; verb revoke POST dengan penanda B2-D2; `Idempotency-Key` wajib; status code; field skema = field tipe runtime; semua `$ref` 03G resolve; autentikasi PIC hanya `picWorkspaceSession` (atau HMAC admission); enum actor = vocabulary runtime dan tanpa `SYSTEM`; envelope decision; S1 (403, `Deprecation`, `Link`, tanpa `Sunset`); hanya satu operasi decide di surface staff `/handyman/`.
- `tests/handyman-quotations-api.test.ts` test 10 (census OpenAPI/runtime staff): diperbarui dari 10 path / 13 operasi menjadi 12 path / 16 operasi, karena tiga operasi binding PART 03B2 ada di runtime dan sekarang juga di OpenAPI. Tidak ada asersi yang dilonggarkan; daftar operasi bertambah tiga entri dengan `operationId`.

## 6. Hasil validasi

| Cek | Hasil |
|---|---|
| Verifikasi baseline `3332a92`, ancestry, remote, working tree | PASS |
| `npm run typecheck` (produksi) | **PASS**, exit 0 |
| `tests/handyman-w03-03g-openapi-contract.test.ts` | **14 PASS / 0 FAIL / 0 SKIP** |
| `tests/handyman-quotations-api.test.ts` (seluruh file, DB embedded nyata) | **10 PASS / 0 FAIL / 0 SKIP** |
| `tests/fx06-part06-openapi-contract.test.ts` | **8 PASS / 0 FAIL / 0 SKIP** |
| Redocly lint OpenAPI | 670 → 670 error, tidak ada error baru |
| `@apidevtools/swagger-parser` | FAIL di baseline dan di 03G (debt §4). Jumlah baris error naik karena operasi baru memakai pola envelope yang sama dengan ratusan operasi lama; tidak ada kelas error baru |
| Parse YAML + resolusi `$ref` | PASS, 2389 ref, 0 unresolved |
| `git diff --check` | **PASS** |
| `handyman-scope-assignments-api.test.ts` | FAIL 9/10, **sama di baseline** (§4) |
| `handyman-material-execution-api.test.ts` | FAIL test 6, **sama di baseline** (§4) |

Tidak ada full suite, tidak ada `typecheck:tests`, dan tidak ada audit repo-wide. Database uji adalah PostgreSQL 18.4 embedded yang dijalankan proses lokal di 127.0.0.1:55504, bukan preview.

## 7. Status

- Kontrak runtime yang sudah dikirim (PART 03B–03F) sekarang terdokumentasi di OpenAPI, kecuali bentuk revoke binding yang masih menunggu keputusan owner (B2-D2).
- **Blocker owner:** B2-D2 (verb revoke), BLK-10 (Sunset staff decide), dan keputusan ratifikasi penamaan skema PIC bila diminta.
- 03G tidak menutup debt validasi lama (§4). Sebelum 03H, perlu keputusan apakah debt itu masuk backlog housekeeping.
