import MaterialX as mx

doc = mx.createDocument()

shader = doc.addNode('standard_surface', 'SR_red', 'surfaceshader')
shader.setInputValue('base', 1.0)
shader.setInputValue('base_color', mx.Color3(0.8, 0.1, 0.1))

material = doc.addNode('surfacematerial', 'M_red', 'material')
material.setConnectedNode('surfaceshader', shader)

print(mx.writeToXmlString(doc))
