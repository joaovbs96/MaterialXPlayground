// Loads every importer material document (tests/unit/fixtures/material-doc-cases.mjs)
// into the real MaterialX WASM, validates it and generates ESSL for its shader.
// Not in the unit suite (boots the WASM); run: node scripts/check-material-docs-wasm.mjs
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { materialDocCases, usdShadeCases } from "../tests/unit/fixtures/material-doc-cases.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = fs.readdirSync(path.join(root, "js", "materialx")).find((n) => /^\d/.test(n));
const dir = path.join(root, "js", "materialx", version);
const mod = await import(pathToFileURL(path.join(dir, "JsMaterialXGenShader.js")));
const mx = await mod.default({ locateFile: (p) => path.join(dir, p) });
const gen = mx.EsslShaderGenerator.create();
const ctx = new mx.GenContext(gen);
const stdlib = mx.loadStandardLibraries(ctx);
const msg = (e) => (typeof e === "number" ? mx.getExceptionMessage(e) : (e && e.message) || String(e));

let failures = 0;
for (const { label, xml } of materialDocCases().concat(await usdShadeCases())) {
  try {
    const doc = mx.createDocument();
    await mx.readFromXmlString(doc, xml);
    doc.setDataLibrary(stdlib);
    const result = doc.validate();
    const ok = Array.isArray(result) ? result[0] : (result && result.valid !== undefined ? result.valid : result);
    const text = Array.isArray(result) ? result[1] : (result && result.message) || "";
    if (ok === false) throw new Error("validate: " + text);
    const nodes = doc.getNodes();
    const list = Array.isArray(nodes) ? nodes : Array.from({ length: nodes.size() }, (_, i) => nodes.get(i));
    const shader = list.find((n) => n.getType() === "surfaceshader");
    if (!shader) throw new Error("no surfaceshader node");
    const out = gen.generate("probe", shader, ctx);
    if (!out.getSourceCode("pixel")) throw new Error("empty pixel stage");
  } catch (e) {
    failures += 1;
    console.error("FAIL " + label + ": " + msg(e));
  }
}
console.log(failures ? failures + " document(s) failed" : "all material documents validate and generate");
process.exit(failures ? 1 : 0);
