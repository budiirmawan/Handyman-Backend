import type { PoolClient } from 'pg';

/**
 * W03 PART 03C — the PIC session store, in raw SQL.
 *
 * Exactly three statements touch the table: one INSERT (admission, carrying the
 * replay tombstone), one read used for the authority pre-lock, one FOR UPDATE
 * read used for use/revocation, plus the single revocation UPDATE. There is no
 * UPDATE-in-place of session identity, no renewal, no delete, and no cleanup of
 * tombstones — which is what `0441`'s guard makes impossible rather than merely
 * discouraged (R8).
 *
 * Lock order is contractual (A01 R7, and the same order `0429`'s invalidation
 * triggers use): AUTHORITY rows first (`handyman_handoff_integrations`,
 * `tenant_companies`), then the session row, then the representation rows
 * (`tenant_building_contexts` / `tenant_space_relationships`). Reversing it
 * deadlocks against the revocation triggers.
 */

export type PicWorkspaceAuthorityRow = {
  sessionId: string;
  integrationId: string;
  tenantCompanyId: string;
  tenantPicId: string | null;
  buildingId: string;
  spaceId: string | null;
  tenantBuildingContextId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type PicWorkspaceSessionInsert = {
  id: string;
  integrationId: string;
  tenantCompanyId: string;
  tenantPicId: string | null;
  buildingId: string;
  spaceId: string | null;
  tenantBuildingContextId: string;
  assertionId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
};

export const PIC_WORKSPACE_TABLE = 'handyman_pic_workspace_sessions';

/** Admission pre-lock: the integration must be ACTIVE and hold the capability
 * (rule 6). Capability is provisioned by operations and is never derivable
 * from a request, so this is the only place it is read. */
export async function lockAttestingIntegration(
  tx: PoolClient,
  integrationCode: string,
): Promise<{ integrationId: string } | null> {
  const result = await tx.query<{ integrationId: string }>(
    `SELECT i.id AS "integrationId"
       FROM handyman_handoff_integrations i
      WHERE i.integration_code = $1
        AND i.status = 'ACTIVE'
        AND i.actor_capability = 'TENANT_PIC'
      FOR SHARE OF i`,
    [integrationCode],
  );
  return result.rows[0] ?? null;
}

/** One admission, one row. The UNIQUE (integration, assertion) pair is the
 * replay tombstone: a second admission of the same assertion never happens. */
export async function insertPicWorkspaceSession(
  tx: PoolClient,
  data: PicWorkspaceSessionInsert,
): Promise<void> {
  await tx.query(
    `INSERT INTO handyman_pic_workspace_sessions
       (id, integration_id, tenant_company_id, tenant_pic_id, building_id,
        space_id, tenant_building_context_id, assertion_id, token_hash,
        created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      data.id,
      data.integrationId,
      data.tenantCompanyId,
      data.tenantPicId,
      data.buildingId,
      data.spaceId,
      data.tenantBuildingContextId,
      data.assertionId,
      data.tokenHash,
      data.createdAt,
      data.expiresAt,
    ],
  );
}

/**
 * Authority pre-lock for a use of the credential (rule 17, first four checks in
 * one read): integration ACTIVE + capability, tenant company ACTIVE, and — only
 * when the session names a PIC — that PIC ACTIVE and belonging to the session's
 * own tenant. A read-capable session (no PIC) is legitimate for reads, so the
 * PIC join is outer and its predicate is conditional rather than assumed.
 */
export async function findPicWorkspaceSessionByTokenHash(
  tx: PoolClient,
  tokenHash: string,
): Promise<PicWorkspaceAuthorityRow | null> {
  const result = await tx.query<PicWorkspaceAuthorityRow>(
    `SELECT s.id AS "sessionId", s.integration_id AS "integrationId",
            s.tenant_company_id AS "tenantCompanyId",
            s.tenant_pic_id AS "tenantPicId", s.building_id AS "buildingId",
            s.space_id AS "spaceId",
            s.tenant_building_context_id AS "tenantBuildingContextId",
            s.created_at AS "createdAt", s.expires_at AS "expiresAt",
            s.revoked_at AS "revokedAt"
       FROM handyman_pic_workspace_sessions s
       JOIN handyman_handoff_integrations i
         ON i.id = s.integration_id AND i.status = 'ACTIVE'
            AND i.actor_capability = 'TENANT_PIC'
       JOIN tenant_companies tc
         ON tc.id = s.tenant_company_id AND tc.status = 'ACTIVE'
       LEFT JOIN tenant_pics p
         ON p.id = s.tenant_pic_id
      WHERE s.token_hash = $1
        AND (s.tenant_pic_id IS NULL
             OR (p.status = 'ACTIVE'
                 AND p.tenant_company_id = s.tenant_company_id))
      FOR SHARE OF i, tc`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/** Session lock. The expiry predicate is re-evaluated against
 * clock_timestamp() at lock-acquisition time, so a lock wait can never turn an
 * expired credential into a live one (rule 17, last sentence). */
export async function lockPicWorkspaceSession(
  tx: PoolClient,
  sessionId: string,
): Promise<{ expiresAt: Date; revokedAt: Date | null; createdAt: Date } | null> {
  const result = await tx.query<{
    createdAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
  }>(
    `SELECT created_at AS "createdAt", expires_at AS "expiresAt",
            revoked_at AS "revokedAt"
       FROM handyman_pic_workspace_sessions
      WHERE id = $1
        AND expires_at > clock_timestamp()
      FOR UPDATE`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

/**
 * Current representation (rule 17): hold a read lock on the exact
 * tenant-building context the session was minted from, and — when the session
 * narrowed to a space — on that space relationship, both with
 * clock_timestamp() freshness so a turnover committed after the lock cannot be
 * missed by transaction-start-time staleness.
 *
 * The space row is matched by predicate rather than by a stored id: rule 10
 * fixes the session row's column set, and `tenant_space_relationships` was
 * never part of it. Deriving the relationship from (tenant, building, space) is
 * what the unchanged resolver does, so no parallel occupancy master appears.
 */
export async function lockCurrentRepresentation(
  tx: PoolClient,
  snapshot: {
    tenantCompanyId: string;
    buildingId: string;
    spaceId: string | null;
    tenantBuildingContextId: string;
  },
): Promise<boolean> {
  const context = await tx.query(
    `SELECT 1 FROM tenant_building_contexts
      WHERE id = $1 AND tenant_company_id = $2 AND building_id = $3
        AND status = 'ACTIVE'
        AND (effective_from IS NULL OR effective_from <= clock_timestamp())
        AND (effective_until IS NULL OR effective_until >= clock_timestamp())
      FOR SHARE`,
    [
      snapshot.tenantBuildingContextId,
      snapshot.tenantCompanyId,
      snapshot.buildingId,
    ],
  );
  if (context.rowCount !== 1) return false;
  if (!snapshot.spaceId) return true;
  const space = await tx.query(
    `SELECT 1 FROM tenant_space_relationships
      WHERE tenant_company_id = $1 AND building_id = $2 AND space_id = $3
        AND status = 'ACTIVE'
        AND (effective_from IS NULL OR effective_from <= clock_timestamp())
        AND (effective_until IS NULL OR effective_until >= clock_timestamp())
      FOR SHARE`,
    [snapshot.tenantCompanyId, snapshot.buildingId, snapshot.spaceId],
  );
  return space.rowCount === 1;
}

/** First revocation only — the guard in 0441 refuses any other UPDATE, and a
 * row already revoked simply does not match, which is what makes logout
 * idempotent without a second write or a second journal event. */
export async function revokePicWorkspaceSessionRow(
  tx: PoolClient,
  sessionId: string,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE handyman_pic_workspace_sessions SET revoked_at = clock_timestamp()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [sessionId],
  );
  return result.rowCount === 1;
}

export const handymanPicWorkspaceSessionRepository = {
  lockAttestingIntegration,
  insertPicWorkspaceSession,
  findPicWorkspaceSessionByTokenHash,
  lockPicWorkspaceSession,
  lockCurrentRepresentation,
  revokePicWorkspaceSessionRow,
};
