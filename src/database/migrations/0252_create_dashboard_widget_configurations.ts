import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** BE-27G — scoped Dashboard/Widget composition metadata only. */
export const migration0252CreateDashboardWidgetConfigurations: Migration = {
  id: '0252_create_dashboard_widget_configurations',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE dashboards (
        id UUID PRIMARY KEY,
        scope_type TEXT NOT NULL,
        client_id UUID REFERENCES clients(id),
        building_id UUID REFERENCES buildings(id),
        dashboard_key TEXT NOT NULL,
        label TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT dashboards_scope_type_check CHECK(scope_type IN('CLIENT','BUILDING')),
        CONSTRAINT dashboards_scope_check CHECK(
          (scope_type='CLIENT' AND client_id IS NOT NULL AND building_id IS NULL)
          OR (scope_type='BUILDING' AND client_id IS NULL AND building_id IS NOT NULL)
        ),
        CONSTRAINT dashboards_key_check CHECK(dashboard_key ~ '^[A-Z][A-Z0-9_.-]*$' AND char_length(dashboard_key)<=100),
        CONSTRAINT dashboards_workspace_key_check CHECK(workspace_key ~ '^[A-Z][A-Z0-9_.-]*$' AND char_length(workspace_key)<=100)
      )
    `);
    await client.query(`
      CREATE TABLE dashboard_widgets (
        id UUID PRIMARY KEY,
        dashboard_id UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        widget_key TEXT NOT NULL,
        label TEXT NOT NULL,
        source_reference TEXT NOT NULL,
        display_order INTEGER NOT NULL DEFAULT 0,
        module_id UUID REFERENCES modules(id),
        feature_key TEXT,
        permission_id UUID REFERENCES permissions(id),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT dashboard_widgets_dashboard_key_unique UNIQUE(dashboard_id,widget_key),
        CONSTRAINT dashboard_widgets_key_check CHECK(widget_key ~ '^[A-Z][A-Z0-9_.-]*$' AND char_length(widget_key)<=100),
        CONSTRAINT dashboard_widgets_order_check CHECK(display_order>=0),
        CONSTRAINT dashboard_widgets_feature_check CHECK(feature_key IS NULL OR module_id IS NOT NULL),
        CONSTRAINT dashboard_widgets_feature_key_check CHECK(feature_key IS NULL OR (feature_key ~ '^[A-Z][A-Z0-9_.-]*$' AND char_length(feature_key)<=100))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX dashboards_client_key_unique ON dashboards(client_id,dashboard_key) WHERE scope_type='CLIENT';
      CREATE UNIQUE INDEX dashboards_building_key_unique ON dashboards(building_id,dashboard_key) WHERE scope_type='BUILDING';
      CREATE INDEX dashboards_workspace_idx ON dashboards(workspace_key);
      CREATE INDEX dashboard_widgets_order_idx ON dashboard_widgets(dashboard_id,display_order,widget_key);
      CREATE INDEX dashboard_widgets_module_feature_idx ON dashboard_widgets(module_id,feature_key)
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS dashboard_widgets');
    await client.query('DROP TABLE IF EXISTS dashboards');
  },
};
