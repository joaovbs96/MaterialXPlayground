#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const commit = "b050c3731d1854a5980b6b4fe55ec1725dc18f51";
const files = {
  "usdWebViewBindings.js": "1bd9d2349526e1fbb21a5f31ca2736efeeee04617c825e4e8f2c7094f9bcb6fc",
  "usdWebViewBindingsModule.js": "c6965098c59563c8023f4ba6771254fe98ee84cf2255594b8790973600768fce",
  "usdWebViewBindingsModule.wasm": "0f2f5f978655a7bfc0fe03c9ab2906f4bf9a97626d15384e5812296d3710f5de",
};
const root = new URL("../vendor/usd-webview-bindings/", import.meta.url);
const base = `https://raw.githubusercontent.com/usd-wg/usd-wg-webview/${commit}/public/usd-webview-bindings`;

await mkdir(root, { recursive: true });
for (const [name, expected] of Object.entries(files)) {
  const response = await fetch(`${base}/${name}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (expected && expected !== hash) throw new Error(`${name}: SHA-256 ${hash}, expected ${expected}`);
  await writeFile(new URL(name, root), bytes);
  console.log(`${name} ${bytes.byteLength} bytes sha256=${hash}`);
}
const licenseResponse = await fetch(`https://raw.githubusercontent.com/usd-wg/usd-wg-webview/${commit}/LICENSE`);
if (!licenseResponse.ok) throw new Error(`LICENSE: HTTP ${licenseResponse.status}`);
const license = new Uint8Array(await licenseResponse.arrayBuffer());
const licenseHash = createHash("sha256").update(license).digest("hex");
if (licenseHash !== "b70fc166eeff7a2dc9694fbdc8e7dc205d6f6ff86b4ae6972c074f631988dac8") {
  throw new Error(`LICENSE: SHA-256 ${licenseHash}`);
}
await writeFile(new URL("LICENSE", root), license);
console.log(`LICENSE ${license.byteLength} bytes sha256=${licenseHash}`);
