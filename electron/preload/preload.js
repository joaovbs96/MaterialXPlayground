// preload.js: context-isolated bridge between the main process and the
// site. Only sets the host flag for now; phase 4 adds the open/save API.
'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('__MTLX_ELECTRON__', true);
