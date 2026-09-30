// Fake emscripten-esm module: fetches locateFile('fake.data') like a real
// wasm module fetches its .wasm/.data, so the test can assert url() joins
// against the dep's own dir, not the module script's own location.
export default async function (opts) {
    const dataUrl = opts.locateFile('fake.data');
    const dataText = await (await fetch(dataUrl)).text();
    return { answer: 42, dataText, dataUrl };
}
