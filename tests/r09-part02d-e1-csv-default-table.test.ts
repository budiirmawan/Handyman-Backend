import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

/**
 * R09 PART 02D-E1 — CSV Default-Table Compatibility Foundation focused validation
 *
 * Static source assertions only. The foundation is intentionally validated
 * without a database or renderer dependency installation.
 */

const ROOT = process.cwd();
const TYPES_PATH = resolve(ROOT, 'src/modules/reporting-export/reporting-export.types.ts');
const CSV_PATH = resolve(ROOT, 'src/modules/reporting-export/csv-renderer.ts');
const PROJECTIONS_PATH = resolve(ROOT, 'src/modules/reporting-export/reporting-export.projections.ts');

const read = (path: string): string => readFileSync(path, 'utf8');
const types = read(TYPES_PATH);
const csv = read(CSV_PATH);
const projections = read(PROJECTIONS_PATH);

const selectStart = csv.indexOf('function selectTable(');
const selectEnd = csv.indexOf('\nfunction validateTableKey(', selectStart);
assert.ok(selectStart >= 0 && selectEnd > selectStart, 'selectTable helper must exist');
const selection = csv.slice(selectStart, selectEnd);

const opDetailStart = projections.indexOf('export function projectOperationalDetail(');
const opDetailColumnEnd = projections.indexOf('\n        source.rows.map', opDetailStart);
assert.ok(opDetailStart >= 0 && opDetailColumnEnd > opDetailStart, 'OPERATIONAL_DETAIL projection must exist');
const opDetailProjection = projections.slice(opDetailStart, opDetailColumnEnd);

const defaultDefinition = types.slice(
  types.indexOf('REPORTING_EXPORT_DATASET_METADATA'),
  types.indexOf('/** Column value types', types.indexOf('REPORTING_EXPORT_DATASET_METADATA')),
);

describe('R09 PART 02D-E1 — CSV Default-Table Compatibility Foundation', () => {
  it('01 preserves sole-table selection without tableKey', () => {
    assert.match(csv, /const table = selectTable\(snapshot, options\.tableKey\);/);
    assert.match(selection, /if \(snapshot\.tables\.length === 1\)/);
    assert.match(selection, /return snapshot\.tables\[0\]!;/);
  });

  it('02 defines optional dataset and export-snapshot csvDefaultTableKey metadata', () => {
    assert.match(types, /export type ReportingExportDatasetMetadata = \{[\s\S]*csvDefaultTableKey\?: string;/);
    assert.match(types, /filters:[\s\S]*csvDefaultTableKey\?: string;/);
    assert.match(defaultDefinition, /OPERATIONAL_DETAIL:[\s\S]*csvDefaultTableKey: 'operationalDetail'/);
  });

  it('03 gives explicit tableKey precedence over dataset defaults', () => {
    const explicitIndex = selection.indexOf('if (tableKey !== undefined)');
    const defaultIndex = selection.indexOf('const defaultTableKey');
    assert.ok(explicitIndex >= 0 && defaultIndex > explicitIndex);
    assert.match(selection.slice(explicitIndex, defaultIndex), /return table;/);
    assert.doesNotMatch(selection.slice(explicitIndex, defaultIndex), /defaultTableKey/);
  });

  it('04 preserves TABLE_NOT_FOUND for invalid explicit tableKey', () => {
    const explicitBlock = selection.slice(
      selection.indexOf('if (tableKey !== undefined)'),
      selection.indexOf('\n\n  const defaultTableKey'),
    );
    assert.match(explicitBlock, /if \(!table\)/);
    assert.match(explicitBlock, /new CsvRendererError\(/);
    assert.match(explicitBlock, /'TABLE_NOT_FOUND'/);
  });

  it('05 selects a configured default for multi-table snapshots', () => {
    assert.match(selection, /const defaultTableKey =\s+snapshot\.metadata\?\.csvDefaultTableKey/);
    assert.match(selection, /REPORTING_EXPORT_DATASET_METADATA\[snapshot\.metadata\.dataset\]/);
    assert.match(selection, /const defaultTable = snapshot\.tables\.find\(/);
    assert.match(selection, /if \(defaultTableKey !== undefined\)/);
    assert.match(selection, /return defaultTable;/);
  });

  it('06 keeps TABLE_SELECTION_REQUIRED when no default exists', () => {
    const genericBlock = selection.slice(selection.lastIndexOf('throw new CsvRendererError('));
    assert.match(genericBlock, /'TABLE_SELECTION_REQUIRED'/);
    assert.match(genericBlock, /A tableKey is required/);
  });

  it('07 fails closed when a configured default key is absent', () => {
    const defaultBlock = selection.slice(
      selection.indexOf('if (defaultTableKey !== undefined)'),
      selection.indexOf('\n\n  throw new CsvRendererError(', selection.indexOf('if (defaultTableKey !== undefined)')),
    );
    assert.match(defaultBlock, /if \(!defaultTable\)/);
    assert.match(defaultBlock, /new CsvRendererError\(/);
    assert.match(defaultBlock, /'TABLE_NOT_FOUND'/);
    assert.doesNotMatch(defaultBlock, /tables\[0\]/);
  });

  it('08 keeps OPERATIONAL_DETAIL single-table with its 50-column primary table', () => {
    assert.equal((opDetailProjection.match(/\{ key: '/g) ?? []).length, 50);
    assert.match(opDetailProjection, /table\(\s*'operationalDetail'/);
    assert.doesNotMatch(opDetailProjection, /operationalDetailAttribution/);
    assert.equal((opDetailProjection.match(/tables:\s*\[/g) ?? []).length, 1);
  });

  it('09 does not add a default to the existing workforce multi-table precedent', () => {
    assert.doesNotMatch(defaultDefinition, /WORKFORCE/);
    assert.doesNotMatch(defaultDefinition, /workforceByType|workforceMembers/);
  });

  it('10 preserves typed CSV errors and common renderer policy without archive branching', () => {
    assert.match(csv, /export class CsvRendererError extends Error/);
    assert.match(csv, /type CsvRendererErrorCode =/);
    assert.match(csv, /'TABLE_SELECTION_REQUIRED'/);
    assert.match(csv, /'TABLE_NOT_FOUND'/);
    assert.doesNotMatch(csv, /dataset\s*===\s*['"]OPERATIONAL_DETAIL['"]/);
    assert.doesNotMatch(csv, /operationalDetailAttribution/);
  });
});
