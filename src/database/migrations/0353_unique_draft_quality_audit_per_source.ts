import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-RN15-CLEANING-QUALITY-MOBILE-01 — at most ONE DRAFT quality audit per
 * audited source.
 *
 * BE-11K (migration 0118) deliberately allows MANY quality audits per
 * `(source_type, source_id)`: a source may be audited again and again, and the
 * completed audits are the quality history of that source. That stays true.
 *
 * What was never constrained is the OPEN end of that history. Nothing stopped
 * two DRAFT audits existing simultaneously for the same source, which makes
 * "the quality audit currently in progress for this Daily Cleaning task" an
 * ambiguous question — exactly the question a target-scoped mobile context has
 * to answer with a single object. A client that had to disambiguate would end
 * up deriving the answer itself, which is precisely the authority leak this CR
 * closes.
 *
 * The index is therefore PARTIAL on `status = 'DRAFT'`:
 *   - at most one DRAFT per (source_type, source_id);
 *   - COMPLETED audits remain UNLIMITED, so history is untouched and a source
 *     whose audit was completed can immediately be audited again.
 *
 * NO DATA IS CHOSEN OR DELETED. A pre-flight scan reports every source holding
 * more than one DRAFT and aborts. Which draft survives is a business decision
 * about which audit an auditor actually intends to complete; it must be made
 * explicitly by an operator, never silently by a migration.
 */
export const migration0353UniqueDraftQualityAuditPerSource: Migration = {
  id: '0353_unique_draft_quality_audit_per_source',

  async up(client: PoolClient): Promise<void> {
    const duplicates = await client.query<{
      source_type: string;
      source_id: string;
      draft_count: string;
      quality_audit_ids: string[];
    }>(`
      SELECT
        source_type,
        source_id,
        COUNT(*)::TEXT            AS draft_count,
        array_agg(id ORDER BY id) AS quality_audit_ids
      FROM quality_audits
      WHERE status = 'DRAFT'
      GROUP BY source_type, source_id
      HAVING COUNT(*) > 1
      ORDER BY source_type, source_id
    `);

    if (duplicates.rows.length > 0) {
      const detail = duplicates.rows
        .map(
          (row) =>
            `source_type=${row.source_type} source_id=${row.source_id} ` +
            `draft_audits=${row.draft_count} ` +
            `quality_audit_ids=[${row.quality_audit_ids.join(', ')}]`,
        )
        .join('; ');

      throw new Error(
        '0353_unique_draft_quality_audit_per_source: refusing to create ' +
          'quality_audits_source_draft_unique because ' +
          `${duplicates.rows.length} audited source(s) hold more than one ` +
          'DRAFT quality audit. A target-scoped read must resolve exactly one ' +
          'current draft per source, so the surviving draft has to be chosen ' +
          'explicitly by an operator. Complete or remove every draft but the ' +
          'authoritative one for each source and re-run the migration. No rows ' +
          `were modified. Offending rows: ${detail}`,
      );
    }

    await client.query(`
      CREATE UNIQUE INDEX quality_audits_source_draft_unique
        ON quality_audits (source_type, source_id)
        WHERE status = 'DRAFT'
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS quality_audits_source_draft_unique
    `);
  },
};
