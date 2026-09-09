; Adds Windows Explorer right-click verbs for .mtlx files.
; electron-builder does not expose the generated ProgID as a template
; variable, so this must match fileAssociations[0].name in package.json.
!define MTLX_PROGID "MaterialX Document"
; Registry key name for the cascading submenu, distinct from the ProgID's
; own "open" verb (electron-builder's double-click default action).
!define MTLX_CASCADE_KEY "MaterialXPlaygroundCascade"

!macro customInstall
  ; Cleans up the old flat verb from a previously installed build: the
  ; cascade below replaces it, so an upgrade must not leave it orphaned.
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${MTLX_PROGID}\shell\OpenWithMaterialXPlayground"

  ; Cascading "MaterialX Playground" submenu, same shape as 7-Zip's own
  ; context menu entry: a parent verb carrying MUIVerb + an empty
  ; SubCommands value, and a nested shell key holding the child verbs.
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MTLX_PROGID}\shell\${MTLX_CASCADE_KEY}" "MUIVerb" "MaterialX Playground"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MTLX_PROGID}\shell\${MTLX_CASCADE_KEY}" "SubCommands" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MTLX_PROGID}\shell\${MTLX_CASCADE_KEY}" "Icon" `"$appExe",0`

  WriteRegStr SHELL_CONTEXT "Software\Classes\${MTLX_PROGID}\shell\${MTLX_CASCADE_KEY}\shell\01Viewer" "MUIVerb" "Open in Viewer"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MTLX_PROGID}\shell\${MTLX_CASCADE_KEY}\shell\01Viewer\command" "" `"$appExe" --mtlx-route=viewer "%1"`

  WriteRegStr SHELL_CONTEXT "Software\Classes\${MTLX_PROGID}\shell\${MTLX_CASCADE_KEY}\shell\02GraphEditor" "MUIVerb" "Open in Graph Editor"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MTLX_PROGID}\shell\${MTLX_CASCADE_KEY}\shell\02GraphEditor\command" "" `"$appExe" --mtlx-route=graph "%1"`

  WriteRegStr SHELL_CONTEXT "Software\Classes\${MTLX_PROGID}\shell\${MTLX_CASCADE_KEY}\shell\03Compare" "MUIVerb" "Open in Compare"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MTLX_PROGID}\shell\${MTLX_CASCADE_KEY}\shell\03Compare\command" "" `"$appExe" --mtlx-route=compare "%1"`
!macroend

!macro customUnInstall
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${MTLX_PROGID}\shell\OpenWithMaterialXPlayground"
  ; DeleteRegKey removes the whole cascade in one call: the parent verb
  ; key plus its nested shell key and every child verb/command under it.
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${MTLX_PROGID}\shell\${MTLX_CASCADE_KEY}"
!macroend
