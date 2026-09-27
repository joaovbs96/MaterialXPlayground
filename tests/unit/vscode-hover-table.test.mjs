// Exercises nodeSignature.js's renderPortsMarkdown() (E12): a bulleted
// list per port, not a GFM pipe table (see that file for why). Covers
// escaping, whole descriptions, and the 14-row cap. Pure Node, no vscode.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nodeSignature = require('../../vscode_extension/src/nodeSignature.js');

test('renderPortsMarkdown: renders one bullet per port with type, default and description', () => {
  const table = {
    ports: {
      base: { type: 'float', default: '1.0', description: 'The base weight.' },
      base_color: { type: 'color3', default: '1, 1, 1', description: 'The base color.' },
    },
  };
  const md = nodeSignature.renderPortsMarkdown(table);
  assert.match(md, /- \*\*base\*\* `float` = 1\.0: The base weight\./);
  assert.match(md, /- \*\*base_color\*\* `color3` = 1, 1, 1: The base color\./);
});

test('renderPortsMarkdown: never emits a GFM pipe-table syntax line', () => {
  const table = { ports: { x: { type: 'float', default: '0', description: 'd' } } };
  const md = nodeSignature.renderPortsMarkdown(table);
  assert.doesNotMatch(md, /^\|/m, 'no line should start with a markdown table pipe');
  assert.doesNotMatch(md, /^\s*\|?\s*---/m, 'no markdown table separator row');
});

test('renderPortsMarkdown: a pipe in a description cannot fake a table/column boundary', () => {
  const table = { ports: { x: { type: 'float', description: 'a | b | c' } } };
  const md = nodeSignature.renderPortsMarkdown(table);
  assert.match(md, /a \| b \| c/, 'the pipe survives as plain text, unescaped-looking, since no table syntax is at risk');
  assert.doesNotMatch(md, /^\|/m);
});

test('renderPortsMarkdown: a newline in a description collapses into one bullet, not two', () => {
  const table = { ports: { x: { type: 'float', description: 'line one\nline two' } } };
  const md = nodeSignature.renderPortsMarkdown(table);
  const bulletLines = md.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(bulletLines.length, 1, 'the whole description must stay on one bullet line');
  assert.match(md, /line one line two/);
});

test('renderPortsMarkdown: backtick/asterisk in a value cannot break out of the bold/code spans', () => {
  const table = { ports: { x: { type: 'float`*evil', default: '1', description: 'desc' } } };
  const md = nodeSignature.renderPortsMarkdown(table);
  // Exactly the span markers this function itself emits should remain:
  // one pair of ** around the name and one pair of ` around the type.
  const bullet = md.split('\n').find((l) => l.startsWith('- **x**'));
  assert.ok(bullet);
  assert.equal((bullet.match(/`/g) || []).length, 2, 'only the type-code-span backticks survive');
  assert.match(bullet, /`floatevil`/);
});

test('renderPortsMarkdown: an underscore in a port name is kept literal, not stripped or escaped', () => {
  const table = { ports: { base_color: { type: 'color3', description: 'd' } } };
  const md = nodeSignature.renderPortsMarkdown(table);
  assert.match(md, /\*\*base_color\*\*/);
});

test('renderPortsMarkdown: descriptions are kept whole, never hard-wrapped into multiple lines', () => {
  const longDesc = 'word '.repeat(30).trim(); // well past any old fixed-width column cap
  const table = { ports: { x: { type: 'float', description: longDesc } } };
  const md = nodeSignature.renderPortsMarkdown(table);
  const bulletLines = md.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(bulletLines.length, 1);
});

test('renderPortsMarkdown: a type/default-less port renders a bare "name: description" bullet', () => {
  const table = { ports: { x: { description: 'just a description' } } };
  const md = nodeSignature.renderPortsMarkdown(table);
  assert.match(md, /- \*\*x\*\* - just a description/);
  assert.doesNotMatch(md, /``/);
});

test('renderPortsMarkdown: caps at 14 rows and appends a "more" note', () => {
  const ports = {};
  for (let i = 0; i < 20; i++) ports['p' + i] = { type: 'float', description: 'd' };
  const md = nodeSignature.renderPortsMarkdown({ ports });
  const bulletLines = md.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(bulletLines.length, 14);
  assert.match(md, /…and 6 more ports/);
});

test('renderPortsMarkdown: empty ports table renders nothing', () => {
  assert.equal(nodeSignature.renderPortsMarkdown({ ports: {} }), '');
  assert.equal(nodeSignature.renderPortsMarkdown(null), '');
});
