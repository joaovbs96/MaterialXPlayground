// Unit coverage for js/shell.jsx staleCrashAction. The file is JSX-only, so
// the pure function is extracted by source text and evaluated in isolation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, '../../js/shell.jsx'), 'utf8');
const start = src.indexOf('function staleCrashAction(');
assert.ok(start >= 0, 'staleCrashAction not found in shell.jsx');
const end = src.indexOf('\n}\n', start) + 2;
const staleCrashAction = new Function(`${src.slice(start, end)}; return staleCrashAction;`)();

test('matching ids or failed probe keep the crash screen', () => {
  assert.equal(staleCrashAction({ stale: false, serverId: 'a' }, null), 'none');
  assert.equal(staleCrashAction(null, null), 'none');
  assert.equal(staleCrashAction({ stale: true }, null), 'none');
});

test('a new build reloads once, then prompts', () => {
  assert.equal(staleCrashAction({ stale: true, serverId: 'b' }, null), 'reload');
  assert.equal(staleCrashAction({ stale: true, serverId: 'b' }, 'a'), 'reload');
  assert.equal(staleCrashAction({ stale: true, serverId: 'b' }, 'b'), 'prompt');
});
