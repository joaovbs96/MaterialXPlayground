// gen-fixtures.mjs: standalone entry point that only generates fixtures,
// so generation can be kicked off (and progress-logged) independently of
// downloading/launching VS Code. run.mjs also calls generateFixtures()
// directly before it launches VS Code.
'use strict';

import { generateFixtures } from './lib/fixtures.mjs';

const fixturesDir = process.argv[2] || 'C:/Users/joaov/AppData/Local/Temp/mxpt-renders/stress-fixtures';
const started = Date.now();
generateFixtures(fixturesDir).then((info) => {
    console.log('[gen-fixtures] done in ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
    console.log('[gen-fixtures] manifest entries: ' + Object.keys(info.manifest).length);
}).catch((e) => {
    console.error('[gen-fixtures] FAILED', e);
    process.exit(1);
});
