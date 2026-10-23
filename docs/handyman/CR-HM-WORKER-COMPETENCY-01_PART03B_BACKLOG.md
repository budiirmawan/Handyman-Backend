# CR-HM-WORKER-COMPETENCY-01 — PART 03B Backlog / Handoff

Basis: PART 03A selesai (`8c7e8ef`), **PART 03B1 selesai (`76eb66b`)**, **PART 03B2A selesai**, dan
**PART 03B2B selesai** (koreksi business rule MULTI-SKILL WORKER) di branch
`arena/3df97f5e-handyman-backend`.

**Status per dokumen ini:** item **1** dan **2** sudah **DELIVERED pada PART 03B1** (detail:
`CR-HM-WORKER-COMPETENCY-01_PART03B1_DELIVERY_REPORT.md`). Item **4** sudah **DELIVERED pada PART 03B2A**
(detail: `CR-HM-WORKER-COMPETENCY-01_PART03B2A_DELIVERY_REPORT.md`). Item sisanya masih backlog, urut
berdasarkan risiko, bukan ukuran.

## P0 — kelengkapan siklus keputusan

1. ~~**Assignment competency history read model**~~ — **DONE (PART 03B1, `76eb66b`)**
   Tabel append-only `handyman_assignment_competency_evaluations` (migrasi `0464`) ditulis di transaksi
   assignment yang sama + endpoint `GET /handyman/execution-scopes/:id/competency/history` (read-only,
   paginasi, `tenant_company.read` + exact-Building). Snapshot sengaja **tanpa** nomor sertifikat, document id,
   storage key, atau isi dokumen. Retensi/arsip masih terbuka → lihat item 11.

2. ~~**Kebijakan re-verifikasi sertifikat**~~ (warisan backlog PART 02 item 3) — **DONE (PART 03B1, `76eb66b`)**
   Edit metadata **material** (nomor, nama, penerbit, tanggal terbit/kedaluwarsa, skill, dokumen,
   `fileReference`, status) mengembalikan sertifikat ke `PENDING_VERIFICATION` dan mengosongkan triple verifier
   dalam UPDATE yang sama. Edit `notes` dan pengiriman nilai identik **tidak** mereset. Keputusan lama tidak
   hilang: tersimpan di `workforce_certification_decisions` (append-only) + endpoint
   `GET /workforce/:workforceId/certifications/:certificationId/decisions`. Maker-checker tidak berubah.

3. **Sweeper kedaluwarsa** (backlog PART 02 item 1)
   `status='EXPIRED'` hanya dihitung saat dibaca. Sweeper akan membuat laporan kedaluwarsa konsisten dan
   memicu notifikasi; evaluator saat ini sudah benar tanpa sweeper (tidak ada gap fungsional, hanya observability).

## P1 — cakupan & operasional

4. ~~**Requirement untuk Work Order**~~ — **DONE (PART 03B2A)**
   Registry trade multi-trade (`work_order_trade_categories`, migrasi `0465`), klasifikasi Work Order
   (`trade_category_id` + `risk_level` + jejak classifier), requirement kompetensi dua target
   (katalog **atau** trade, XOR, per Client), dan satu gerbang kompetensi di dalam transaksi
   `work-order-assignment.service.ts` (WORKFORCE/TEAM/VENDOR_WORKFORCE = ALL, VENDOR = ANY). Ledger
   `work_order_assignment_competency_decisions` append-only + endpoint
   `GET /work-orders/:id/assignments/competency-decisions`. Tidak ada evaluator kedua.

5. **Bulk konfigurasi requirement**
   Impor CSV/JSON per Client (preview → validate → commit), mengikuti konvensi tenant-batch-import.
   Nilai tambah tinggi: satu job type bisa punya beberapa requirement (skill + sertifikat).

6. **Evaluasi "near miss" & rekomendasi pelatihan**
   `gapEvidence` sudah menyimpan sertifikat terdekat dan level aktual. Bisa ditingkatkan menjadi rekomendasi
   ("naikkan ELECTRICAL dari BASIC ke ADVANCED") di layer baca, tanpa mengubah penegakan.

