# Castle Fling Build Notes

## Branding

The app icon pack is installed at `assets/build-branding/`.

Source assets:

- `assets/build-branding/icons/app_icon_1024.png`: master app icon.
- `assets/build-branding/icons/app_icon.ico`: Windows executable and shortcut icon.

Generated PNG sizes:

- `app_icon_512.png`
- `app_icon_192.png`
- `app_icon_180.png`
- `app_icon_96.png`
- `app_icon_64.png`
- `app_icon_48.png`
- `app_icon_32.png`

## Windows Portable EXE

The Windows wrapper uses Electron with `electron-builder` portable output.

Commands:

```powershell
npm install
npm run build:windows
```

Expected output:

```text
dist/windows-portable/Castle Fling Portable 1.0.0.exe
```

Build config:

- Product name: `Castle Fling`
- App ID: `com.castlefling.game`
- Windows icon: `assets/build-branding/icons/app_icon.ico`
- Target: `portable`
- Arch: `x64`

## Android Wrapper

The Android wrapper is a native WebView project in `android/`.

Before building, sync the latest web files into the Android asset folder:

```powershell
npm run sync:android
```

Then open `android/` in Android Studio or run with a locally installed Android Gradle toolchain:

```powershell
cd android
gradle assembleRelease
```

The wrapper loads:

```text
file:///android_asset/www/index.html
```

Android branding:

- App label: `Castle Fling`
- Application ID: `com.castlefling.game`
- Orientation: `sensorLandscape`
- Launcher icon: generated from `app_icon_1024.png`

## Layout Target

The game keeps a fixed logical 16:9 battlefield (`1280x720`) and scales it into the available platform viewport without stretching. Non-16:9 windows/devices use clean letterboxing or pillarboxing while DOM UI uses safe-area-aware scaling and internal panel scrolling.
