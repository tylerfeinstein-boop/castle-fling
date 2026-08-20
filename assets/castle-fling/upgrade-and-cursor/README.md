# Castle Fling Castle Upgrade + Cursor Pack

This pack contains 4 prepared transparent PNGs:
- 2 castle-integrated upgrade sprites
- 2 gauntlet cursor sprites (open + closed)

## Files
- `sprites/upgrades/upgrade_mage_tower_wall_attach.png`
- `sprites/upgrades/upgrade_wall_forge_wall_attach.png`
- `sprites/cursor/cursor_hand_open.png`
- `sprites/cursor/cursor_hand_closed.png`

## Integration notes
- The upgrade sprites are designed to look like they are **part of the castle**, not free-standing buildings.
- The mage tower should attach to the **upper-left castle structure**.
- The wall forge should attach to the **upper-right wall / scaffold hardpoint**.
- The open cursor sprite is the default hand state.
- The closed cursor sprite is shown while grabbing.

## Cursor behavior suggestion
- Show `cursor_hand_open` while hovering / idle.
- Swap to `cursor_hand_closed` on mousedown / touchstart when an enemy is grabbed.
- Revert to `cursor_hand_open` on mouseup / touchend / release.
- Optional: scale cursor hand by ~1.05 on active grab.