7. **Requirement per Building/Client-policy**
   Saat ini requirement melekat pada job type (Client-wide). Kebutuhan lapangan berikutnya biasanya
   "Building A mewajibkan sertifikat tambahan". Perlu keputusan governance sebelum implementasi.

## P2 — hardening & parity

8. **Frontend/Web handoff**
   Halaman konfigurasi requirement pada detail entri katalog + indikator gap pada modal assign/reassign
   (memakai endpoint `.../competency/eligibility` dan `.../competency/candidates`). Belum ada dokumen handoff
   UI khusus; kontrak DTO sudah ada di `docs/api/openapi.yaml`.

9. **Candidates: sertakan dimensi penempatan**
   Endpoint candidates saat ini hanya menilai kompetensi (disengaja). Bila UI perlu "siap tugaskan sekarang",
   tambahkan flag `placementEligible` yang memakai `findEligibleHandymanWorker` (read-only, tanpa mengubah
   keputusan assignment).

10. **Export audit requirement**
    Ekspor riwayat perubahan requirement (create/update/deactivate) untuk audit eksternal, mengikuti pola
    export yang sudah ada di domain lain.

11. **Kebijakan retensi ledger PART 03B1**
    `workforce_certification_decisions` dan `handyman_assignment_competency_evaluations` tumbuh monoton dan
    menolak UPDATE/DELETE (trigger). Bila volume menuntut, arsipkan lewat ekspor + partisi — **bukan** DELETE.
    Perlu keputusan retensi (mis. berapa lama disimpan panas) sebelum implementasi.

## Koreksi PART 03B2B (multi-skill worker) — sudah selesai

Model yang berlaku: **satu pekerja boleh memegang banyak skill/sertifikat lintas trade**, dan trade sertifikat
tidak pernah membatasi penugasan. Yang dikerjakan:

- warning RECOMMENDED kini tampil pada respons assign/reassign (`data.competency.advisory`) — bukan hanya di
  ledger; tidak pernah memblokir.
- dua cacat isolasi Client diperbaiki: unique index requirement per trade + probe duplikat kini menyertakan
  `client_id`, sehingga Client tidak saling menolak/menimpa konfigurasi trade yang sama.
- 11 regression test baru (B1–B10) mencakup seluruh skenario yang diminta (AC → electrical/plumbing,
  RECOMMENDED warning, MANDATORY denial, multi-skilled worker, sertifikat kategori lain, bypass keselamatan,
  team, dan lifecycle).

**Catatan aturan yang tidak boleh dilanggar ke depan:** jangan pernah menambahkan perbandingan trade pekerja vs
trade Work Order, jangan menurunkan requirement dari sertifikat yang dimiliki pekerja, dan jangan mengubah
warning RECOMMENDED menjadi penolakan.

## Tambahan backlog setelah PART 03B2A

12. **Penugasan tingkat VENDOR dinilai per orang (G1)**
    Assignment `VENDOR` menunjuk perusahaan, sehingga gate memakai aturan ANY atas worker terikat. Perlu
    keputusan governance: deklarasi worker sebelum mulai, atau verifikasi di lapangan.

13. **Klasifikasi wajib untuk `work_type` berisiko (G4)**
    Work Order boleh tetap tanpa klasifikasi (disengaja agar tidak ada regresi). Usulkan laporan aging
    "unclassified Work Order" atau kewajiban klasifikasi untuk kategori tertentu.

14. **Override/exception ber-approval (G5)**
    Penolakan kompetensi saat ini final. Bila lapangan butuh pengecualian, sediakan alur override dengan
    alasan + approver terpisah + jejak audit, tanpa melemahkan default.

15. **Read model kandidat per Work Order (G9)**
    Endpoint kandidat (seperti `.../competency/candidates` pada execution scope) yang menampilkan siapa
    memenuhi requirement trade sebuah Work Order, agar UI assign tidak bergantung pada 409.

