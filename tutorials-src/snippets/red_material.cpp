#include <MaterialXCore/Document.h>
#include <MaterialXFormat/XmlIo.h>
namespace mx = MaterialX;

mx::DocumentPtr doc = mx::createDocument();

mx::NodePtr shader = doc->addNode("standard_surface", "SR_red", "surfaceshader");
shader->setInputValue("base", 1.0f);
shader->setInputValue("base_color", mx::Color3(0.8f, 0.1f, 0.1f));

mx::NodePtr material = doc->addNode("surfacematerial", "M_red", "material");
material->setConnectedNode("surfaceshader", shader);

std::string xml = mx::writeToXmlString(doc);
