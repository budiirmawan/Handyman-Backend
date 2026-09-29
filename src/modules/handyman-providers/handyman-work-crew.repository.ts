import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanCrewLeadRecord,
  HandymanCrewMembershipRecord,
  HandymanCrewStatus,
  HandymanWorkCrewRecord,
  NewHandymanCrewLeadRecord,
  NewHandymanCrewMembershipRecord,
  NewHandymanWorkCrewRecord,
} from './handyman-work-crew.types';

/**
 * CR-HM-04 PART 03 — crew repository (executor-first). Crews and
 * memberships own a bounded status update; lead designations are
 * APPEND-ONLY (the 0386 trigger refuses UPDATE/DELETE).
 */

type CrewRow = {
  id: string;
  client_id: string;
  handyman_provider_context_id: string;
  code: string;
  name: string;
  status: HandymanCrewStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

type MemberRow = {
  id: string;
  client_id: string;
  handyman_crew_id: string;
  handyman_worker_context_id: string;
  status: HandymanCrewStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

type LeadRow = {
  id: string;
  lead_seq: number;
  client_id: string;
  handyman_crew_id: string;
  handyman_crew_membership_id: string;
  designated_by_user_id: string;
  designated_at: Date;
};

function mapCrew(row: CrewRow): HandymanWorkCrewRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    handymanProviderContextId: row.handyman_provider_context_id,
    code: row.code,
    name: row.name,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMember(row: MemberRow): HandymanCrewMembershipRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    handymanCrewId: row.handyman_crew_id,
    handymanWorkerContextId: row.handyman_worker_context_id,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLead(row: LeadRow): HandymanCrewLeadRecord {
  return {
    id: row.id,
    leadSeq: row.lead_seq,
    clientId: row.client_id,
    handymanCrewId: row.handyman_crew_id,
    handymanCrewMembershipId: row.handyman_crew_membership_id,
    designatedByUserId: row.designated_by_user_id,
    designatedAt: row.designated_at,
  };
}

const CREW_SELECT = `
  SELECT id, client_id, handyman_provider_context_id, code, name, status,
         created_by_user_id, created_at, updated_at
    FROM handyman_work_crews`;

const MEMBER_SELECT = `
  SELECT id, client_id, handyman_crew_id, handyman_worker_context_id,
         status, created_by_user_id, created_at, updated_at
    FROM handyman_crew_memberships`;

const LEAD_SELECT = `
  SELECT id, lead_seq, client_id, handyman_crew_id,
         handyman_crew_membership_id, designated_by_user_id, designated_at
    FROM handyman_crew_leads`;

export const handymanWorkCrewRepository = {
  async insertCrew(
    executor: Pick<PoolClient, 'query'> = getPool(),
    record: NewHandymanWorkCrewRecord,
    createdByUserId: string,
  ): Promise<HandymanWorkCrewRecord> {
    const result = await executor.query<CrewRow>(
      `INSERT INTO handyman_work_crews (
         id, client_id, handyman_provider_context_id, code, name,
         created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, client_id, handyman_provider_context_id, code, name,
                 status, created_by_user_id, created_at, updated_at`,
      [
        randomUUID(),
        record.clientId,
        record.handymanProviderContextId,
        record.code,
        record.name,
        createdByUserId,
      ],
    );
    return mapCrew(result.rows[0]);
  },

  async findCrewById(
    executor: Pick<PoolClient, 'query'> = getPool(),
    id: string,
  ): Promise<HandymanWorkCrewRecord | null> {
    const result = await executor.query<CrewRow>(
      `${CREW_SELECT} WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapCrew(result.rows[0]) : null;
  },

  async lockCrewById(
    executor: Pick<PoolClient, 'query'>,
    id: string,
  ): Promise<HandymanWorkCrewRecord | null> {
    const result = await executor.query<CrewRow>(
      `${CREW_SELECT} WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return result.rows[0] ? mapCrew(result.rows[0]) : null;
  },

  async updateCrewStatus(
    executor: Pick<PoolClient, 'query'>,
    id: string,
    status: HandymanCrewStatus,
  ): Promise<HandymanWorkCrewRecord | null> {
    const result = await executor.query<CrewRow>(
      `UPDATE handyman_work_crews SET status = $2, updated_at = NOW()
        WHERE id = $1
       RETURNING id, client_id, handyman_provider_context_id, code, name,
                 status, created_by_user_id, created_at, updated_at`,
      [id, status],
    );
    return result.rows[0] ? mapCrew(result.rows[0]) : null;
  },

  async insertMembership(
    executor: Pick<PoolClient, 'query'> = getPool(),
    record: NewHandymanCrewMembershipRecord,
    createdByUserId: string,
  ): Promise<HandymanCrewMembershipRecord> {
    const result = await executor.query<MemberRow>(
      `INSERT INTO handyman_crew_memberships (
         id, client_id, handyman_crew_id, handyman_worker_context_id,
         created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, client_id, handyman_crew_id,
                 handyman_worker_context_id, status, created_by_user_id,
                 created_at, updated_at`,
      [
        randomUUID(),
        record.clientId,
        record.handymanCrewId,
        record.handymanWorkerContextId,
        createdByUserId,
      ],
    );
    return mapMember(result.rows[0]);
  },

  async findMembershipById(
    executor: Pick<PoolClient, 'query'> = getPool(),
    id: string,
  ): Promise<HandymanCrewMembershipRecord | null> {
    const result = await executor.query<MemberRow>(
      `${MEMBER_SELECT} WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapMember(result.rows[0]) : null;
  },

  async lockMembershipById(
    executor: Pick<PoolClient, 'query'>,
    id: string,
  ): Promise<HandymanCrewMembershipRecord | null> {
    const result = await executor.query<MemberRow>(
      `${MEMBER_SELECT} WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return result.rows[0] ? mapMember(result.rows[0]) : null;
  },

  async findActiveMembership(
    executor: Pick<PoolClient, 'query'> = getPool(),
    crewId: string,
    workerContextId: string,
  ): Promise<HandymanCrewMembershipRecord | null> {
    const result = await executor.query<MemberRow>(
      `${MEMBER_SELECT}
        WHERE handyman_crew_id = $1 AND handyman_worker_context_id = $2
          AND status = 'ACTIVE'`,
      [crewId, workerContextId],
    );
    return result.rows[0] ? mapMember(result.rows[0]) : null;
  },

  async updateMembershipStatus(
    executor: Pick<PoolClient, 'query'>,
    id: string,
    status: HandymanCrewStatus,
  ): Promise<HandymanCrewMembershipRecord | null> {
    const result = await executor.query<MemberRow>(
      `UPDATE handyman_crew_memberships SET status = $2, updated_at = NOW()
        WHERE id = $1
       RETURNING id, client_id, handyman_crew_id,
                 handyman_worker_context_id, status, created_by_user_id,
                 created_at, updated_at`,
      [id, status],
    );
    return result.rows[0] ? mapMember(result.rows[0]) : null;
  },

  async listMembershipsByCrew(
    executor: Pick<PoolClient, 'query'> = getPool(),
    crewId: string,
  ): Promise<HandymanCrewMembershipRecord[]> {
    const result = await executor.query<MemberRow>(
      `${MEMBER_SELECT} WHERE handyman_crew_id = $1 ORDER BY created_at`,
      [crewId],
    );
    return result.rows.map(mapMember);
  },

  /** APPEND: the immutable designation fact; never update/delete. */
  async appendLead(
    executor: Pick<PoolClient, 'query'> = getPool(),
    record: NewHandymanCrewLeadRecord,
    designatedByUserId: string,
  ): Promise<HandymanCrewLeadRecord> {
    const result = await executor.query<LeadRow>(
      `INSERT INTO handyman_crew_leads (
         id, client_id, handyman_crew_id, handyman_crew_membership_id,
         designated_by_user_id
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, lead_seq, client_id, handyman_crew_id,
                 handyman_crew_membership_id, designated_by_user_id,
                 designated_at`,
      [
        randomUUID(),
        record.clientId,
        record.handymanCrewId,
        record.handymanCrewMembershipId,
        designatedByUserId,
      ],
    );
    return mapLead(result.rows[0]);
  },

  /** Current lead = highest lead_seq for the crew (F4 single current). */
  async findCurrentLead(
    executor: Pick<PoolClient, 'query'> = getPool(),
    crewId: string,
  ): Promise<HandymanCrewLeadRecord | null> {
    const result = await executor.query<LeadRow>(
      `${LEAD_SELECT} WHERE handyman_crew_id = $1
        ORDER BY lead_seq DESC LIMIT 1`,
      [crewId],
    );
    return result.rows[0] ? mapLead(result.rows[0]) : null;
  },

  async listLeadHistory(
    executor: Pick<PoolClient, 'query'> = getPool(),
    crewId: string,
  ): Promise<HandymanCrewLeadRecord[]> {
    const result = await executor.query<LeadRow>(
      `${LEAD_SELECT} WHERE handyman_crew_id = $1 ORDER BY lead_seq`,
      [crewId],
    );
    return result.rows.map(mapLead);
  },
};
