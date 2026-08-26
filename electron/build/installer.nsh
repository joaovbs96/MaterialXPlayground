; Adds a Windows Explorer right-click verb for .mtlx files.
; electron-builder does not expose the generated ProgID as a template
; variable, so this must match fileAssociations[0].name in package.json.
!define MTLX_PROGID "MaterialX Document"

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MTLX_PROGID}\shell\OpenWithMaterialXPlayground" "" "Open on MaterialX Playground"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MTLX_PROGID}\shell\OpenWithMaterialXPlayground\command" "" `"$appExe" "%1"`
!macroend

!macro customUnInstall
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${MTLX_PROGID}\shell\OpenWithMaterialXPlayground"
!macroend
