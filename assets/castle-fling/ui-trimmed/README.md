# ui-trimmed/

Pre-cropped copies of icons, buttons, and upgrade art for direct use in HTML `<img>` tags.

The originals (in `../ui/` and `../sprites/upgrades/`) were cropped from generated
source sheets and some carry partial "bleed" from neighboring sheet cells. These copies
are trimmed to the main subject via an alpha-channel scan. Canvas-rendered sprites do not
use these files — `game.js` crops the originals at draw time using the crop rects baked
into `SPRITE_DEFS`.

Do not edit these by hand; re-derive from the originals if the source art changes.

`fix_*.png` files are trimmed copies from `../../castle-fling-fix-pack/sprites/upgrades/`,
renamed by their actual visual content because several fix-pack files are mislabeled
(e.g. the pack's `upgrade_archer_platform.png` contains the crystal tower). The
authoritative content mapping lives in `SPRITE_DEFS` in game.js.
