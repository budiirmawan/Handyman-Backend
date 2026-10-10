# Handyman Business Journey v1.3 — FROZEN (10 Oktober 2026)

**Status:** FROZEN sebagai baseline bisnis untuk W01 PART 03 dan seterusnya.
**Sumber:** kontrak bisnis v1.3 yang diberikan pemilik produk pada W01 PART 03 (10 Oktober 2026).
**Catatan sumber:** file asli "Handyman Journey v1.3" **belum tersedia di repository** (lihat `docs/HANDYMAN_JOURNEY_LIFECYCLE.json`, masih v1.0). Dokumen ini adalah transkripsi kontrak FROZEN tersebut. Jika file asli v1.3 ditemukan kemudian dan berbeda, file asli menang dan dokumen ini wajib direvisi.
**Lingkup:** dokumen bisnis dan authority. Dokumen ini **tidak** mengubah API, schema, atau business logic.

---

## 1. Prinsip platform

1. **Handyman adalah platform independen.** Ia memiliki authority pekerjaan, pekerjaan lapangan, dan lifecycle sendiri.
2. **BM Super App hanya channel akses.** Ia tidak memiliki authority Handyman. Ia tidak menjadi tempat keputusan bisnis.
3. **ASENTRA dan BM Operations bukan modul Handyman.** Keduanya tidak boleh ditambahkan sebagai modul, persona, atau sumber authority Handyman.
4. **Tenant tidak login langsung** ke Handyman. Tenant berinteraksi melalui Customer Care atau channel yang dikelola platform.
5. **Backend yang memutuskan.** Frontend hanya menampilkan dan meneruskan aksi. Frontend tidak menentukan status, izin, atau transisi.

## 2. Persona dan tanggung jawab

| Persona | Tanggung jawab di journey | Batas |
|---|---|---|
| **Customer Care** | Membuat request atas nama Tenant/PIC. Melaporkan pembayaran. | Hanya melaporkan pembayaran. **Tidak** memverifikasi, tidak CLOSE. |
| **Tenant / PIC** | Menyetujui quotation. Menentukan jadwal. | Tidak login langsung. |
| **Operations (Dispatcher / Inspector)** | Mengelola inspection, dispatch, crew, dan koordinasi permit/akses. | Tidak memverifikasi pembayaran. Tidak CLOSE. |
| **Lead Worker** | Menjalankan pekerjaan, material, evidence, dan self-QC. | Tidak melakukan QC resmi atas pekerjaannya sendiri. |
| **Supervisor** | Melakukan QC. | QC independen: bukan Lead pada scope yang sama. |
| **Finance / Authorized Manager** | Memverifikasi pembayaran dengan maker-checker. | Verifier **tidak boleh** sama dengan pelapor pembayaran. |
| **Handyman Manager** | Satu-satunya yang melakukan final CLOSE. | Hanya setelah prasyarat CLOSE (§6) terpenuhi. |

## 3. Lokasi: Tower = Building

- **Tower dimodelkan sebagai Building.** Tidak ada entitas Tower baru.
- Gunakan **hierarki lokasi existing** (Building → Floor → Space/Unit). Tidak ada hierarki lokasi kedua.
- Authority berbasis lokasi memakai **Building** (bersama Client), sesuai guard building-scope existing.

## 4. Alur request dan quotation

1. **Customer Care membuat request atas nama Tenant/PIC.** Tenant tidak membuat request sendiri.
2. **Operations** mengelola inspection.
3. **Quotation** disetujui oleh **Tenant/PIC**. Persetujuan Tenant adalah syarat sebelum penjadwalan. (Kontrak v1.3 tidak menyatakan siapa yang menyusun quotation; lihat OD-6.)
4. **Tenant menentukan jadwal.** Operations mengatur dispatch dan crew, tetapi jadwal yang disetujui berasal dari Tenant.
5. **Operations** mengelola permit dan koordinasi akses (unit access) sebagai prasyarat pekerjaan.

