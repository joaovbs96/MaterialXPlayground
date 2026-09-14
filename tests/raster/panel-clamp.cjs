/* CPU regression check for the material preview panel's clampPanelRect:
 * node tests/raster/panel-clamp.cjs
 * Pure geometry only, no DOM/browser needed. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.resolve(__dirname, '../../js/usd-scene-app.jsx'), 'utf8');
const begin = src.indexOf('const clampPanelRect = ');
assert(begin >= 0, 'clampPanelRect not found');
const end = src.indexOf('\n    };', begin) + '\n    };'.length;
assert(end > begin, 'no close for clampPanelRect');
const clampPanelRect = vm.runInNewContext(src.slice(begin, end) + '\nclampPanelRect;');

const bounds = { width: 800, height: 600 };

// Corner anchors: a normal-sized rect anchored at each corner stays inside.
const corners = [
  { x: -100, y: -100 }, { x: 780, y: -100 },
  { x: -100, y: 580 }, { x: 780, y: 580 },
];
corners.forEach((anchor) => {
  const rect = clampPanelRect({ x: anchor.x, y: anchor.y, width: 640, height: 420 }, bounds);
  assert(rect.x >= 0 && rect.y >= 0, 'clamped rect must not start before the bounds origin');
  assert(rect.x + rect.width <= bounds.width + 1e-9, 'clamped rect must not overflow the right edge');
  assert(rect.y + rect.height <= bounds.height + 1e-9, 'clamped rect must not overflow the bottom edge');
});

// A rect larger than the bounds: shrinks to fit and still sits at the origin.
const oversized = clampPanelRect({ x: 50, y: 50, width: 2000, height: 1500 }, bounds);
assert.equal(oversized.width, bounds.width, 'oversized rect must shrink to bounds width');
assert.equal(oversized.height, bounds.height, 'oversized rect must shrink to bounds height');
assert.equal(oversized.x, 0, 'oversized rect must pin to the left edge');
assert.equal(oversized.y, 0, 'oversized rect must pin to the top edge');

// A rect already inside the bounds is left untouched. Field-by-field
// (not deepEqual) because clampPanelRect runs in a separate vm realm,
// where cross-realm plain objects are never deepStrictEqual reference-wise.
const inside = clampPanelRect({ x: 20, y: 30, width: 300, height: 200 }, bounds);
assert.equal(inside.x, 20, 'an in-bounds rect must not move (x)');
assert.equal(inside.y, 30, 'an in-bounds rect must not move (y)');
assert.equal(inside.width, 300, 'an in-bounds rect must not move (width)');
assert.equal(inside.height, 200, 'an in-bounds rect must not move (height)');

console.log('clampPanelRect corner, oversized and in-bounds cases PASS');
