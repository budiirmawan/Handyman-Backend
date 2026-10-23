import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { getPool } from '../../database';
import type {
  ListExpiringWorkforceCertificationsFilter,
  ListWorkforceCertificationsFilter,
  WorkforceCertificationDocumentSummary,
  WorkforceCertificationExpiringItem,
  WorkforceCertificationExpiryStatus,
  WorkforceCertificationRecord,
  WorkforceCertificationSkillSummary,
  WorkforceCertificationStatus,
  WorkforceCertificationVerificationStatus,
} from './workforce-certification.types';

function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) {
  return getPool().query<T>(text, params);
}

type WorkforceCertificationRow = {
  id: string;
  client_id: string;
  workforce_profile_id: string;
  skill_id: string | null;
  skill_code: string | null;
  skill_name: string | null;
  skill_category: string | null;
  skill_status: string | null;
  certificate_number: string;
  certificate_name: string;
  issuing_authority: string;
  issue_date: Date | string;
  expiry_date: Date | string | null;
  status: WorkforceCertificationStatus;
  verification_status: WorkforceCertificationVerificationStatus;
  verified_by_user_id: string | null;
  verified_at: Date | string | null;
  document_id: string | null;
  file_reference: string | null;
  doc_id: string | null;
  doc_number: string | null;
  doc_type: string | null;
  doc_title: string | null;
  doc_file_reference: string | null;
  doc_status: string | null;
  notes: string | null;
  created_by_user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  profile_full_name?: string | null;
  profile_employee_code?: string | null;
  profile_organization_id?: string | null;
};

export type WorkforceProfileClientContext = {
  id: string;
  clientId: string;
  organizationId: string;
  userId: string;
  status: string;
};

export type ReferencedDocumentContext = {
  id: string;
  clientId: string;
  status: string;
  documentNumber: string;
  documentType: string;
  title: string;
  fileReference: string;
};

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return toIso(value);
}

export function resolveWorkforceCertificationExpiryStatus(
  status: WorkforceCertificationStatus,
  expiryDate: string | null,
  now: Date = new Date(),
): WorkforceCertificationExpiryStatus {
  if (status === 'INACTIVE') {
    return 'NOT_APPLICABLE';
  }
  if (status === 'EXPIRED') {
    return 'EXPIRED';
  }
  if (expiryDate === null) {
    return 'VALID';
  }
  return new Date(expiryDate).getTime() < now.getTime() ? 'EXPIRED' : 'VALID';
}

function mapSkillSummary(
  row: WorkforceCertificationRow,
): WorkforceCertificationSkillSummary | null {
  if (
    !row.skill_id ||
    !row.skill_code ||
    !row.skill_name ||
    !row.skill_category ||
    !row.skill_status
  ) {
    return null;
  }
  return {
    id: row.skill_id,
    code: row.skill_code,
    name: row.skill_name,
    category: row.skill_category,
    status: row.skill_status,
  };
}

function mapDocumentSummary(
  row: WorkforceCertificationRow,
): WorkforceCertificationDocumentSummary | null {
  if (
    !row.doc_id ||
    !row.doc_number ||
    !row.doc_type ||
    !row.doc_title ||
    !row.doc_file_reference ||
    !row.doc_status
  ) {
    return null;
  }
  return {
    id: row.doc_id,
    documentNumber: row.doc_number,
    documentType: row.doc_type,
    title: row.doc_title,
    fileReference: row.doc_file_reference,
    status: row.doc_status,
  };
}

