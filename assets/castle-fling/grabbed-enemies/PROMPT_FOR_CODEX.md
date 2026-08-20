You are updating the Castle Fling browser game.

Goal:
Install the new grabbed/scared enemy sprite pack. When the player picks up an enemy, the enemy should visually switch to a scared grabbed-state sprite. Siege weapons should use their neutral grabbed-state sprites and should not have facial expressions.

New file provided:
- castle-fling-scared-enemy-grabbed-pack.zip

Install location:
Unzip into:
assets/castle-fling/grabbed-enemies/

Use this manifest as the source of truth:
assets/castle-fling/grabbed-enemies/asset-manifest.json

Important:
This is an asset integration pass. Do not rewrite the whole game. Do not break enemy spawning, movement, grab/throw physics, enemy animations, castle damage, upgrades, music, UI, or progression.

--------------------------------------------------
TASK 1 — INSTALL THE ASSET PACK
--------------------------------------------------

Unzip:
castle-fling-scared-enemy-grabbed-pack.zip

Into:
assets/castle-fling/grabbed-enemies/

Expected structure:
assets/castle-fling/grabbed-enemies/
  asset-manifest.json
  README.md
  PROMPT_FOR_CODEX.md
  sprites/enemies_grabbed/
  reference_sheets/
  previews/

Load these assets through the existing asset loader or add them to the current asset registry. Keep paths centralized.

--------------------------------------------------
TASK 2 — USE EXACT ENEMY MAPPING
--------------------------------------------------

Use this exact mapping while an enemy is actively grabbed/held:

Normal enemy -> grabbed-state sprite
- enemy_runner -> enemy_runner_scared
- enemy_soldier -> enemy_soldier_scared
- enemy_shieldbearer -> enemy_shieldbearer_scared
- enemy_hammer_brute -> enemy_hammer_brute_scared
- enemy_bomb_carrier -> enemy_bomb_carrier_scared
- enemy_healer -> enemy_healer_scared
- enemy_banner_carrier -> enemy_banner_carrier_scared
- enemy_heavy_knight -> enemy_heavy_knight_scared
- enemy_wall_climber -> enemy_wall_climber_scared
- enemy_siege_captain -> enemy_siege_captain_scared
- enemy_bomb_cart -> enemy_bomb_cart_grabbed
- enemy_twin_ram -> enemy_twin_ram_grabbed

The last two are siege weapons and intentionally do not have scared faces.

--------------------------------------------------
TASK 3 — GRABBED STATE RENDERING
--------------------------------------------------

When the player grabs an enemy:
- swap that enemy's visual sprite to the matching grabbed/scared sprite
- keep the same hitbox unless the current system requires minor visual-only offset adjustment
- keep the same bottom-center anchor
- keep the same display-height scaling as the normal enemy
- preserve aspect ratio
- do not stretch
- do not crop
- do not flip unless the base enemy logic already requires it for direction

When the enemy is released/thrown:
- return to the normal enemy sprite after release, OR keep the grabbed sprite only until the throw impact animation ends if that feels better with the current animation system
- do not permanently replace the normal enemy sprite during walking/attacking

Important:
These grabbed sprites are for the held state only. Walking enemies should continue using the normal left-facing enemy sprites.

--------------------------------------------------
TASK 4 — INTEGRATE WITH EXISTING GRAB LOGIC
--------------------------------------------------

Find the existing grab state in the code, such as:
- grabbedEnemy
- enemy.isGrabbed
- enemy.dragging
- heldEnemy
- input.isDraggingEnemy

Use that state to decide which sprite to render.

Example logic:

const grabbedSpriteMap = {
  enemy_runner: "enemy_runner_scared",
  enemy_soldier: "enemy_soldier_scared",
  enemy_shieldbearer: "enemy_shieldbearer_scared",
  enemy_hammer_brute: "enemy_hammer_brute_scared",
  enemy_bomb_carrier: "enemy_bomb_carrier_scared",
  enemy_healer: "enemy_healer_scared",
  enemy_banner_carrier: "enemy_banner_carrier_scared",
  enemy_heavy_knight: "enemy_heavy_knight_scared",
  enemy_wall_climber: "enemy_wall_climber_scared",
  enemy_siege_captain: "enemy_siege_captain_scared",
  enemy_bomb_cart: "enemy_bomb_cart_grabbed",
  enemy_twin_ram: "enemy_twin_ram_grabbed"
};

function getEnemySpriteId(enemy) {
  if (enemy.isGrabbed || enemy === grabbedEnemy) {
    return grabbedSpriteMap[enemy.type] || enemy.spriteId;
  }
  return enemy.spriteId;
}

Adjust names to match the existing code style.

--------------------------------------------------
TASK 5 — ANIMATION COMPATIBILITY
--------------------------------------------------

If procedural enemy animations already exist:
- keep grabbed-state transform behavior
- use the grabbed sprite while held
- disable walking/attacking bob while grabbed
- still allow held enemies to rotate or sway slightly if the game already does that
- keep thrown spin/rotation after release if already implemented
- keep hit flash and impact particles working

Do not let the sprite swap break:
- throw velocity
- hit detection
- collision damage
- enemy health
- death animation
- attack cooldowns

--------------------------------------------------
TASK 6 — CURSOR/HAND COMPATIBILITY
--------------------------------------------------

The player cursor may already use open/closed gauntlet hand sprites.

Requirements:
- when the cursor hand is closed and holding an enemy, the enemy should use the grabbed/scared sprite
- do not draw an extra giant human finger or hand from the sprite sheet
- do not use the older grabbed sheet with fingers
- the enemy should visually look scared because it is being held by the player cursor

--------------------------------------------------
TASK 7 — QA CHECK
--------------------------------------------------

Test the following:
- Start game.
- Grab each humanoid enemy type.
- Confirm the enemy changes to its scared grabbed-state sprite.
- Release the enemy.
- Confirm it returns to normal or transitions cleanly into throw animation.
- Grab Bomb Cart.
- Confirm it uses `enemy_bomb_cart_grabbed` and does not show a face.
- Grab Twin Ram.
- Confirm it uses `enemy_twin_ram_grabbed` and does not show a face.
- Confirm no giant fingers appear in-game.
- Confirm no sprite is cropped, stretched, floating, or badly scaled.
- Confirm hitboxes and throwing still work.
- Confirm mobile/touch grabbing still works.
- Confirm no missing image path errors in the console.

Deliverable:
A clean updated build where enemies visually switch to the new grabbed/scared sprites when picked up, siege weapons use neutral grabbed-state sprites, and all existing gameplay remains intact.
