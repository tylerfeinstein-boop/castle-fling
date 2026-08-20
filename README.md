# Castle Fling

A physics-flinging castle defence game. You grab enemy soldiers with a giant hand,
fling them, and convert them into defenders while upgrading a kingdom between runs.
Ships as a browser build, a Windows portable EXE and an Android app
(`com.castlefling.game`, currently in Play Store closed testing).

## Status

Active — in closed testing on Google Play.

## Technology

- Vanilla JavaScript game running on a fixed 16:9 logical battlefield (1280x720)
- Electron + electron-builder for the Windows portable build
- Native Android WebView wrapper in `android/` (Gradle)
- Node.js scripts for asset generation and validation

## Development

```bash
npm install
npm start                  # run the Electron shell
```

Build targets:

```bash
npm run build:windows      # -> dist/windows-portable/
npm run sync:android       # mirror web files into android/app/src/main/assets/www
npm run build:android      # sync, then gradle assembleRelease in android/
npm run validate:ricochet  # asset manifest check, runs before each build
```

See [BUILD.md](BUILD.md) for icon pipeline, build config and layout details.

## Repository Structure

| Path | Contents |
|---|---|
| `game.js`, `ricochet.js`, `daily.js`, `tutorial.js` | Game logic |
| `index.html`, `style.css`, `platform.js` | Shell and platform abstraction |
| `assets/` | Art, audio and sprite packs (tracked) |
| `android/` | Native Android WebView wrapper |
| `electron/` | Electron main process |
| `scripts/` | Asset build, validation and QA tooling |
| `docs/` | Asset manifest, terms page |
| `.agents/skills/` | Higgsfield agent skills (source of truth) |
| `.claude/skills/` | Junctions to `.agents/skills` — not tracked |

## Notes

- `dist/`, `build/`, `revert-backup/` and `android/app/src/main/assets/www/` are
  generated and git-ignored. `build/README.md` documents how to regenerate them.
- The Play Store **release keystore lives outside this repo** and must never be
  committed. Losing it means the Play listing can never be updated again.
- Large audio and video assets (~35 MB) are tracked directly; consider Git LFS
  before pushing this repo to a remote.
