import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-07 RUN 3 — extend the supporting-documents parent taxonomy for
 * CR07 material operations evidence (0352 idiom: drop + re-add the CHECK).
 *
 * New parents: HANDYMAN_MATERIAL_DEMAND, HANDYMAN_MATERIAL_ADDENDUM,
 * HANDYMAN_MATERIAL_APPROVAL, HANDYMAN_MATERIAL_ISSUE,
 * HANDYMAN_MATERIAL_USAGE, HANDYMAN_MATERIAL_RETURN.
 *
 * Evidence attaches through the EXISTING document foundation — no new
 * document engine, file-reference only. Attaching evidence never approves,
 * reserves, issues, uses, returns, or mutates commercial state; those stay
 * Run-1/Run-2 owned.
 */
export const migration0360ExtendSupportingDocumentsForHandymanMaterial: Migration = {
  id: '0360_extend_supporting_documents_for_handyman_material',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE supporting_documents
        DROP CONSTRAINT supporting_documents_parent_check
    `);
    await client.query(`
      ALTER TABLE supporting_documents
        ADD CONSTRAINT supporting_documents_parent_check
          CHECK (parent_type IN (
            'WORK_COMPLETION', 'BAST', 'HANDOVER', 'SIGN_OFF',
            'TENANT_COMPANY', 'VENDOR', 'DOCUMENT', 'RFQ',
            'QUOTATION_REVISION', 'HANDYMAN_QUOTATION_APPROVAL',
            'HANDYMAN_MATERIAL_DEMAND', 'HANDYMAN_MATERIAL_ADDENDUM',
            'HANDYMAN_MATERIAL_APPROVAL', 'HANDYMAN_MATERIAL_ISSUE',
            'HANDYMAN_MATERIAL_USAGE', 'HANDYMAN_MATERIAL_RETURN'
          ))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DELETE FROM supporting_documents
       WHERE parent_type IN (
         'HANDYMAN_MATERIAL_DEMAND', 'HANDYMAN_MATERIAL_ADDENDUM',
         'HANDYMAN_MATERIAL_APPROVAL', 'HANDYMAN_MATERIAL_ISSUE',
         'HANDYMAN_MATERIAL_USAGE', 'HANDYMAN_MATERIAL_RETURN'
       )
    `);
    await client.query(`
      ALTER TABLE supporting_documents
        DROP CONSTRAINT IF EXISTS supporting_documents_parent_check
    `);
    await client.query(`
      ALTER TABLE supporting_documents
        ADD CONSTRAINT supporting_documents_parent_check
          CHECK (parent_type IN (
            'WORK_COMPLETION', 'BAST', 'HANDOVER', 'SIGN_OFF',
            'TENANT_COMPANY', 'VENDOR', 'DOCUMENT', 'RFQ',
            'QUOTATION_REVISION', 'HANDYMAN_QUOTATION_APPROVAL'
          ))
    `);
  },
};
