import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { getPool } from '../../database';
import type {
  ListWorkforceCertificationsFilter,
  WorkforceCertificationDocumentSummary,
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
  buildingId: string | null;
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
  const daysUntilExpiry =
    expiryDate !== null && row.status !== 'INACTIVE'
      ? Math.ceil(
          (new Date(expiryDate).getTime() - now.getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : null;
  const isValidForRequirement =
    row.status === 'ACTIVE' &&
    expiryStatus === 'VALID' &&
    row.verification_status === 'VERIFIED';
  const hasDocument = Boolean(row.document_id || effectiveFileReference);

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
    daysUntilExpiry,
    isValidForRequirement,
    verificationStatus: row.verification_status,
    verifiedByUserId: row.verified_by_user_id,
    verifiedAt: toNullableIso(row.verified_at),
    hasDocument,
    documentId: row.document_id,
    fileReference: effectiveFileReference,
    documentReference: docSummary,
    notes: row.notes,
    createdByUserId: row.created_by_user_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const SELECT_WITH_RELATIONS = `
  SELECT wc.id,
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
    FROM workforce_certifications wc
    LEFT JOIN skills s
      ON s.id = wc.skill_id
     AND s.client_id = wc.client_id
    LEFT JOIN documents d
      ON d.id = wc.document_id
     AND d.client_id = wc.client_id
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
      building_id: string | null;
      status: string;
      document_number: string;
      document_type: string;
      title: string;
      file_reference: string;
    }>(
      `SELECT id,
              client_id,
              building_id,
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
      buildingId: row.building_id,
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

  async listExpiring(params: {
    clientIds: string[];
    withinDays: number;
    includeExpired?: boolean;
    workforceProfileId?: string;
    verificationStatus?: WorkforceCertificationVerificationStatus;
  }): Promise<WorkforceCertificationRecord[]> {
    if (params.clientIds.length === 0) {
      return [];
    }

    const queryParams: unknown[] = [params.clientIds, params.withinDays];
    const conditions: string[] = [
      'wc.client_id = ANY($1::uuid[])',
      'wc.expiry_date IS NOT NULL',
      `wc.expiry_date <= (NOW() + ($2::int * INTERVAL '1 day'))`,
    ];

    if (params.includeExpired) {
      conditions.push(`wc.status IN ('ACTIVE', 'EXPIRED')`);
    } else {
      conditions.push(`wc.status = 'ACTIVE'`);
      conditions.push(`wc.expiry_date >= NOW()`);
    }

    if (params.workforceProfileId) {
      queryParams.push(params.workforceProfileId);
      conditions.push(`wc.workforce_profile_id = $${queryParams.length}`);
    }

    if (params.verificationStatus) {
      queryParams.push(params.verificationStatus);
      conditions.push(`wc.verification_status = $${queryParams.length}`);
    }

    const result = await query<WorkforceCertificationRow>(
      `${SELECT_WITH_RELATIONS}
        WHERE ${conditions.join(' AND ')}
        ORDER BY wc.expiry_date ASC, wc.issue_date DESC, wc.id ASC`,
      queryParams,
    );
    const now = new Date();
    return result.rows.map((row) => mapRow(row, now));
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
