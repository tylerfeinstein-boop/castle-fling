# Castle Fling

A physics-flinging castle defence game. You grab enemy soldiers with a giant hand,
fling them, and convert them into defenders while upgrading a kingdom between runs.
Ships as a browser build, a Windows portable EXE and an Android app.

**▶ [Play it on Google Play](https://play.google.com/store/apps/details?id=com.emptyhelmetgames.castlefling)**
· `com.emptyhelmetgames.castlefling` · Empty Helmet Games

## Status

**Released.** Live on Google Play in general availability — through closed
testing, open testing and full production review.

## Technology

- Vanilla JavaScript game running on a fixed 16:9 logical battlefield (1280x720)
- Electron + electron-builder for the Windows portable build
- **Capacitor Android app** in `build/mobile/android/` — the one that ships,
  with three hand-written Java sources: a Google Mobile Ads plugin, a Play
  Billing plugin, and a WebView host that survives renderer crashes
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
| `build/mobile/android/` | **The shipped Capacitor app** — manifest, icons, custom Java plugins |
| `android/` | An earlier native WebView wrapper (`com.castlefling.game`) — superseded, kept for reference |
| `electron/` | Electron main process |
| `scripts/` | Asset build, validation and QA tooling |
| `docs/` | Asset manifest, terms page |
| `.agents/skills/` | Higgsfield agent skills (source of truth) |
| `.claude/skills/` | Junctions to `.agents/skills` — not tracked |

## Notes

- `dist/`, `revert-backup/` and the generated web mirrors are git-ignored;
  `build/README.md` documents how to regenerate them. **`build/mobile/android/`
  is the exception** — despite living under `build/`, it is not generated. It
  was ignored wholesale until now, which meant the source of the shipped app
  was not under version control. Only its Gradle output, `local.properties`
  and signing credentials are ignored.
- The Play Store **release keystore lives outside this repo** and must never be
  committed. Losing it means the Play listing can never be updated again.
- Large audio and video assets (~35 MB) are tracked directly. Git LFS is
  configured for new commits; existing history was not migrated.
