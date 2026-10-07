export type PublicFindingHistoryEvent = {
  id: string;
  findingId: string;
  clientId: string;
  buildingId: string | null;
  eventType: string;
  actorUserId: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
};

export type FindingHistoryFilters = {
  eventType?: string;
  from?: string;
  to?: string;
};
