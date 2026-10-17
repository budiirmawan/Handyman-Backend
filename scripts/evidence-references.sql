-- Run after writers AND scheduler are stopped, against the same database snapshot
-- as the dump. Non-managed references deliberately fail the verifier: investigate
-- external/legacy references rather than silently claiming they were backed up.
COPY (
  SELECT file_reference AS key, content_sha256 AS sha256, file_size::text AS size
    FROM evidence_submissions
    WHERE retention_state <> 'PURGED' AND file_reference IS NOT NULL
  UNION ALL
  SELECT storage_reference, checksum, file_size::text
    FROM report_archives WHERE storage_reference IS NOT NULL
  UNION ALL
  SELECT storage_key, sha256_digest, byte_size::text
    FROM handyman_evidence_record_files
  UNION ALL
  SELECT storage_key, sha256_checksum, verified_byte_size::text
    FROM handyman_field_evidence_uploads WHERE upload_status <> 'PENDING_BYTES'
) TO STDOUT WITH (FORMAT CSV, HEADER TRUE);
