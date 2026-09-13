// playwright.gpu.config.mjs: the embed suite on real GPU hardware.
// Chromium's new headless mode with ANGLE D3D11 renders on the actual
// adapter without opening a window; plain headless is SwiftShader and
// cannot validate shadow, transmission or HDR numerics.
//
// Usage: npx playwright test -c playwright.gpu.config.mjs tests/embed/<spec>
// Specs that require hardware assert the unmasked renderer themselves.

import base from './playwright.config.mjs';

export default {
  ...base,
  retries: 0,
  workers: 1,
  timeout: 240000,
  projects: base.projects.map((project) => ({
    ...project,
    name: `${project.name}-gpu`,
    use: {
      ...project.use,
      headless: false,
      launchOptions: {
        args: ['--headless=new', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
      },
    },
  })),
};
