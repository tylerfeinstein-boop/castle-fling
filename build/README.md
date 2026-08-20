# Castle Fling — packaged builds

Final artifacts land in `../dist/`:
- `CastleFling-Windows-x64.zip` — unzip anywhere, run `CastleFling.exe` (F11 = fullscreen)
- `CastleFling.apk` — debug-signed Android build (landscape), install via
  `adb install CastleFling.apk` or copy to the phone and open (allow unknown sources)

## Rebuilding

Everything generated is git-ignored; these are the steps to regenerate from the
game source in the repo root.

### 1. Stage the web bundle
Copy `index.html`, `style.css`, `game.js` and the runtime asset folders into
`build/web/` (see the copy list in the packaging session, or just copy the whole
`assets/` tree — source sheets merely add size).

### 2. Windows exe (Electron)
```
cd build/desktop
cp -r ../web app                # game payload
npm install
npx electron-packager . CastleFling --platform=win32 --arch=x64 --icon=app_icon.ico --out=out --overwrite
```
Output: `out/CastleFling-win32-x64/CastleFling.exe`

### 3. Android apk (Capacitor)
Requires Android Studio's SDK + bundled JBR (no separate Java needed):
```
cd build/mobile
cp -r ../web www
npm install
npx cap add android             # first time only
npx capacitor-assets generate --android --assetPath assets --iconBackgroundColor '#0f1a2e' --splashBackgroundColor '#0f1a2e'
npx cap sync android
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
cd android; .\gradlew.bat assembleDebug
```
Output: `android/app/build/outputs/apk/debug/app-debug.apk`

Notes:
- `android/app/src/main/AndroidManifest.xml` carries `screenOrientation="sensorLandscape"` — re-apply after regenerating the platform.
- The APK is debug-signed. For a Play Store release you need a proper keystore and `assembleRelease`.
- App icon source: `desktop/app_icon.ico` and `mobile/assets/logo.png` (from the castle-fling-app-icon-pack).