function mapRow(
  row: WorkforceCertificationRow,
  now: Date = new Date(),
): WorkforceCertificationRecord {
  const expiryDate = toNullableIso(row.expiry_date);
  const docSummary = mapDocumentSummary(row);
  const effectiveFileReference =
    row.file_reference ?? docSummary?.fileReference ?? null;
  const expiryStatus = resolveWorkforceCertificationExpiryStatus(
    row.status,
    expiryDate,
    now,
  );
  const isExpired = expiryStatus === 'EXPIRED';
  // "Valid for a certification requirement" is stricter than "not expired":
  // the record must be ACTIVE, inside its validity window AND verified. An
  // unverified or rejected certificate never satisfies a requirement, and an
  // expired one never does either.
  const isValid =
    row.status === 'ACTIVE' &&
    !isExpired &&
    row.verification_status === 'VERIFIED';

  return {
    id: row.id,
    clientId: row.client_id,
    workforceProfileId: row.workforce_profile_id,
    skillId: row.skill_id,
    skill: mapSkillSummary(row),
    certificateNumber: row.certificate_number,
    certificateName: row.certificate_name,
    issuingAuthority: row.issuing_authority,
    issueDate: toIso(row.issue_date),
    expiryDate,
    status: row.status,
    expiryStatus,
    isExpired,
    isValid,
    verificationStatus: row.verification_status,
    verifiedByUserId: row.verified_by_user_id,
    verifiedAt: toNullableIso(row.verified_at),
    documentId: row.document_id,
    fileReference: effectiveFileReference,
    documentReference: docSummary,
    notes: row.notes,
    createdByUserId: row.created_by_user_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const CERTIFICATION_COLUMNS = `
  wc.id,
  wc.client_id,
  wc.workforce_profile_id,
  wc.skill_id,
  s.code AS skill_code,
  s.name AS skill_name,
  s.category AS skill_category,
  s.status AS skill_status,
  wc.certificate_number,
  wc.certificate_name,
  wc.issuing_authority,
  wc.issue_date,
  wc.expiry_date,
  wc.status,
  wc.verification_status,
  wc.verified_by_user_id,
  wc.verified_at,
  wc.document_id,
  wc.file_reference,
  d.id AS doc_id,
  d.document_number AS doc_number,
  d.document_type AS doc_type,
  d.title AS doc_title,
  d.file_reference AS doc_file_reference,
  d.status AS doc_status,
  wc.notes,
  wc.created_by_user_id,
  wc.created_at,
  wc.updated_at
`;

const CERTIFICATION_FROM = `
  FROM workforce_certifications wc
  LEFT JOIN skills s
    ON s.id = wc.skill_id
  LEFT JOIN documents d
    ON d.id = wc.document_id
`;

const SELECT_WITH_RELATIONS = `SELECT ${CERTIFICATION_COLUMNS} ${CERTIFICATION_FROM}`;

/**
 * PART 02 — expiry-watch select. The worker identity travels with the row
 * because the caller reads across workforce profiles inside their own Client
 * scope, and the profile join additionally proves the row still resolves under
 * the same Client the certificate claims.
 */
const SELECT_EXPIRING = `
  SELECT ${CERTIFICATION_COLUMNS},
         wp.full_name AS profile_full_name,
         wp.employee_code AS profile_employee_code,
         wp.organization_id AS profile_organization_id
  ${CERTIFICATION_FROM}
  JOIN workforce_profiles wp
    ON wp.id = wc.workforce_profile_id
`;

export const workforceCertificationRepository = {
  async findWorkforceProfileClientContext(
    workforceProfileId: string,
  ): Promise<WorkforceProfileClientContext | null> {
    const result = await query<{
      id: string;
      client_id: string;
      organization_id: string;
      user_id: string;
      status: string;
    }>(
      `SELECT wp.id,
              o.client_id,
              wp.organization_id,
              wp.user_id,
              wp.status
         FROM workforce_profiles wp
         INNER JOIN organizations o ON o.id = wp.organization_id
        WHERE wp.id = $1`,
      [workforceProfileId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      clientId: row.client_id,
      organizationId: row.organization_id,
      userId: row.user_id,
      status: row.status,
    };
  },

  async findDocumentContext(
    documentId: string,
  ): Promise<ReferencedDocumentContext | null> {
    const result = await query<{
      id: string;
      client_id: string;
      status: string;
      document_number: string;
      document_type: string;
      title: string;
      file_reference: string;
    }>(
      `SELECT id,
              client_id,
              status,
              document_number,
              document_type,
              title,
              file_reference
         FROM documents
        WHERE id = $1`,
      [documentId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      clientId: row.client_id,
      status: row.status,
      documentNumber: row.document_number,
      documentType: row.document_type,
      title: row.title,
      fileReference: row.file_reference,
    };
  },

  async findById(id: string): Promise<WorkforceCertificationRecord | null> {
    const result = await query<WorkforceCertificationRow>(
      `${SELECT_WITH_RELATIONS} WHERE wc.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  },

  async findByIdInWorkforceProfile(
    workforceProfileId: string,
    id: string,
  ): Promise<WorkforceCertificationRecord | null> {
    const result = await query<WorkforceCertificationRow>(
      `${SELECT_WITH_RELATIONS}
        WHERE wc.workforce_profile_id = $1 AND wc.id = $2`,
      [workforceProfileId, id],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  },

  async findActiveDuplicate(
    workforceProfileId: string,
    certificateNumber: string,
    excludeId?: string,
  ): Promise<WorkforceCertificationRecord | null> {
    const params: unknown[] = [workforceProfileId, certificateNumber];
    let excludeClause = '';
    if (excludeId) {
      params.push(excludeId);
      excludeClause = ` AND wc.id <> $3`;
    }
    const result = await query<WorkforceCertificationRow>(
      `${SELECT_WITH_RELATIONS}
        WHERE wc.workforce_profile_id = $1
          AND lower(btrim(wc.certificate_number)) = lower(btrim($2))
          AND wc.status = 'ACTIVE'${excludeClause}`,
      params,
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  },

  async listByWorkforceProfileId(
    workforceProfileId: string,
    filter: ListWorkforceCertificationsFilter = {},
  ): Promise<WorkforceCertificationRecord[]> {
    const conditions: string[] = ['wc.workforce_profile_id = $1'];
    const params: unknown[] = [workforceProfileId];

    if (filter.status) {
      params.push(filter.status);
      conditions.push(`wc.status = $${params.length}`);
    }

    if (filter.verificationStatus) {
      params.push(filter.verificationStatus);
      conditions.push(`wc.verification_status = $${params.length}`);
    }

    if (filter.skillId) {
      params.push(filter.skillId);
      conditions.push(`wc.skill_id = $${params.length}`);
    }

    if (filter.currentOnly) {
      conditions.push(`wc.status = 'ACTIVE'`);
      conditions.push(`(wc.expiry_date IS NULL OR wc.expiry_date >= NOW())`);
    }

    const result = await query<WorkforceCertificationRow>(
      `${SELECT_WITH_RELATIONS}
        WHERE ${conditions.join(' AND ')}
        ORDER BY wc.issue_date DESC, wc.created_at DESC, wc.id ASC`,
      params,
    );
    const now = new Date();
    return result.rows.map((row) => mapRow(row, now));
  },

  async listCurrentByWorkforceProfileId(
    workforceProfileId: string,
  ): Promise<WorkforceCertificationRecord[]> {
    return this.listByWorkforceProfileId(workforceProfileId, {
      currentOnly: true,
    });
  },

  /**
   * PART 02 — the Mobile worker-profile projection source.
   *
   * Administrative deactivation (INACTIVE) removes a certificate from the
   * worker's own profile: it is withdrawn, not merely historical. EXPIRED rows
   * stay visible so the worker can see exactly what lapsed and when.
   *
   * `clientId` is passed explicitly and re-asserted in the WHERE clause, so a
   * profile id alone can never widen the read beyond the profile's Client.
   */
  async listVisibleByWorkforceProfileId(
    workforceProfileId: string,
    clientId: string,
  ): Promise<WorkforceCertificationRecord[]> {
    const result = await query<WorkforceCertificationRow>(
      `${SELECT_WITH_RELATIONS}
        WHERE wc.workforce_profile_id = $1
          AND wc.client_id = $2
          AND wc.status <> 'INACTIVE'
        ORDER BY
          CASE WHEN wc.status = 'ACTIVE' THEN 0 ELSE 1 END,
          wc.expiry_date ASC NULLS LAST,
          wc.issue_date DESC,
          wc.id ASC`,
      [workforceProfileId, clientId],
    );
    const now = new Date();
    return result.rows.map((row) => mapRow(row, now));
  },

  /**
   * PART 02 — expiry watch across every workforce profile inside the caller's
   * Client scope.
   *
   * The scope is an explicit, server-derived client-id set; an empty set
   * short-circuits to an empty result instead of a full-table read. Only ACTIVE
   * certificates with a real expiry date inside `[now, now + days]` are
   * returned — an already-expired certificate is not "approaching" expiry and
   * an INACTIVE one is withdrawn.
   */
  async listExpiring(
    clientIds: readonly string[],
    filter: ListExpiringWorkforceCertificationsFilter,
    now: Date = new Date(),
  ): Promise<WorkforceCertificationExpiringItem[]> {
    if (clientIds.length === 0) {
      return [];
    }

    const params: unknown[] = [clientIds, filter.days];
    const conditions: string[] = [
      `wc.client_id = ANY($1::uuid[])`,
      `wc.status = 'ACTIVE'`,
      `wc.expiry_date IS NOT NULL`,
      `wc.expiry_date >= NOW()`,
      // The window is expressed in whole days from the current instant. The
      // multiplication is done in SQL so the boundary is evaluated by the same
      // clock that produced NOW().
      `wc.expiry_date <= NOW() + ($2::int * INTERVAL '1 day')`,
    ];

    if (filter.verificationStatus) {
      params.push(filter.verificationStatus);
      conditions.push(`wc.verification_status = $${params.length}`);
    }

    if (filter.workforceProfileId) {
      params.push(filter.workforceProfileId);
      conditions.push(`wc.workforce_profile_id = $${params.length}`);
    }

    const result = await query<WorkforceCertificationRow>(
      `${SELECT_EXPIRING}
        WHERE ${conditions.join(' AND ')}
        ORDER BY wc.expiry_date ASC, wc.id ASC`,
      params,
    );

    return result.rows.map((row) => {
      const record = mapRow(row, now);
      const expiry = new Date(record.expiryDate as string).getTime();
      const daysUntilExpiry = Math.max(
        0,
        Math.ceil((expiry - now.getTime()) / 86_400_000),
      );
      return {
        certification: record,
        workforceProfile: {
          id: row.workforce_profile_id,
          fullName: row.profile_full_name ?? '',
          employeeCode: row.profile_employee_code ?? '',
          organizationId: row.profile_organization_id ?? '',
        },
        daysUntilExpiry,
      };
    });
  },

  async create(params: {
    clientId: string;
    workforceProfileId: string;
    skillId: string | null;
    certificateNumber: string;
    certificateName: string;
    issuingAuthority: string;
    issueDate: string;
    expiryDate: string | null;
    status: WorkforceCertificationStatus;
    verificationStatus: WorkforceCertificationVerificationStatus;
    verifiedByUserId: string | null;
    verifiedAt: string | null;
    documentId: string | null;
    fileReference: string | null;
    notes: string | null;
    createdByUserId: string | null;
  }): Promise<WorkforceCertificationRecord> {
    const id = randomUUID();
    await query(
      `INSERT INTO workforce_certifications (
         id,
         client_id,
         workforce_profile_id,
         skill_id,
         certificate_number,
         certificate_name,
         issuing_authority,
         issue_date,
         expiry_date,
         status,
         verification_status,
         verified_by_user_id,
         verified_at,
         document_id,
         file_reference,
         notes,
         created_by_user_id
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14, $15, $16, $17
       )`,
      [
        id,
        params.clientId,
        params.workforceProfileId,
        params.skillId,
        params.certificateNumber,
        params.certificateName,
        params.issuingAuthority,
        params.issueDate,
        params.expiryDate,
        params.status,
        params.verificationStatus,
        params.verifiedByUserId,
        params.verifiedAt,
        params.documentId,
        params.fileReference,
        params.notes,
        params.createdByUserId,
      ],
    );

    const created = await this.findById(id);
    if (!created) {
      throw new Error(
        `Failed to load newly created workforce_certification ${id}`,
      );
    }
    return created;
  },

  async update(
    id: string,
    updates: {
      skillId?: string | null;
      certificateNumber?: string;
      certificateName?: string;
      issuingAuthority?: string;
      issueDate?: string;
      expiryDate?: string | null;
      status?: WorkforceCertificationStatus;
      verificationStatus?: WorkforceCertificationVerificationStatus;
      verifiedByUserId?: string | null;
      verifiedAt?: string | null;
      documentId?: string | null;
      fileReference?: string | null;
      notes?: string | null;
    },
  ): Promise<WorkforceCertificationRecord | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let index = 1;

    if (updates.skillId !== undefined) {
      fields.push(`skill_id = $${index++}`);
      values.push(updates.skillId);
    }
    if (updates.certificateNumber !== undefined) {
      fields.push(`certificate_number = $${index++}`);
      values.push(updates.certificateNumber);
    }
    if (updates.certificateName !== undefined) {
      fields.push(`certificate_name = $${index++}`);
      values.push(updates.certificateName);
    }
    if (updates.issuingAuthority !== undefined) {
      fields.push(`issuing_authority = $${index++}`);
      values.push(updates.issuingAuthority);
    }
    if (updates.issueDate !== undefined) {
      fields.push(`issue_date = $${index++}`);
      values.push(updates.issueDate);
    }
    if (updates.expiryDate !== undefined) {
      fields.push(`expiry_date = $${index++}`);
      values.push(updates.expiryDate);
    }
    if (updates.status !== undefined) {
      fields.push(`status = $${index++}`);
      values.push(updates.status);
    }
    if (updates.verificationStatus !== undefined) {
      fields.push(`verification_status = $${index++}`);
      values.push(updates.verificationStatus);
    }
    if (updates.verifiedByUserId !== undefined) {
      fields.push(`verified_by_user_id = $${index++}`);
      values.push(updates.verifiedByUserId);
    }
    if (updates.verifiedAt !== undefined) {
      fields.push(`verified_at = $${index++}`);
      values.push(updates.verifiedAt);
    }
    if (updates.documentId !== undefined) {
      fields.push(`document_id = $${index++}`);
      values.push(updates.documentId);
    }
    if (updates.fileReference !== undefined) {
      fields.push(`file_reference = $${index++}`);
      values.push(updates.fileReference);
    }
    if (updates.notes !== undefined) {
      fields.push(`notes = $${index++}`);
      values.push(updates.notes);
    }

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const updateResult = await query(
      `UPDATE workforce_certifications
          SET ${fields.join(', ')}
        WHERE id = $${index}`,
      values,
    );
    if ((updateResult.rowCount ?? 0) === 0) {
      return null;
    }
    return this.findById(id);
  },
};
