You are updating the Castle Fling browser game.

Goal:
Install the new castle-integrated upgrade sprites and the new grabbing-hand cursor sprites.

New file provided:
- castle-fling-castle-upgrade-and-cursor-pack.zip

Install location:
Unzip into:
assets/castle-fling/upgrade-and-cursor/

Use this manifest as source of truth:
assets/castle-fling/upgrade-and-cursor/asset-manifest.json

Assets included:
1. upgrade_mage_tower_wall_attach
   file: sprites/upgrades/upgrade_mage_tower_wall_attach.png
   use: replacement for the current Mage Tower castle upgrade visual
   placement: attach to the castle upper-left hardpoint / roof-left socket
   notes: this should look built into the castle, not like a free-standing structure

2. upgrade_wall_forge_wall_attach
   file: sprites/upgrades/upgrade_wall_forge_wall_attach.png
   use: replacement for the current Wall Forge castle upgrade visual
   placement: attach to the castle upper-right hardpoint / wall-right socket
   notes: this should look built into the right wall/scaffold area, not like a ground building

3. cursor_hand_open
   file: sprites/cursor/cursor_hand_open.png
   use: default input cursor / grab hand open state

4. cursor_hand_closed
   file: sprites/cursor/cursor_hand_closed.png
   use: active grabbing cursor / closed hand state

Requirements:
- preserve aspect ratio for all sprites
- do not crop the sprites
- use bottom-center anchor for the two castle upgrade sprites
- use center anchor for the cursor hand sprites
- do not stretch images
- do not put the two upgrades on the ground

Castle upgrade integration:
- Replace the current Mage Tower art with `upgrade_mage_tower_wall_attach`.
- Replace the current Wall Forge art with `upgrade_wall_forge_wall_attach`.
- Keep them attached to the castle sockets.
- The mage tower should visually merge into the upper-left castle mass.
- The wall forge should visually merge into the upper-right wall/scaffold mass.
- If needed, draw part of the sprite behind the castle and part in front to help it blend.
- Do not place either upgrade in the center field or near the convert zone.

Cursor integration:
- Replace the current cursor/hand art with the new gauntlet sprites.
- When the player is idle or hovering, show `cursor_hand_open`.
- When the player grabs an enemy or object, switch to `cursor_hand_closed`.
- On release, revert to `cursor_hand_open`.
- Keep hotspot alignment stable between both states so the cursor does not jump.
- If needed, fine-tune cursor offset so the palm center aligns with the interaction point.
- Optional polish: add a subtle scale-up or glow on grab.

Suggested cursor logic:
- idle / hover: open hand
- grab active: closed hand
- mouseup / touchend / release: open hand

QA:
- Confirm both castle upgrades render fully and blend with the castle.
- Confirm neither upgrade looks like a detached sticker.
- Confirm the cursor swaps cleanly between open and closed states.
- Confirm the cursor does not jump when changing states.
- Confirm grabbing still works correctly.
- Confirm the new sprites display correctly on desktop and mobile.

Deliverable:
A clean updated build where the Mage Tower and Wall Forge upgrades look like part of the castle, and the player cursor uses the new open/closed gauntlet hand sprites.
