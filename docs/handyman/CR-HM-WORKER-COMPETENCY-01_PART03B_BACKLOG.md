# CR-HM-WORKER-COMPETENCY-01 — PART 03B Backlog / Handoff

Basis: PART 03A selesai (commit di branch `arena/3df97f5e-handyman-backend`). Item di bawah adalah
**usulan**, belum dikerjakan. Urut berdasarkan risiko, bukan ukuran.

## P0 — kelengkapan siklus keputusan

1. **Assignment competency history read model**
   Saat ini bukti gate hanya tersimpan sebagai `operational_events.metadata.competency`
   (`{requirementCount, mandatoryRequirementCount}`) pada event assignment. Belum ada model baca bertipe
   "siapa dievaluasi, requirement mana, bukti apa" per assignment.
   Usulan: tabel append-only `handyman_assignment_competency_evaluations` (assignmentId, executionScopeId,
   workerContextId, requirementId, satisfied, reason, snapshot certificateId/skillLevel, evaluatedAt,
   requirementSnapshot jsonb) yang ditulis di transaksi assignment yang sama, plus endpoint
   `GET /handyman/execution-scopes/:id/competency/history`. Butuh keputusan retensi & redaksi.

2. **Kebijakan re-verifikasi sertifikat** (warisan backlog PART 02 item 3)
   Sertifikat VERIFIED tetap VERIFIED setelah edit metadata. Untuk requirement MANDATORY, ini berarti
   perubahan `certificate_name`/`issue_date` bisa menggeser kelayakan tanpa re-attestation.
   Usulan: revert ke `PENDING_VERIFICATION` bila field pembuktian berubah, dengan event audit.

3. **Sweeper kedaluwarsa** (backlog PART 02 item 1)
   `status='EXPIRED'` hanya dihitung saat dibaca. Sweeper akan membuat laporan kedaluwarsa konsisten dan
   memicu notifikasi; evaluator saat ini sudah benar tanpa sweeper (tidak ada gap fungsional, hanya observability).

## P1 — cakupan & operasional

4. **Requirement untuk Work Order**
   `work-orders.work_type` adalah teks bebas tanpa relasi ke `service_catalog`, sehingga assignment
   `workforce/team/vendor` tidak bisa dienforce sekarang. Usulan: peta `work_type` → entri katalog (atau kolom
   `service_catalog_id` di `work_orders`), lalu pakai evaluator yang sama pada `work-order-assignment.service.ts`.
   Jangan membuat evaluator kedua.

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

## Catatan konsistensi yang harus dipertahankan PART 03B

- Satu evaluator (`worker-competency-eligibility`) untuk penegakan **dan** baca; jangan menduplikasi aturan.
- Sertifikasi **tidak boleh** menjadi wajib untuk semua worker; requirement hanya bila dikonfigurasi.
- Jangan menambah jalur assignment kedua; penegakan tetap di `handyman-scope-assignment.service.ts`.
- Pertahankan invarian frozen CR-HM-04 PART C: tepat dua bentuk URL assignment.
- Client/Building scope wajib ditegakkan pada setiap operasi baru.
