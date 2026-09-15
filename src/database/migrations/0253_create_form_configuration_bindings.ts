import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-27H — Client/Building bindings for the existing BE-07 Form Template.
 * Definitions remain in form_templates/form_sections/form_fields.
 */
export const migration0253CreateFormConfigurationBindings: Migration = {
  id: '0253_create_form_configuration_bindings',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE form_configuration_bindings (
        id UUID PRIMARY KEY,
        form_template_id UUID NOT NULL REFERENCES form_templates(id) ON DELETE CASCADE,
        scope_type TEXT NOT NULL,
        client_id UUID REFERENCES clients(id),
        building_id UUID REFERENCES buildings(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT form_configuration_bindings_scope_type_check CHECK(scope_type IN('CLIENT','BUILDING')),
        CONSTRAINT form_configuration_bindings_scope_check CHECK(
          (scope_type='CLIENT' AND client_id IS NOT NULL AND building_id IS NULL)
          OR (scope_type='BUILDING' AND client_id IS NULL AND building_id IS NOT NULL)
        )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX form_configuration_bindings_client_unique
        ON form_configuration_bindings(client_id,form_template_id) WHERE scope_type='CLIENT';
      CREATE UNIQUE INDEX form_configuration_bindings_building_unique
        ON form_configuration_bindings(building_id,form_template_id) WHERE scope_type='BUILDING';
      CREATE INDEX form_configuration_bindings_template_idx ON form_configuration_bindings(form_template_id)
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS form_configuration_bindings');
  },
};