## 5. Execution Scope dan Work Order

- **Execution Scope tetap authority pekerjaan Handyman.** Status pekerjaan, crew, assignment, evidence, QC, BAST, dan CLOSE dikendalikan oleh Execution Scope.
- **Tidak ada Work Order engine duplikat.** Handyman tidak membuat state machine Work Order kedua.
- Jika referensi ke Work Order FM dibutuhkan, cukup referensi ID **read-only**. Work Order tidak pernah menjadi sumber status pekerjaan atau CLOSE.

## 6. Pelaksanaan, QC, BAST, pembayaran, dan CLOSE

1. **Lead Worker** menjalankan pekerjaan, mencatat material, mengunggah evidence, dan melakukan **self-QC**.
2. **Supervisor** melakukan **QC resmi**. Supervisor harus independen dari Lead pada scope tersebut.
3. **BAST** dibuat setelah **QC PASS** dan **acceptance**. BAST tidak mendahului QC PASS.
4. **Customer Care hanya melaporkan pembayaran** (klaim `PENDING`). Customer Care **tidak** mengonfirmasi atau menolak pembayaran.
5. **Finance / Authorized Manager memverifikasi pembayaran** dengan **maker-checker**: `verifier ≠ pelapor`.
6. **Hanya Handyman Manager yang melakukan final CLOSE.** Prasyarat CLOSE (semua harus terpenuhi):
   - QC PASS,
   - BAST accepted,
   - invoice **PAID**,
   - tidak ada **blocker operasional** yang terbuka.

## 7. Settlement, fee komersial, dan warranty

- **Settlement, fee komersial, dan warranty memiliki lifecycle terpisah.**
- Lifecycle ini **tidak** menjadi bagian dari prasyarat CLOSE kecuali dinyatakan eksplisit di §6.
- Tidak ada lifecycle settlement atau warranty yang digabung ke Execution Scope.

## 8. Aturan authority lintas journey

| Aturan | Keterangan |
|---|---|
| Backend memutuskan | Setiap transisi divalidasi backend. |
| Satu authority per keputusan | Pelapor pembayaran (Customer Care) dan verifier (Finance) dipisah. QC (Supervisor) dan self-QC (Lead) dipisah. |
| Maker-checker | Verifier pembayaran ≠ pelapor. QC resmi ≠ Lead pada scope yang sama. |
| CLOSE eksklusif | Hanya Handyman Manager. |
| Tidak ada endpoint duplikat | Tiga frontend existing memakai endpoint yang sama. |

## 9. Hal yang belum ditentukan (open decisions)

Hal berikut **belum** ditentukan oleh kontrak v1.3 yang diberikan dan tidak boleh diasumsikan di implementasi:

| ID | Pertanyaan | Status |
|---|---|---|
| OD-1 | Apakah Authorized Manager boleh memverifikasi pembayaran selain Finance, dan apakah ada ambang nilai? | Terbuka |
| OD-2 | Apakah Authorized Manager boleh menyetujui scope (`handyman.scope.approve`)? | Terbuka |
| OD-3 | Daftar pasti "blocker operasional" yang menghalangi CLOSE. | Terbuka |
| OD-4 | Apakah Space/Unit merupakan child Floor pada semua kasus. | Terbuka |
| OD-5 | Apakah Inspector adalah persona terpisah dari Dispatcher. | Terbuka |
| OD-6 | Siapa yang menyusun quotation sebelum disetujui Tenant/PIC. | Terbuka |

## 10. Dampak ke kode (ringkas)

- Persona Handyman belum punya permission `handyman.*` di seed. Penambahan permission dilakukan lewat provisioning, sesuai W01 PART 02 §13.5.
- Read Lead Worker pada evidence/QC/defect memakai **assignment Lead aktif** (W01 PART 03), bukan `tenant_company.read`.
- Verifikasi pembayaran, CLOSE, dan settlement/warranty **belum** diimplementasikan pada PART 03 dan tetap menjadi pekerjaan PART berikutnya.
