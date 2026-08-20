You are updating the Castle Fling game build pipeline.

Goal:
Install the new Castle Fling app icon and prepare the game for two deliverables:
1. Windows portable EXE build
2. Android wrapper build

New file provided:
- castle-fling-app-icon-pack.zip

Install location:
Unzip into:
assets/build-branding/

Use this manifest as the source of truth:
assets/build-branding/asset-manifest.json

Included icon assets:
1. app_icon_1024
   file: icons/app_icon_1024.png
   use: master app icon for mobile/web/app stores and any resized outputs

2. app_icon_ico
   file: icons/app_icon.ico
   use: Windows EXE/app/shortcut icon

Important:
Do not change the gameplay in this task unless required for build stability.
This task is about build readiness, packaging, branding, and platform compatibility.

--------------------------------------------------
TASK 1 — INSTALL THE APP ICON
--------------------------------------------------

Use `app_icon_1024.png` as the primary source icon.
Use `app_icon.ico` for Windows executable icon packaging.

Apply icon usage in all relevant places:
- game window / Electron or desktop wrapper icon
- Windows EXE icon
- desktop shortcut icon
- Android app icon
- web manifest / PWA icon set if present
- splash branding references if applicable

Do not distort or crop the icon incorrectly.
Preserve aspect ratio when generating derived sizes.

Generate / wire up these sizes from the 1024 source if needed:
- 512x512
- 192x192
- 180x180
- 96x96
- 64x64
- 48x48
- 32x32

--------------------------------------------------
TASK 2 — PREP WINDOWS PORTABLE EXE BUILD
--------------------------------------------------

Prepare a Windows portable build.

Preferred outcome:
- a portable `.exe` build that can run on Windows without installer dependency
- all required runtime files bundled nearby
- icon correctly assigned to the EXE and window

If the project already uses Electron / Neutralino / Tauri / another wrapper:
- keep the existing wrapper stack
- update the build config to output a Windows portable build
- set the app name to `Castle Fling`
- set the product icon to `app_icon.ico`

For Electron-style setup, ensure:
- correct `productName`
- correct `appId`
- executable icon path set to `assets/build-branding/icons/app_icon.ico`
- portable target enabled if using electron-builder
- output folder is clearly named, e.g. `dist/windows-portable/`

If using Electron Builder, a portable target is preferred, e.g.:
- target: `portable`
- arch: `x64` at minimum

Make sure the Windows build:
- launches directly
- opens the game correctly
- uses the proper icon in the title bar/taskbar
- loads assets/audio correctly from packaged paths
- persists save data/settings safely
- works offline

Also verify:
- local file paths still resolve after packaging
- MP3 loop audio still works
- save/localStorage path behavior is stable
- no dev console errors on launch

--------------------------------------------------
TASK 3 — PREP ANDROID WRAPPER BUILD
--------------------------------------------------

Prepare an Android wrapper build around the game.

If an Android WebView wrapper already exists:
- keep that approach
- update the wrapper branding and icon
- ensure the latest game files are copied into the wrapper assets
- ensure app icon uses `app_icon_1024.png` as the source artwork

If the wrapper uses Android Studio / WebView:
- update launcher icons
- confirm app name is `Castle Fling`
- verify the start page points to the packaged game
- ensure landscape/portrait settings remain appropriate for the game
- keep touch input working
- keep audio working after user interaction

Android build requirements:
- wrapper launches directly into the game
- custom app icon applied
- game fits screen correctly
- touch grabbing/throwing works
- audio works after first interaction
- assets load from local packaged files
- no external server required
- back button behavior is sensible (pause/menu or confirm exit)
- no broken file paths

If adaptive icons are supported:
- use the 1024 icon as the foreground/base source and generate needed mipmap launcher assets

--------------------------------------------------
TASK 4 — GENERAL BUILD READINESS CLEANUP
--------------------------------------------------

Before packaging both builds, make sure the game is production-ready.

Checklist:
- remove or disable obvious dev-only logging if excessive
- remove broken asset references
- ensure all new asset packs are referenced correctly
- ensure app title is `Castle Fling`
- ensure the main loop music does not stack on restart
- ensure save data persists cleanly
- ensure no missing-image console errors
- ensure no missing-audio console errors
- ensure relative asset paths work in packaged environments
- ensure game-over, restart, and home flows still work

--------------------------------------------------
TASK 5 — OUTPUTS
--------------------------------------------------

Produce / prepare:
1. Windows portable EXE build configuration and packaged output
2. Android wrapper build configuration and APK-ready project/build
3. Icon integrated into both targets

If full packaged binaries cannot be produced in the current environment, still complete:
- the icon integration
- build config updates
- platform-specific wrapper/project updates
- exact commands/scripts needed to generate the Windows portable build and Android wrapper build locally

--------------------------------------------------
TASK 6 — QA CHECK
--------------------------------------------------

Test / verify:

Windows:
- app launches from portable EXE
- correct icon is shown
- gameplay loads
- audio works
- save data works
- no missing assets

Android:
- wrapper launches
- correct app icon is shown
- touch works
- audio works after interaction
- no broken layout
- no missing assets

Deliverable:
A Castle Fling build setup ready for Windows portable EXE and Android wrapper deployment, with the new app icon properly installed and all required build config updates in place.
