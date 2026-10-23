import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 02 — certification authority capability.
 *
 * PART 01 shipped `workforce_certifications` (0461) with a domain service whose
 * authorization reused broad, pre-existing codes (`skill.manage`,
 * `workforce.manage`, `tenant_company.manage`). PART 02 publishes the HTTP
 * surface, so the authority has to match the actual boundary instead of a
 * convenient neighbour. This migration registers exactly three capabilities:
 *
 *   workforce_certification.read   — read a worker's individual certificates and
 *     the expiry watch inside the caller's Client scope.
 *   workforce_certification.manage — register, correct and deactivate a
 *     certificate (metadata only; never a verification decision).
 *   workforce_certification.verify — record the VERIFIED / REJECTED decision.
 *
 * Why a dedicated namespace instead of the existing codes:
 *
 *   - `skill.*` administers the Client's Skill CATALOGUE. Holding it does not
 *     mean the holder is accountable for an individual's competence record.
 *   - `workforce.*` administers workforce master data (the person).
 *   - `tenant_company.*` is a broad tenant-administration capability; using it
 *     to read certificates is precisely the "permission too broad" case that
 *     must not grant access to certification data.
 *   - `vendor_licenses_certifications` is company-level and stays a separate
 *     fact.
 *
 * Grant policy (additive only, `0448` / `0450` precedent):
 *
 *   - No role is granted anything by THIS migration. The capability catalogue
 *     and the grant policy stay separate: grants are made by the foundation
 *     seed/owner bootstrap (which follows the default catalogue rule for
 *     `read`/`manage`) or by a deliberate, audited administrative grant.
 *   - `verify` is additionally listed in
 *     `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`, so no seed run can ever hand it
 *     out implicitly. It must be granted explicitly.
 *
 * The permission alone still authorizes nothing out of scope: the service
 * independently requires access to the workforce profile's Client, and the
 * certificate owner may never decide on their own record.
 *
 * No table or column is created here; `0461` owns the schema.
 */
const PERMISSIONS: readonly (readonly [string, string])[] = [
  ['workforce_certification.read', 'Read Workforce Certifications'],
  ['workforce_certification.manage', 'Manage Workforce Certifications'],
  [
    'workforce_certification.verify',
    'Verify or Reject Workforce Certifications',
  ],
];

export const migration0462WorkforceCertificationPermissions: Migration = {
  id: '0462_workforce_certification_permissions',
  async up(tx: PoolClient): Promise<void> {
    for (const [code, name] of PERMISSIONS) {
      await tx.query(
        `INSERT INTO permissions (id, code, name, status)
         VALUES ($1, $2, $3, 'ACTIVE') ON CONFLICT (code) DO NOTHING`,
        [randomUUID(), code, name],
      );
    }
  },
  async down(_tx: PoolClient): Promise<void> {
    // Capability catalogue entries remain: deleting permissions on rollback
    // could invalidate grants. Rollback never grants or revokes actor rights
    // (0442/0446/0448/0450 precedent).
  },
};
