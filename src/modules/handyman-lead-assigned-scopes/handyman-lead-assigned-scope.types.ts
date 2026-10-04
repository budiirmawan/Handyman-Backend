export type HandymanLeadScopeLocation = {
  buildingLabel: string;
  floorLabel: string | null;
  areaLabel: string | null;
  roomLabel: string | null;
  spaceLabel: string | null;
};

/** Internal, structured-only location facts used to form field labels. */
export type HandymanLeadLocationSource = {
  buildingCode: string;
  floorLevelNumber: number | null;
  areaCode: string | null;
  roomCode: string | null;
  spaceCode: string | null;
};

export type HandymanLeadPreferredWindow = {
  preferredWindowStart: string;
  preferredWindowEnd: string;
  timezone: string;
};

export type HandymanLeadAssignedScopeCard = {
  executionScopeId: string;
  assignmentId: string;
  assignmentStatus: 'ACTIVE';
  scopeStatus: 'AUTHORIZED';
  assignedAt: string;
  serviceLabel: string;
  location: HandymanLeadScopeLocation;
  preferredWindow: HandymanLeadPreferredWindow | null;
};

export type HandymanLeadWorkItem = {
  lineType: 'LABOR' | 'MATERIAL';
  description: string;
  quantity: number;
  unitLabel: string;
};

/** Internal work-item facts; arbitrary quotation description is excluded. */
export type HandymanLeadWorkItemRecord = {
  lineType: 'LABOR' | 'MATERIAL';
  quantity: number;
  unitLabel: string;
};

export type HandymanLeadSchedulingReadiness = {
  status: 'ACTIVE';
  preferredWindowStart: string;
  preferredWindowEnd: string;
  timezone: string;
};

export type HandymanLeadUnitAccessReadiness = {
  status: 'ACTIVE';
  accessWindowStart: string;
  accessWindowEnd: string;
};

export type HandymanLeadPermitReadiness = {
  permitType: 'UNIT' | 'BUILDING_COMMON_AREA';
  status: 'ACTIVE';
  validFrom: string;
  validUntil: string;
};

export type HandymanLeadCurrentReadiness = {
  scheduling: HandymanLeadSchedulingReadiness | null;
  unitAccess: HandymanLeadUnitAccessReadiness | null;
  permitReadiness: HandymanLeadPermitReadiness[];
};

export type HandymanLeadAssignedScopeDetail = {
  executionScopeId: string;
  assignmentId: string;
  assignmentStatus: 'ACTIVE';
  scopeStatus: 'AUTHORIZED';
  assignedAt: string;
  serviceLabel: string;
  location: HandymanLeadScopeLocation;
  workItems: HandymanLeadWorkItem[];
  readiness: HandymanLeadCurrentReadiness;
};

export type HandymanLeadPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type HandymanLeadAssignedScopeCandidate = {
  executionScopeId: string;
  clientId: string;
  assignmentId: string;
  assignedAt: Date;
  handymanRequestId: string;
  approvedQuotationVersionId: string;
  serviceLabel: string;
  location: HandymanLeadLocationSource;
  preferredWindowStart: Date | null;
  preferredWindowEnd: Date | null;
  preferredWindowTimezone: string | null;
};

export type HandymanLeadCurrentScope = Omit<
  HandymanLeadAssignedScopeCandidate,
  'preferredWindowStart' | 'preferredWindowEnd' | 'preferredWindowTimezone'
>;

export type HandymanLeadSchedulingReadinessRecord = {
  status: 'ACTIVE';
  preferredWindowStart: Date;
  preferredWindowEnd: Date;
  timezone: string;
};

export type HandymanLeadUnitAccessReadinessRecord = {
  status: 'ACTIVE';
  accessWindowStart: Date;
  accessWindowEnd: Date;
};

export type HandymanLeadPermitReadinessRecord = {
  permitType: 'UNIT' | 'BUILDING_COMMON_AREA';
  status: 'ACTIVE';
  validFrom: Date;
  validUntil: Date;
};

export type HandymanLeadAssignedScopePage = {
  data: HandymanLeadAssignedScopeCard[];
  meta: HandymanLeadPagination;
};