16. **Warning RECOMMENDED di UI assign (G6, lanjutan 03B2B)**
    `data.competency.advisory` sudah tersedia pada respons assign/reassign; UI perlu menampilkannya sebagai
    peringatan (bukan dialog blokir), mis. "worker belum memiliki skill X (disarankan)".

17. **Risk level sebagai kebijakan (G3)**
    `risk_level` kini deskriptif. Bila nanti dipakai menurunkan requirement minimum, buat pemetaan eksplisit
    dan tetap lewat model requirement yang sama.

## Catatan konsistensi yang harus dipertahankan PART 03B

- Satu evaluator (`worker-competency-eligibility`) untuk penegakan **dan** baca; jangan menduplikasi aturan.
- Sertifikasi **tidak boleh** menjadi wajib untuk semua worker; requirement hanya bila dikonfigurasi.
- Jangan menambah jalur assignment kedua; penegakan tetap di `handyman-scope-assignment.service.ts`
  (execution scope) dan `work-order-assignment.service.ts` (Work Order) — keduanya memakai evaluator yang sama.
- Pertahankan invarian frozen CR-HM-04 PART C: tepat dua bentuk URL assignment.
- Client/Building scope wajib ditegakkan pada setiap operasi baru.
- Kedua ledger PART 03B1 tetap **append-only**; jangan menambahkan UPDATE/DELETE atau "koreksi" baris historis.

## Catatan lintas-CR — CR-HM-WO-PG18-UUID-01 PART 03B2C (selesai)

PostgreSQL 18 tidak punya agregat `min(uuid)` / `max(uuid)`. Query feed Mobile
(`mobile-assignment.service.ts`) memakainya untuk marker Safety Inspection sehingga seluruh
`GET /mobile/assignments` menjawab 500 dan suite lifecycle Work Order (action, completion, BAST closure)
gagal. Marker kini diambil dengan `ORDER BY created_at, id LIMIT 1` di dalam LATERAL yang tetap dijaga
`COUNT(*) = 1`, jadi deterministik dan tanpa winner acak.

**Aturan ke depan:** jangan pernah mengagregasi kolom `uuid` dengan `MIN`/`MAX` (atau agregat lain yang tidak
punya fungsi untuk uuid). Gunakan `ORDER BY ... LIMIT 1` di dalam LATERAL/subquery, atau agregasikan `::text`
bila memang hanya butuh nilai apa pun — dan pilih salah satunya secara sadar. Detail:
`CR-HM-WO-PG18-UUID-01_PART03B2C_DELIVERY_REPORT.md`.

## Catatan lintas-CR — CR-HM-WORKER-COMPETENCY-01 PART 03B2D (selesai)

Koreksi model bisnis: Handyman adalah penyedia jasa **langsung**. Pekerja tetap/kontrak/freelance adalah
personel Handyman sendiri yang dikelola Operations, **bukan** vendor eksternal. Jalur assignment tidak lagi
berakar pada `handyman_provider_contexts.vendor_id`:

- `provider_type` (`VENDOR` | `DIRECT`) + `vendor_id` nullable + satu pool `DIRECT` per Client (migrasi `0466`);
- binding vendor hanya wajib untuk pool `VENDOR`;
- admission crew memakai **provider kind**, bukan `workforce_profiles.workforce_type` (predikat `EXTERNAL`
  dihapus di `findEligibleHandymanWorker` dan di daftar kandidat inspector);
- `workforce_type` mendapat nilai `FREELANCE` (tetap/ kontrak / lepas sebagai hubungan kerja, bukan perusahaan).

**Aturan ke depan:** jangan pernah membuat vendor (atau baris vendor per-freelancer) sebagai workaround, dan
jangan menandai pegawai sendiri `EXTERNAL` agar bisa ditugaskan. Jangan menambah jalur assignment kedua —
otoritasnya tetap `handyman-scope-assignment.service.ts` dengan evaluator kompetensi yang sama. Detail:
`CR-HM-WORKER-COMPETENCY-01_PART03B2D_DELIVERY_REPORT.md`.

