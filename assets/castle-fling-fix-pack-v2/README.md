# Castle Fling Fix Pack

This pack contains the newly generated scenic background, modular castle upgrade sprites, and left-facing enemy/siege sprites prepared for game installation.

## Included
- 1 scenic gameplay background
- 8 individual castle upgrade sprites (transparent PNG)
- 12 individual enemy/siege sprites (transparent PNG)
- cleaned reference sheets
- `asset-manifest.json` with IDs, filenames, sizes, and recommended display heights

## Important install notes
1. **Enemy facing direction:** these enemies are already facing **left**, which is correct for units approaching the castle from the right side.
2. **Anchoring:** use **bottom-center** anchoring for all world sprites.
3. **Upgrade scaling:** do **not** paste upgrade sprites directly on top of the castle at arbitrary size. Use the `recommended_display_height` values from the manifest and place upgrades either:
   - on a wall socket / battlement attachment point, or
   - on a dedicated ground pad adjacent to the castle.
4. **Background use:** use `bg_battlefield_scenic_valley_v2.png` as the full gameplay backdrop. Avoid mixing it with flat placeholder mountain bands.

## Suggested folders inside your game
- `assets/backgrounds/`
- `assets/sprites/enemies/`
- `assets/sprites/upgrades/`

## Suggested next-step fixes in code
- flip/remove any legacy logic that mirrors enemy sprites
- normalize display heights from the manifest
- create castle attachment sockets for archer platform, crystal tower, fortified wall, bell tower, and shield generator
- create ground pads for mason workshop, bomb workshop, and gold vault
