import { migration0001InitialFoundation } from './0001_initial_foundation';
import { migration0002CreateUsers } from './0002_create_users';
import { migration0003CreateUserCredentials } from './0003_create_user_credentials';
import { migration0004CreateUserSessions } from './0004_create_user_sessions';
import { migration0005CreateRoles } from './0005_create_roles';
import { migration0006CreateUserRoleAssignments } from './0006_create_user_role_assignments';
import { migration0007CreatePermissions } from './0007_create_permissions';
import { migration0008CreateRolePermissionAssignments } from './0008_create_role_permission_assignments';
import { migration0009AddInvitedUserStatus } from './0009_add_invited_user_status';
import { migration0010CreateUserInvitations } from './0010_create_user_invitations';
import { migration0011CreateAuthenticationAuditEvents } from './0011_create_authentication_audit_events';
import { migration0012CreateClients } from './0012_create_clients';
import { migration0013CreateSubscriptions } from './0013_create_subscriptions';
import { migration0014CreateLicenses } from './0014_create_licenses';
import { migration0015CreateModules } from './0015_create_modules';
import { migration0016CreateModuleEntitlements } from './0016_create_module_entitlements';
import { migration0017CreateProperties } from './0017_create_properties';
import { migration0018CreateBuildings } from './0018_create_buildings';
import { migration0019CreateUserBuildingAssignments } from './0019_create_user_building_assignments';
import { migration0020CreateOrganizations } from './0020_create_organizations';
import { migration0021CreateDepartments } from './0021_create_departments';
import { migration0022CreateTeams } from './0022_create_teams';
import { migration0023CreatePositions } from './0023_create_positions';
import { migration0024CreateWorkforceProfiles } from './0024_create_workforce_profiles';
import { migration0025CreateSkills } from './0025_create_skills';
import { migration0026CreateWorkforceSkillAssignments } from './0026_create_workforce_skill_assignments';
import { migration0027CreateShifts } from './0027_create_shifts';
import { migration0028CreateWorkforceShiftAssignments } from './0028_create_workforce_shift_assignments';
import { migration0029CreateWorkforceReportingLines } from './0029_create_workforce_reporting_lines';
import { migration0030CreateWorkforceBuildingAssignments } from './0030_create_workforce_building_assignments';
import { migration0031AddExternalWorkforceType } from './0031_add_external_workforce_type';
import { migration0032CreateExternalOrganizations } from './0032_create_external_organizations';
import { migration0033CreateExternalWorkforceLinks } from './0033_create_external_workforce_links';
import { migration0034CreateFloors } from './0034_create_floors';
import { migration0035CreateCampuses } from './0035_create_campuses';
import { migration0036AddBuildingCampusReference } from './0036_add_building_campus_reference';
import { migration0037CreateAreas } from './0037_create_areas';
import { migration0038CreateRooms } from './0038_create_rooms';
import { migration0039CreateRoomTypes } from './0039_create_room_types';
import { migration0040AddRoomTypeReference } from './0040_add_room_type_reference';
import { migration0041CreateSpaces } from './0041_create_spaces';
import { migration0042CreateFunctionalLocations } from './0042_create_functional_locations';
import { migration0043CreateAssets } from './0043_create_assets';
import { migration0044CreateAssetCategories } from './0044_create_asset_categories';
import { migration0045CreateAssetTypes } from './0045_create_asset_types';
import { migration0046AddAssetClassificationReference } from './0046_add_asset_classification_reference';
import { migration0047AddAssetLocationBinding } from './0047_add_asset_location_binding';
import { migration0048CreateEquipmentProfiles } from './0048_create_equipment_profiles';
import { migration0049AddAssetLifecycleStatus } from './0049_add_asset_lifecycle_status';
import { migration0050CreateAssetWarranties } from './0050_create_asset_warranties';
import { migration0051CreateAssetCertifications } from './0051_create_asset_certifications';
import { migration0052CreateAssetIdentifiers } from './0052_create_asset_identifiers';
import { migration0053CreateAssetHistoryEvents } from './0053_create_asset_history_events';
import { migration0054CreateVendors } from './0054_create_vendors';
import { migration0055CreateVendorCategories } from './0055_create_vendor_categories';
import { migration0056AddVendorCategoryReference } from './0056_add_vendor_category_reference';
import { migration0057CreateVendorPics } from './0057_create_vendor_pics';
import { migration0058CreateVendorBuildingRelationships } from './0058_create_vendor_building_relationships';
import { migration0059CreateVendorCapabilities } from './0059_create_vendor_capabilities';
import { migration0060CreateVendorWorkforceBindings } from './0060_create_vendor_workforce_bindings';
import { migration0061CreateVendorComplianceDocuments } from './0061_create_vendor_compliance_documents';
import { migration0062CreateVendorLicensesCertifications } from './0062_create_vendor_licenses_certifications';
import { migration0063CreateSourceForms } from './0063_create_source_forms';
import { migration0064CreateFormTemplates } from './0064_create_form_templates';
import { migration0065CreateFormSectionsFields } from './0065_create_form_sections_fields';
import { migration0066CreateFormTemplateVersions } from './0066_create_form_template_versions';
import { migration0067CreateFormInstancesResponses } from './0067_create_form_instances_responses';
import { migration0068CreateFormConditionsRepeatables } from './0068_create_form_conditions_repeatables';
import { migration0069CreateChecklistTemplates } from './0069_create_checklist_templates';
import { migration0070CreateChecklistExecutions } from './0070_create_checklist_executions';
import { migration0071CreateUomMeasurements } from './0071_create_uom_measurements';
import { migration0072CreateEvidenceRequirements } from './0072_create_evidence_requirements';
import { migration0073CreateEvidenceSubmissions } from './0073_create_evidence_submissions';
import { migration0074CreateReviews } from './0074_create_reviews';
import { migration0075CreateScheduleDefinitions } from './0075_create_schedule_definitions';
import { migration0076CreateScheduleRecurrence } from './0076_create_schedule_recurrence';
import { migration0077CreateTasks } from './0077_create_tasks';
import { migration0078CreateTaskAssignments } from './0078_create_task_assignments';
import { migration0079ExtendTaskExecution } from './0079_extend_task_execution';
import { migration0080CreateOperationalEvents } from './0080_create_operational_events';
import { migration0081CreateWorkRequests } from './0081_create_work_requests';
import { migration0082CreateWorkOrders } from './0082_create_work_orders';
import { migration0083AddWorkOrderPriorityLifecycle } from './0083_add_work_order_priority_lifecycle';
import { migration0084AddWorkOrderAssetLocation } from './0084_add_work_order_asset_location';
import { migration0085CreateWorkOrderAssignments } from './0085_create_work_order_assignments';
import { migration0086CreateWorkOrderActions } from './0086_create_work_order_actions';
import { migration0087AddWorkOrderEvidenceBinding } from './0087_add_work_order_evidence_binding';
import { migration0088AddWorkOrderCompletion } from './0088_add_work_order_completion';
import { migration0089AddWorkOrderVerification } from './0089_add_work_order_verification';
import { migration0090CreateFindings } from './0090_create_findings';
import { migration0091AddFindingClassificationSeverity } from './0091_add_finding_classification_severity';
import { migration0092AddFindingSourceBinding } from './0092_add_finding_source_binding';
import { migration0093CreateFindingAssignments } from './0093_create_finding_assignments';
import { migration0094ExtendFindingOperationalStates } from './0094_extend_finding_operational_states';
import { migration0095AddFindingReviews } from './0095_add_finding_reviews';
import { migration0096AddFindingReworkCycles } from './0096_add_finding_rework_cycles';
import { migration0097AddFindingClosure } from './0097_add_finding_closure';
import { migration0098CreateInspectionBindings } from './0098_create_inspection_bindings';
import { migration0099AddInspectionExecutionBinding } from './0099_add_inspection_execution_binding';
import { migration0100CreateMeterReadingBindings } from './0100_create_meter_reading_bindings';
import { migration0101AddMeterReadingExecutionBinding } from './0101_add_meter_reading_execution_binding';
import { migration0102CreateLogSheetBindings } from './0102_create_log_sheet_bindings';
import { migration0103AddLogSheetExecutionBinding } from './0103_add_log_sheet_execution_binding';
import { migration0104CreateEngineeringChecklistBindings } from './0104_create_engineering_checklist_bindings';
import { migration0105AddEngineeringChecklistExecutionBinding } from './0105_add_engineering_checklist_execution_binding';
import { migration0106CreateBreakdownBindings } from './0106_create_breakdown_bindings';
import { migration0107CreateMaintenanceBindings } from './0107_create_maintenance_bindings';
import { migration0108AddMaintenanceTaskBinding } from './0108_add_maintenance_task_binding';
import { migration0109CreateEngineeringFindingLinks } from './0109_create_engineering_finding_links';
import { migration0110CreateShiftHandovers } from './0110_create_shift_handovers';
import { migration0111CreateCleaningAreas } from './0111_create_cleaning_areas';
import { migration0112CreateCleaningScheduleBindings } from './0112_create_cleaning_schedule_bindings';
import { migration0113CreateToiletInspectionBindings } from './0113_create_toilet_inspection_bindings';
import { migration0114CreatePublicAreaInspectionBindings } from './0114_create_public_area_inspection_bindings';
import { migration0115CreateSupervisorInspections } from './0115_create_supervisor_inspections';
import { migration0116CreateHousekeepingFindingLinks } from './0116_create_housekeeping_finding_links';
import { migration0117CreateConsumableReadiness } from './0117_create_consumable_readiness';
import { migration0118CreateQualityAudits } from './0118_create_quality_audits';
import { migration0119CreateHousekeepingComplaintBindings } from './0119_create_housekeeping_complaint_bindings';
import { migration0120CreateSecurityPosts } from './0120_create_security_posts';
import { migration0121CreatePatrolRoutes } from './0121_create_patrol_routes';
import { migration0122CreatePatrolRoutePoints } from './0122_create_patrol_route_points';
import { migration0123CreatePatrolScheduleBindings } from './0123_create_patrol_schedule_bindings';
import { migration0124CreatePatrolPointVisits } from './0124_create_patrol_point_visits';
import { migration0125CreatePatrolChecklistBindings } from './0125_create_patrol_checklist_bindings';
import { migration0126AddPatrolChecklistExecutionBinding } from './0126_add_patrol_checklist_execution_binding';
import { migration0127CreateSecurityShiftHandoverBindings } from './0127_create_security_shift_handover_bindings';
import { migration0128CreateSecurityFindingLinks } from './0128_create_security_finding_links';
import { migration0129CreateSecurityIncidentReadiness } from './0129_create_security_incident_readiness';
import { migration0130CreateSecurityVisitorBindings } from './0130_create_security_visitor_bindings';
import { migration0131CreateSecurityKeysAndCustody } from './0131_create_security_keys_and_custody';
import { migration0132CreateSecurityLostAndFound } from './0132_create_security_lost_and_found';
import { migration0133CreateVisitors } from './0133_create_visitors';
import { migration0134CreateVisitorInvitations } from './0134_create_visitor_invitations';
import { migration0135CreateExpectedVisitors } from './0135_create_expected_visitors';
import { migration0136CreateWalkInVisits } from './0136_create_walk_in_visits';
import { migration0137CreateVisitorPhotos } from './0137_create_visitor_photos';
import { migration0138CreateHostConfirmations } from './0138_create_host_confirmations';
import { migration0139CreateVisitCheckIns } from './0139_create_visit_check_ins';
import { migration0140AddVisitCheckOut } from './0140_add_visit_check_out';
import { migration0141CreateVisitorPasses } from './0141_create_visitor_passes';
import { migration0142CreateContractorVisitors } from './0142_create_contractor_visitors';
import { migration0143CreateDeliveryCouriers } from './0143_create_delivery_couriers';
import { migration0144CreateTenantCompanies } from './0144_create_tenant_companies';
import { migration0145CreateTenantPics } from './0145_create_tenant_pics';
import { migration0146CreateTenantSpaceRelationships } from './0146_create_tenant_space_relationships';
import { migration0147CreateTenantBuildingContexts } from './0147_create_tenant_building_contexts';
import { migration0148CreateTenantServiceRequests } from './0148_create_tenant_service_requests';
import { migration0149CreateTenantComplaints } from './0149_create_tenant_complaints';
import { migration0150CreateTenantUtilityRequests } from './0150_create_tenant_utility_requests';
import { migration0151CreateTenantApprovalBindings } from './0151_create_tenant_approval_bindings';
import { migration0152CreateTenantContractorRelationships } from './0152_create_tenant_contractor_relationships';
import { migration0153CreateTenantDocuments } from './0153_create_tenant_documents';
import { migration0154CreateTenantCommunications } from './0154_create_tenant_communications';
import { migration0155CreateVendorAssignments } from './0155_create_vendor_assignments';
import { migration0156CreateVendorWorks } from './0156_create_vendor_works';
import { migration0157CreateVendorChecklistBindings } from './0157_create_vendor_checklist_bindings';
import { migration0158CreateWorkPermitReadiness } from './0158_create_work_permit_readiness';
import { migration0159AddVendorWorkEvidenceBinding } from './0159_add_vendor_work_evidence_binding';
import { migration0160CreateVendorCompletionReports } from './0160_create_vendor_completion_reports';
import { migration0161CreateVendorServiceReports } from './0161_create_vendor_service_reports';
import { migration0162CreateVendorBastBindings } from './0162_create_vendor_bast_bindings';
import { migration0163AddVendorWorkVerification } from './0163_add_vendor_work_verification';
import { migration0164CreateVendorReworkCycles } from './0164_create_vendor_rework_cycles';
import { migration0165AddVendorWorkHistory } from './0165_add_vendor_work_history';
import { migration0166CreateInventoryItems } from './0166_create_inventory_items';
import { migration0167CreateInventoryWarehouses } from './0167_create_inventory_warehouses';
import { migration0168CreateInventoryStockBalances } from './0168_create_inventory_stock_balances';
import { migration0169CreateInventoryStockMovements } from './0169_create_inventory_stock_movements';
import { migration0170CreateInventoryStockTransfers } from './0170_create_inventory_stock_transfers';
import { migration0171CreateInventoryStockAdjustments } from './0171_create_inventory_stock_adjustments';
import { migration0172CreateInventoryMinimumStocks } from './0172_create_inventory_minimum_stocks';
import { migration0173CreateInventoryAssetSpareParts } from './0173_create_inventory_asset_spare_parts';
import { migration0174CreateInventoryWorkOrderMaterialUsages } from './0174_create_inventory_work_order_material_usages';
import { migration0175CreateInventoryHousekeepingConsumableBindings } from './0175_create_inventory_housekeeping_consumable_bindings';
import { migration0176CreatePurchaseRequests } from './0176_create_purchase_requests';
import { migration0177CreateMaterialRequests } from './0177_create_material_requests';
import { migration0178CreateServiceRequests } from './0178_create_service_requests';
import { migration0179CreateProcurementApprovalBindings } from './0179_create_procurement_approval_bindings';
import { migration0180CreateVendorSelectionReadiness } from './0180_create_vendor_selection_readiness';
import { migration0181CreatePurchaseOrderReadiness } from './0181_create_purchase_order_readiness';
import { migration0182CreateReceivings } from './0182_create_receivings';
import { migration0183CreateWorkOrderProcurementBindings } from './0183_create_work_order_procurement_bindings';
import { migration0184CreateUtilityMeters } from './0184_create_utility_meters';
import { migration0185CreateUtilityTypeConfigurations } from './0185_create_utility_type_configurations';
import { migration0186CreateUtilityMeterHierarchies } from './0186_create_utility_meter_hierarchies';
import { migration0187CreateUtilityMeterTenantAssignments } from './0187_create_utility_meter_tenant_assignments';
import { migration0188CreateUtilityMeterReadings } from './0188_create_utility_meter_readings';
import { migration0189AddMeterReadingEvidenceBinding } from './0189_add_meter_reading_evidence_binding';
import { migration0190CreateUtilityMeterConsumptions } from './0190_create_utility_meter_consumptions';
import { migration0191CreateUtilityCalculations } from './0191_create_utility_calculations';
import { migration0192CreateUtilityAbnormalConsumptions } from './0192_create_utility_abnormal_consumptions';
import { migration0193AddUtilityVerification } from './0193_add_utility_verification';
import { migration0194AddUtilityTenantApprovalBinding } from './0194_add_utility_tenant_approval_binding';
import { migration0195CreateTenantCharges } from './0195_create_tenant_charges';
import { migration0196CreateUtilityBills } from './0196_create_utility_bills';
import { migration0197CreateServiceChargeReadiness } from './0197_create_service_charge_readiness';
import { migration0198CreateTenantInvoices } from './0198_create_tenant_invoices';
import { migration0199CreateInvoicePaymentStatus } from './0199_create_invoice_payment_status';
import { migration0200CreatePaymentReceipts } from './0200_create_payment_receipts';
import { migration0201CreateVendorServiceCosts } from './0201_create_vendor_service_costs';
import { migration0202CreateBasicExpenses } from './0202_create_basic_expenses';
import { migration0203CreatePermits } from './0203_create_permits';
import { migration0204CreatePermitApplications } from './0204_create_permit_applications';
import { migration0205CreatePermitWorkContexts } from './0205_create_permit_work_contexts';
import { migration0206CreatePermitSafetyRequirements } from './0206_create_permit_safety_requirements';
import { migration0207CreatePermitApprovalBindings } from './0207_create_permit_approval_bindings';
import { migration0208CreatePermitValidities } from './0208_create_permit_validities';
import { migration0209CreatePermitWorkers } from './0209_create_permit_workers';
import { migration0210CreatePermitEquipment } from './0210_create_permit_equipment';
import { migration0211AddPermitEvidenceBinding } from './0211_add_permit_evidence_binding';
import { migration0212CreatePermitWorkLifecycles } from './0212_create_permit_work_lifecycles';
import { migration0213RestoreReviewTargetUnion } from './0213_restore_review_target_union';
import { migration0214CreateIncidents } from './0214_create_incidents';
import { migration0215CreateOperationalIncidents } from './0215_create_operational_incidents';
import { migration0216CreateAssetFailureIncidents } from './0216_create_asset_failure_incidents';
import { migration0217CreateFindingEscalationIncidents } from './0217_create_finding_escalation_incidents';
import { migration0218CreateImmediateActions } from './0218_create_immediate_actions';
import { migration0219CreateCorrectiveActions } from './0219_create_corrective_actions';
import { migration0220CreateCorrectiveActionResponsibilities } from './0220_create_corrective_action_responsibilities';
import { migration0221AddCorrectiveActionDueDate } from './0221_add_corrective_action_due_date';
import { migration0222AddCorrectiveActionVerification } from './0222_add_corrective_action_verification';
import { migration0223AddIncidentClosure } from './0223_add_incident_closure';
import { migration0224CreateDocuments } from './0224_create_documents';
import { migration0225CreateWorkCompletionDocuments } from './0225_create_work_completion_documents';
import { migration0226CreateBastDocuments } from './0226_create_bast_documents';
import { migration0227CreateHandoverDocuments } from './0227_create_handover_documents';
import { migration0228CreateAcceptanceSignOffs } from './0228_create_acceptance_sign_offs';
import { migration0229CreateSupportingDocuments } from './0229_create_supporting_documents';
import { migration0230CreateDocumentVersions } from './0230_create_document_versions';
import { migration0231AddDocumentExpiry } from './0231_add_document_expiry';
import { migration0232AddDocumentApprovalTarget } from './0232_add_document_approval_target';
import { migration0233AddDocumentArchive } from './0233_add_document_archive';
import { migration0234CreateMobileSyncIdempotency } from './0234_create_mobile_sync_idempotency';
import { migration0235CreateMobilePushTokens } from './0235_create_mobile_push_tokens';
import { migration0236CreateMobileAppVersions } from './0236_create_mobile_app_versions';
import { migration0237CreateNotifications } from './0237_create_notifications';
import { migration0238CreateNotificationTemplates } from './0238_create_notification_templates';
import { migration0239CreateNotificationEventSubscriptions } from './0239_create_notification_event_subscriptions';
import { migration0240AddNotificationDeliveryColumns } from './0240_add_notification_delivery_columns';
import { migration0241CreateNotificationEmailDeliveries } from './0241_create_notification_email_deliveries';
import { migration0242CreateNotificationWhatsappDeliveries } from './0242_create_notification_whatsapp_deliveries';
import { migration0243CreateNotificationReminders } from './0243_create_notification_reminders';
import { migration0244CreateNotificationEscalations } from './0244_create_notification_escalations';
import { migration0245CreateNotificationSecureLinks } from './0245_create_notification_secure_links';
import { migration0246CreateClientConfigurations } from './0246_create_client_configurations';
import { migration0247CreateBuildingConfigurations } from './0247_create_building_configurations';
import { migration0248CreateModuleConfigurations } from './0248_create_module_configurations';
import { migration0249CreateFeatureEntitlementConfigurations } from './0249_create_feature_entitlement_configurations';
import { migration0250CreateNavigationRegistry } from './0250_create_navigation_registry';
import { migration0251CreateWorkspaceRegistry } from './0251_create_workspace_registry';
import { migration0252CreateDashboardWidgetConfigurations } from './0252_create_dashboard_widget_configurations';
import { migration0253CreateFormConfigurationBindings } from './0253_create_form_configuration_bindings';
import { migration0254CreateChecklistConfigurationBindings } from './0254_create_checklist_configuration_bindings';
import { migration0255CreateCmsContent } from './0255_create_cms_content';
import { migration0256CreateConfigurationVersions } from './0256_create_configuration_versions';
import { migration0257AddConfigurationLifecycle } from './0257_add_configuration_lifecycle';
import { migration0258CreateConfigurationPreviewContexts } from './0258_create_configuration_preview_contexts';
import { migration0259EstablishCanonicalBastFoundation } from './0259_establish_canonical_bast_foundation';
import { migration0260AddCanonicalBastCommands } from './0260_add_canonical_bast_commands';
import { migration0261CreateVendorInvoices } from './0261_create_vendor_invoices';
import { migration0262AddVendorInvoiceVerification } from './0262_add_vendor_invoice_verification';
import { migration0263AddVendorInvoicePaymentStatus } from './0263_add_vendor_invoice_payment_status';
import { migration0264AddReceivingMaterialRequestBinding } from './0264_add_receiving_material_request_binding';
import { migration0265AddMaterialRequestApprovedQuantity } from './0265_add_material_request_approved_quantity';
import { migration0266AddOperationalUomSnapshots } from './0266_add_operational_uom_snapshots';
import { migration0267AddWoMaterialUsageCost } from './0267_add_wo_material_usage_cost';
import { migration0268AddWoMaterialUsageMovementLink } from './0268_add_wo_material_usage_movement_link';
import { migration0269CreatePurchaseOrders } from './0269_create_purchase_orders';
import { migration0270CreatePurchaseOrderLines } from './0270_create_purchase_order_lines';
import { migration0271AddPurchaseOrderIssuance } from './0271_add_purchase_order_issuance';
import { migration0272CreateWorkContracts } from './0272_create_work_contracts';
import { migration0273AddWoProcurementSpkBinding } from './0273_add_wo_procurement_spk_binding';
import { migration0274AddVendorInvoiceProcurementLinkage } from './0274_add_vendor_invoice_procurement_linkage';
import { migration0275CreateAttendanceRecords } from './0275_create_attendance_records';
import { migration0276CreateSecurityLogbookEntries } from './0276_create_security_logbook_entries';
import { migration0277AddFindingEvidenceParents } from './0277_add_finding_evidence_parents';
import { migration0278AddUtilityTariffs } from './0278_add_utility_tariffs';
import { migration0279AddTenantUtilityBillingHandoff } from './0279_add_tenant_utility_billing_handoff';
import { migration0280CreateBuildingUtilityReconciliations } from './0280_create_building_utility_reconciliations';
import { migration0281CreateUtilityReadingDuesOcr } from './0281_create_utility_reading_dues_ocr';
import { migration0282CreateUtilityOperationalExceptions } from './0282_create_utility_operational_exceptions';
import { migration0283CreateOperationalBudgetFoundation } from './0283_create_operational_budget_foundation';
import { migration0284CreateOperationalBudgetSourceBindings } from './0284_create_operational_budget_source_bindings';
import { migration0285AddOperationalBudgetName } from './0285_add_operational_budget_name';
import { migration0286AddCorrectiveActionReviewTarget } from './0286_add_corrective_action_review_target';
import { migration0287CreateInventoryMaterialReservations } from './0287_create_inventory_material_reservations';
import { migration0288AddMaterialRequestLinkToWoUsage } from './0288_add_material_request_link_to_wo_usage';
import { migration0289AddMaterialReservationConsumption } from './0289_add_material_reservation_consumption';
import { migration0290AddReservationLinkToWoUsage } from './0290_add_reservation_link_to_wo_usage';
import { migration0291CreateSlaDefinitions } from './0291_create_sla_definitions';
import { migration0292CreateAppliedSlasAndClocks } from './0292_create_applied_slas_and_clocks';
import { migration0293CreateSlaClockPauseIntervals } from './0293_create_sla_clock_pause_intervals';
import { migration0294AddSlaClockBreach } from './0294_add_sla_clock_breach';
import { migration0295CreateSlaEscalationPolicies } from './0295_create_sla_escalation_policies';
import { migration0296CreateSlaEscalationLevels } from './0296_create_sla_escalation_levels';
import { migration0297CreateSlaEscalationActions } from './0297_create_sla_escalation_actions';
import { migration0298CreateNotificationOutboundDeliveries } from './0298_create_notification_outbound_deliveries';
import { migration0299AddNotificationDeliveryAttemptLinkage } from './0299_add_notification_delivery_attempt_linkage';
import { migration0300WidenNotificationTemplateChannels } from './0300_widen_notification_template_channels';
import { migration0301AddUserWhatsappContactConsent } from './0301_add_user_whatsapp_contact_consent';
import { migration0302AddOutboundDeliveryFeedback } from './0302_add_outbound_delivery_feedback';
import { migration0303AddEvidenceIntegrityMetadata } from './0303_add_evidence_integrity_metadata';
import { migration0304CreateEvidenceRetentionPolicies } from './0304_create_evidence_retention_policies';
import { migration0305AddEvidencePurgedAt } from './0305_add_evidence_purged_at';
import { migration0306CreateIntegrationOutboxEvents } from './0306_create_integration_outbox_events';
import { migration0307CreateIntegrationWebhookEndpoints } from './0307_create_integration_webhook_endpoints';
import { migration0308CreateIntegrationWebhookDeliveries } from './0308_create_integration_webhook_deliveries';
import { migration0309AddOperationalEventCorrelation } from './0309_add_operational_event_correlation';
import { migration0310AddOperationalBudgetOverspendPolicy } from './0310_add_operational_budget_overspend_policy';
import { migration0311CreateOperationalCommitments } from './0311_create_operational_commitments';
import { migration0312CreateOperationalCommitmentEntries } from './0312_create_operational_commitment_entries';
import { migration0313CreateRfqs } from './0313_create_rfqs';
import { migration0314CreateRfqVendorInvitationsAndSessions } from './0314_create_rfq_vendor_invitations_and_sessions';
import { migration0315CreateVendorQuotationsAndRevisionAttachments } from './0315_create_vendor_quotations_and_revision_attachments';
import { migration0316CreateRfqComparisonsAndEvaluations } from './0316_create_rfq_comparisons_and_evaluations';
import { migration0317CreateRfqRecommendationsApprovalsAwards } from './0317_create_rfq_recommendations_approvals_awards';
import { migration0318CreateRfqAwardPoProvenance } from './0318_create_rfq_award_po_provenance';
import { migration0319CreatePriceCatalogEntries } from './0319_create_price_catalog_entries';
import { migration0320AddRfqComparisonReferencePrice } from './0320_add_rfq_comparison_reference_price';
import { migration0321CreateServiceCatalog } from './0321_create_service_catalog';
import { migration0322AddServiceRequestCatalogAnchor } from './0322_add_service_request_catalog_anchor';
import { migration0323AddVendorCapabilityServiceIdentity } from './0323_add_vendor_capability_service_identity';
import { migration0324AddServiceLineageIdentity } from './0324_add_service_lineage_identity';
import { migration0325ActivateServiceReferencePrice } from './0325_activate_service_reference_price';
import { migration0326CreateEsgMetricDefinitions } from './0326_create_esg_metric_definitions';
import { migration0327CreateEsgWasteRecords } from './0327_create_esg_waste_records';
import { migration0328CreateEsgMetricValues } from './0328_create_esg_metric_values';
import { migration0329CreateEsgBaselinesTargetsVerification } from './0329_create_esg_baselines_targets_verification';
import { migration0330CreateReportArchives } from './0330_create_report_archives';
import { migration0331CreateCurrencyReferenceAndClientMonetaryContext } from './0331_create_currency_reference_and_client_monetary_context';
import { migration0332AddOperationalBillingCurrencySnapshots } from './0332_add_operational_billing_currency_snapshots';
import { migration0333CreateFxRateAuthorityAndClientFxPolicy } from './0333_create_fx_rate_authority_and_client_fx_policy';
import { migration0334ExtendMobilePushTokensForDelivery } from './0334_extend_mobile_push_tokens_for_delivery';
import { migration0335WidenOutboundDeliveryChannelsForPush } from './0335_widen_outbound_delivery_channels_for_push';
import { migration0336CreateNotificationPushDeliveries } from './0336_create_notification_push_deliveries';
import { migration0337AddSecurityPostToWorkforceShiftAssignments } from './0337_add_security_post_to_workforce_shift_assignments';
import { migration0338BindChecklistExecutionToGeneratedTask } from './0338_bind_checklist_execution_to_generated_task';
import { migration0339UniqueChecklistExecutionPerGeneratedTask } from './0339_unique_checklist_execution_per_generated_task';
import { migration0340BindFormInstanceToGeneratedTask } from './0340_bind_form_instance_to_generated_task';
import { migration0341CreateChecklistItemOptions } from './0341_create_checklist_item_options';
import { migration0342AddChecklistNaColumns } from './0342_add_checklist_na_columns';
import { migration0343AddChecklistExecutionCompletedByUserId } from './0343_add_checklist_execution_completed_by_user_id';
import { migration0344AddChecklistExecutionAssignmentSnapshot } from './0344_add_checklist_execution_assignment_snapshot';
import { migration0345AddChecklistResponseLastRespondedByUserId } from './0345_add_checklist_response_last_responded_by_user_id';
import { migration0346AddFormInstanceAttributionSnapshot } from './0346_add_form_instance_attribution_snapshot';
import { migration0347AddFormResponseLastRespondedByUserId } from './0347_add_form_response_last_responded_by_user_id';
import { migration0348CreateHandymanRequests } from './0348_create_handyman_requests';
import { migration0349CreateHandymanProviders } from './0349_create_handyman_providers';
import { migration0350AddHandymanRequestGovernance } from './0350_add_handyman_request_governance';
import { migration0351CreateHandymanQuotations } from './0351_create_handyman_quotations';
import { migration0352CreateHandymanQuotationApprovals } from './0352_create_handyman_quotation_approvals';
import { migration0353CreateHandymanWorkCrews } from './0353_create_handyman_work_crews';
import { migration0354CreateHandymanJobs } from './0354_create_handyman_jobs';
import { migration0355CreateHandymanServiceVisits } from './0355_create_handyman_service_visits';
import { migration0356CreateHandymanVisitArrivalsAndPresence } from './0356_create_handyman_visit_arrivals_and_presence';
import { migration0357CreateHandymanWorkSessions } from './0357_create_handyman_work_sessions';
import { migration0358CreateHandymanMaterialDemands } from './0358_create_handyman_material_demands';
import { migration0359IntegrateHandymanMaterialInventory } from './0359_integrate_handyman_material_inventory';
import { migration0360ExtendSupportingDocumentsForHandymanMaterial } from './0360_extend_supporting_documents_for_handyman_material';
import type { Migration } from './types';

