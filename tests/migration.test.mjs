import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('SQLite conversion: precision, unchanged backup, large imports, idempotency, completion and fixed slots', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', [new URL('./test_migration.py', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
