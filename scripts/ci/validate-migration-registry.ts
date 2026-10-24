import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { migrations } from '../../src/database/migrations';

async function main(): Promise<void> {
  const directory = path.resolve(process.cwd(), 'src/database/migrations');
  const files = (await readdir(directory))
    .filter((file) => /^\d{4}_.+\.ts$/.test(file))
    .sort();
  const fileIds = files.map((file) => file.slice(0, -3));
  const registryIds = migrations.map((migration) => migration.id);

  assert.ok(files.length > 0, 'No migration files found');
  assert.equal(
    new Set(fileIds.map((id) => id.slice(0, 4))).size,
    fileIds.length,
    'Duplicate migration file number',
  );
  assert.equal(
    new Set(registryIds.map((id) => id.slice(0, 4))).size,
    registryIds.length,
    'Duplicate registry migration number',
  );
  assert.equal(
    new Set(registryIds).size,
    registryIds.length,
    'Duplicate registry migration id',
  );
  assert.deepEqual(
    [...registryIds].sort(),
    [...fileIds].sort(),
    'Migration files and canonical registry entries differ',
  );

  registryIds.forEach((id, index) => {
    assert.match(id, /^\d{4}_[a-z0-9_]+$/, `Invalid migration id: ${id}`);
    if (index > 0) {
      assert.ok(
        Number(id.slice(0, 4)) > Number(registryIds[index - 1]!.slice(0, 4)),
        `Registry is not in strict numeric append order at ${id}`,
      );
    }
    const migration = migrations[index]!;
    assert.equal(typeof migration.up, 'function', `${id} has no up function`);
    assert.equal(typeof migration.down, 'function', `${id} has no down function`);
  });

  console.log(
    `MIGRATION_REGISTRY_PASS | FILES=${files.length} REGISTRY=${registryIds.length} ` +
    `UNIQUE_IDS=${new Set(registryIds).size} HEAD=${registryIds.at(-1)}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