export type { Migration } from './types';

export const migrations: readonly Migration[] = [
  migration0001InitialFoundation,
  migration0002CreateUsers,
  migration0003CreateUserCredentials,
  migration0004CreateUserSessions,
  migration0005CreateRoles,
  migration0006CreateUserRoleAssignments,
  migration0007CreatePermissions,
  migration0008CreateRolePermissionAssignments,
  migration0009AddInvitedUserStatus,
  migration0010CreateUserInvitations,
  migration0011CreateAuthenticationAuditEvents,
  migration0012CreateClients,
  migration0013CreateSubscriptions,
  migration0014CreateLicenses,
  migration0015CreateModules,
  migration0016CreateModuleEntitlements,
  migration0017CreateProperties,
  migration0018CreateBuildings,
  migration0019CreateUserBuildingAssignments,
  migration0020CreateOrganizations,
  migration0021CreateDepartments,
  migration0022CreateTeams,
  migration0023CreatePositions,
  migration0024CreateWorkforceProfiles,
  migration0025CreateSkills,
  migration0026CreateWorkforceSkillAssignments,
  migration0027CreateShifts,
  migration0028CreateWorkforceShiftAssignments,
  migration0029CreateWorkforceReportingLines,
  migration0030CreateWorkforceBuildingAssignments,
  migration0031AddExternalWorkforceType,
  migration0032CreateExternalOrganizations,
  migration0033CreateExternalWorkforceLinks,
  migration0034CreateFloors,
  migration0035CreateCampuses,
  migration0036AddBuildingCampusReference,
  migration0037CreateAreas,
  migration0038CreateRooms,
  migration0039CreateRoomTypes,
  migration0040AddRoomTypeReference,
  migration0041CreateSpaces,
  migration0042CreateFunctionalLocations,
  migration0043CreateAssets,
  migration0044CreateAssetCategories,
  migration0045CreateAssetTypes,
  migration0046AddAssetClassificationReference,
  migration0047AddAssetLocationBinding,
  migration0048CreateEquipmentProfiles,
  migration0049AddAssetLifecycleStatus,
  migration0050CreateAssetWarranties,
  migration0051CreateAssetCertifications,
  migration0052CreateAssetIdentifiers,
  migration0053CreateAssetHistoryEvents,
  migration0054CreateVendors,
  migration0055CreateVendorCategories,
  migration0056AddVendorCategoryReference,
  migration0057CreateVendorPics,
  migration0058CreateVendorBuildingRelationships,
  migration0059CreateVendorCapabilities,
  migration0060CreateVendorWorkforceBindings,
  migration0061CreateVendorComplianceDocuments,
  migration0062CreateVendorLicensesCertifications,
  migration0063CreateSourceForms,
  migration0064CreateFormTemplates,
  migration0065CreateFormSectionsFields,
  migration0066CreateFormTemplateVersions,
  migration0067CreateFormInstancesResponses,
  migration0068CreateFormConditionsRepeatables,
  migration0069CreateChecklistTemplates,
  migration0070CreateChecklistExecutions,
  migration0071CreateUomMeasurements,
  migration0072CreateEvidenceRequirements,
  migration0073CreateEvidenceSubmissions,
  migration0074CreateReviews,
  migration0075CreateScheduleDefinitions,
  migration0076CreateScheduleRecurrence,
  migration0077CreateTasks,
  migration0078CreateTaskAssignments,
  migration0079ExtendTaskExecution,
  migration0080CreateOperationalEvents,
  migration0081CreateWorkRequests,
  migration0082CreateWorkOrders,
  migration0083AddWorkOrderPriorityLifecycle,
  migration0084AddWorkOrderAssetLocation,
  migration0085CreateWorkOrderAssignments,
  migration0086CreateWorkOrderActions,
  migration0087AddWorkOrderEvidenceBinding,
  migration0088AddWorkOrderCompletion,
  migration0089AddWorkOrderVerification,
  migration0090CreateFindings,
  migration0091AddFindingClassificationSeverity,
  migration0092AddFindingSourceBinding,
  migration0093CreateFindingAssignments,
  migration0094ExtendFindingOperationalStates,
  migration0095AddFindingReviews,
  migration0096AddFindingReworkCycles,
  migration0097AddFindingClosure,
  migration0098CreateInspectionBindings,
  migration0099AddInspectionExecutionBinding,
  migration0100CreateMeterReadingBindings,
  migration0101AddMeterReadingExecutionBinding,
  migration0102CreateLogSheetBindings,
  migration0103AddLogSheetExecutionBinding,
  migration0104CreateEngineeringChecklistBindings,
  migration0105AddEngineeringChecklistExecutionBinding,
  migration0106CreateBreakdownBindings,
  migration0107CreateMaintenanceBindings,
  migration0108AddMaintenanceTaskBinding,
  migration0109CreateEngineeringFindingLinks,
  migration0110CreateShiftHandovers,
  migration0111CreateCleaningAreas,
  migration0112CreateCleaningScheduleBindings,
  migration0113CreateToiletInspectionBindings,
  migration0114CreatePublicAreaInspectionBindings,
  migration0115CreateSupervisorInspections,
  migration0116CreateHousekeepingFindingLinks,
  migration0117CreateConsumableReadiness,
  migration0118CreateQualityAudits,
  migration0119CreateHousekeepingComplaintBindings,
  migration0120CreateSecurityPosts,
  migration0121CreatePatrolRoutes,
  migration0122CreatePatrolRoutePoints,
  migration0123CreatePatrolScheduleBindings,
  migration0124CreatePatrolPointVisits,
  migration0125CreatePatrolChecklistBindings,
  migration0126AddPatrolChecklistExecutionBinding,
  migration0127CreateSecurityShiftHandoverBindings,
  migration0128CreateSecurityFindingLinks,
  migration0129CreateSecurityIncidentReadiness,
  migration0130CreateSecurityVisitorBindings,
  migration0131CreateSecurityKeysAndCustody,
  migration0132CreateSecurityLostAndFound,
  migration0133CreateVisitors,
  migration0134CreateVisitorInvitations,
  migration0135CreateExpectedVisitors,
  migration0136CreateWalkInVisits,
  migration0137CreateVisitorPhotos,
  migration0138CreateHostConfirmations,
  migration0139CreateVisitCheckIns,
  migration0140AddVisitCheckOut,
  migration0141CreateVisitorPasses,
  migration0142CreateContractorVisitors,
  migration0143CreateDeliveryCouriers,
  migration0144CreateTenantCompanies,
  migration0145CreateTenantPics,
  migration0146CreateTenantSpaceRelationships,
  migration0147CreateTenantBuildingContexts,
  migration0148CreateTenantServiceRequests,
  migration0149CreateTenantComplaints,
  migration0150CreateTenantUtilityRequests,
  migration0151CreateTenantApprovalBindings,
  migration0152CreateTenantContractorRelationships,
  migration0153CreateTenantDocuments,
  migration0154CreateTenantCommunications,
  migration0155CreateVendorAssignments,
  migration0156CreateVendorWorks,
  migration0157CreateVendorChecklistBindings,
  migration0158CreateWorkPermitReadiness,
  migration0159AddVendorWorkEvidenceBinding,
  migration0160CreateVendorCompletionReports,
  migration0161CreateVendorServiceReports,
  migration0162CreateVendorBastBindings,
  migration0163AddVendorWorkVerification,
  migration0164CreateVendorReworkCycles,
  migration0165AddVendorWorkHistory,
  migration0166CreateInventoryItems,
  migration0167CreateInventoryWarehouses,
  migration0168CreateInventoryStockBalances,
  migration0169CreateInventoryStockMovements,
  migration0170CreateInventoryStockTransfers,
  migration0171CreateInventoryStockAdjustments,
  migration0172CreateInventoryMinimumStocks,
  migration0173CreateInventoryAssetSpareParts,
  migration0174CreateInventoryWorkOrderMaterialUsages,
  migration0175CreateInventoryHousekeepingConsumableBindings,
  migration0176CreatePurchaseRequests,
  migration0177CreateMaterialRequests,
  migration0178CreateServiceRequests,
  migration0179CreateProcurementApprovalBindings,
  migration0180CreateVendorSelectionReadiness,
  migration0181CreatePurchaseOrderReadiness,
  migration0182CreateReceivings,
  migration0183CreateWorkOrderProcurementBindings,
  migration0184CreateUtilityMeters,
  migration0185CreateUtilityTypeConfigurations,
  migration0186CreateUtilityMeterHierarchies,
  migration0187CreateUtilityMeterTenantAssignments,
  migration0188CreateUtilityMeterReadings,
  migration0189AddMeterReadingEvidenceBinding,
  migration0190CreateUtilityMeterConsumptions,
  migration0191CreateUtilityCalculations,
  migration0192CreateUtilityAbnormalConsumptions,
  migration0193AddUtilityVerification,
  migration0194AddUtilityTenantApprovalBinding,
  migration0195CreateTenantCharges,
  migration0196CreateUtilityBills,
  migration0197CreateServiceChargeReadiness,
  migration0198CreateTenantInvoices,
  migration0199CreateInvoicePaymentStatus,
  migration0200CreatePaymentReceipts,
  migration0201CreateVendorServiceCosts,
  migration0202CreateBasicExpenses,
  migration0203CreatePermits,
  migration0204CreatePermitApplications,
  migration0205CreatePermitWorkContexts,
  migration0206CreatePermitSafetyRequirements,
  migration0207CreatePermitApprovalBindings,
  migration0208CreatePermitValidities,
  migration0209CreatePermitWorkers,
  migration0210CreatePermitEquipment,
  migration0211AddPermitEvidenceBinding,
  migration0212CreatePermitWorkLifecycles,
  migration0213RestoreReviewTargetUnion,
  migration0214CreateIncidents,
  migration0215CreateOperationalIncidents,
  migration0216CreateAssetFailureIncidents,
  migration0217CreateFindingEscalationIncidents,
  migration0218CreateImmediateActions,
  migration0219CreateCorrectiveActions,
  migration0220CreateCorrectiveActionResponsibilities,
  migration0221AddCorrectiveActionDueDate,
  migration0222AddCorrectiveActionVerification,
  migration0223AddIncidentClosure,
  migration0224CreateDocuments,
  migration0225CreateWorkCompletionDocuments,
  migration0226CreateBastDocuments,
  migration0227CreateHandoverDocuments,
  migration0228CreateAcceptanceSignOffs,
  migration0229CreateSupportingDocuments,
  migration0230CreateDocumentVersions,
  migration0231AddDocumentExpiry,
  migration0232AddDocumentApprovalTarget,
  migration0233AddDocumentArchive,
  migration0234CreateMobileSyncIdempotency,
  migration0235CreateMobilePushTokens,
  migration0236CreateMobileAppVersions,
  migration0237CreateNotifications,
  migration0238CreateNotificationTemplates,
  migration0239CreateNotificationEventSubscriptions,
  migration0240AddNotificationDeliveryColumns,
  migration0241CreateNotificationEmailDeliveries,
  migration0242CreateNotificationWhatsappDeliveries,
  migration0243CreateNotificationReminders,
  migration0244CreateNotificationEscalations,
  migration0245CreateNotificationSecureLinks,
  migration0246CreateClientConfigurations,
  migration0247CreateBuildingConfigurations,
  migration0248CreateModuleConfigurations,
  migration0249CreateFeatureEntitlementConfigurations,
  migration0250CreateNavigationRegistry,
  migration0251CreateWorkspaceRegistry,
  migration0252CreateDashboardWidgetConfigurations,
  migration0253CreateFormConfigurationBindings,
  migration0254CreateChecklistConfigurationBindings,
  migration0255CreateCmsContent,
  migration0256CreateConfigurationVersions,
  migration0257AddConfigurationLifecycle,
  migration0258CreateConfigurationPreviewContexts,
  migration0259EstablishCanonicalBastFoundation,
  migration0260AddCanonicalBastCommands,
  migration0261CreateVendorInvoices,
  migration0262AddVendorInvoiceVerification,
  migration0263AddVendorInvoicePaymentStatus,
  migration0264AddReceivingMaterialRequestBinding,
  migration0265AddMaterialRequestApprovedQuantity,
  migration0266AddOperationalUomSnapshots,
  migration0267AddWoMaterialUsageCost,
  migration0268AddWoMaterialUsageMovementLink,
  migration0269CreatePurchaseOrders,
  migration0270CreatePurchaseOrderLines,
  migration0271AddPurchaseOrderIssuance,
  migration0272CreateWorkContracts,
  migration0273AddWoProcurementSpkBinding,
  migration0274AddVendorInvoiceProcurementLinkage,
  migration0275CreateAttendanceRecords,
  migration0276CreateSecurityLogbookEntries,
  migration0277AddFindingEvidenceParents,
  migration0278AddUtilityTariffs,
  migration0279AddTenantUtilityBillingHandoff,
  migration0280CreateBuildingUtilityReconciliations,
  migration0281CreateUtilityReadingDuesOcr,
  migration0282CreateUtilityOperationalExceptions,
  migration0283CreateOperationalBudgetFoundation,
  migration0284CreateOperationalBudgetSourceBindings,
  migration0285AddOperationalBudgetName,
  migration0286AddCorrectiveActionReviewTarget,
  migration0287CreateInventoryMaterialReservations,
  migration0288AddMaterialRequestLinkToWoUsage,
  migration0289AddMaterialReservationConsumption,
  migration0290AddReservationLinkToWoUsage,
  migration0291CreateSlaDefinitions,
  migration0292CreateAppliedSlasAndClocks,
  migration0293CreateSlaClockPauseIntervals,
  migration0294AddSlaClockBreach,
  migration0295CreateSlaEscalationPolicies,
  migration0296CreateSlaEscalationLevels,
  migration0297CreateSlaEscalationActions,
  migration0298CreateNotificationOutboundDeliveries,
  migration0299AddNotificationDeliveryAttemptLinkage,
  migration0300WidenNotificationTemplateChannels,
  migration0301AddUserWhatsappContactConsent,
  migration0302AddOutboundDeliveryFeedback,
  migration0303AddEvidenceIntegrityMetadata,
  migration0304CreateEvidenceRetentionPolicies,
  migration0305AddEvidencePurgedAt,
  migration0306CreateIntegrationOutboxEvents,
  migration0307CreateIntegrationWebhookEndpoints,
  migration0308CreateIntegrationWebhookDeliveries,
  migration0309AddOperationalEventCorrelation,
  migration0310AddOperationalBudgetOverspendPolicy,
  migration0311CreateOperationalCommitments,
  migration0312CreateOperationalCommitmentEntries,
  migration0313CreateRfqs,
  migration0314CreateRfqVendorInvitationsAndSessions,
  migration0315CreateVendorQuotationsAndRevisionAttachments,
  migration0316CreateRfqComparisonsAndEvaluations,
  migration0317CreateRfqRecommendationsApprovalsAwards,
  migration0318CreateRfqAwardPoProvenance,
  migration0319CreatePriceCatalogEntries,
  migration0320AddRfqComparisonReferencePrice,
  migration0321CreateServiceCatalog,
  migration0322AddServiceRequestCatalogAnchor,
  migration0323AddVendorCapabilityServiceIdentity,
  migration0324AddServiceLineageIdentity,
  migration0325ActivateServiceReferencePrice,
  migration0326CreateEsgMetricDefinitions,
  migration0327CreateEsgWasteRecords,
  migration0328CreateEsgMetricValues,
  migration0329CreateEsgBaselinesTargetsVerification,
  migration0330CreateReportArchives,
  migration0331CreateCurrencyReferenceAndClientMonetaryContext,
  migration0332AddOperationalBillingCurrencySnapshots,
  migration0333CreateFxRateAuthorityAndClientFxPolicy,
  migration0334ExtendMobilePushTokensForDelivery,
  migration0335WidenOutboundDeliveryChannelsForPush,
  migration0336CreateNotificationPushDeliveries,
  migration0337AddSecurityPostToWorkforceShiftAssignments,
  migration0338BindChecklistExecutionToGeneratedTask,
  migration0339UniqueChecklistExecutionPerGeneratedTask,
  migration0340BindFormInstanceToGeneratedTask,
  migration0341CreateChecklistItemOptions,
  migration0342AddChecklistNaColumns,
  migration0343AddChecklistExecutionCompletedByUserId,
  migration0344AddChecklistExecutionAssignmentSnapshot,
  migration0345AddChecklistResponseLastRespondedByUserId,
  migration0346AddFormInstanceAttributionSnapshot,
  migration0347AddFormResponseLastRespondedByUserId,
  migration0348CreateHandymanRequests,
  migration0349CreateHandymanProviders,
  migration0350AddHandymanRequestGovernance,
  migration0351CreateHandymanQuotations,
  migration0352CreateHandymanQuotationApprovals,
  migration0353CreateHandymanWorkCrews,
  migration0354CreateHandymanJobs,
  migration0355CreateHandymanServiceVisits,
  migration0356CreateHandymanVisitArrivalsAndPresence,
  migration0357CreateHandymanWorkSessions,
  migration0358CreateHandymanMaterialDemands,
  migration0359IntegrateHandymanMaterialInventory,
  migration0360ExtendSupportingDocumentsForHandymanMaterial,
];
