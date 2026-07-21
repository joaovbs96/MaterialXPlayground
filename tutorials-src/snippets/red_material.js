// Load the MaterialX WASM module (served from the SPA root, one dir up).
const MaterialX = (await import('../js/JsMaterialXGenShader.js')).default;
const mx = await MaterialX({ locateFile: (path) => '../js/' + path });

const doc = mx.createDocument();

const shader = doc.addNode('standard_surface', 'SR_red', 'surfaceshader');
shader.addInput('base', 'float').setValueString('1.0', 'float');
shader.addInput('base_color', 'color3').setValueString('0.8, 0.1, 0.1', 'color3');

const material = doc.addNode('surfacematerial', 'M_red', 'material');
material.addInput('surfaceshader', 'surfaceshader').setAttribute('nodename', 'SR_red');

console.log(mx.writeToXmlString(doc));
