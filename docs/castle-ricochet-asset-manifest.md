# Castle Ricochet — production asset manifest

Source of truth for every sprite the mode loads at runtime. All paths are
relative to `assets/castle_ricochet/` and are requested with the
`?rv=<RICO_ASSET_VERSION>` cache-buster (see `ricochet.js`, currently **3** —
bump it with ANY sprite re-export). Only these individual production PNGs are
ever loaded: no sprite sheets, contact sheets, previews, reference sheets or
composites exist in the runtime tree, and
`scripts/validate-ricochet-assets.js` (run automatically by
`npm run build:windows` / `npm run sync:android`) fails the build if one
appears or if any sprite loses true-RGBA transparency.

## Board

| Runtime path | Use |
| --- | --- |
| `backgrounds/castle_ricochet_board_01.png` | full board art (pits are painted in; intentionally opaque RGB) |
| `maps/castle_ricochet_board_01.json` | design reference only — the map is embedded in `ricochet.js` (Android `file://` cannot fetch JSON); excluded from builds |

## Tokens (`tokens/standardized_384/`, 384×384 transparent canvas, drawn ~78 px)

| Runtime path | Token |
| --- | --- |
| `token_player_royal_striker.png` | Royal Striker (player) |
| `token_enemy_runner.png` | Runner |
| `token_enemy_wall_climber.png` | Wall Climber |
| `token_enemy_soldier.png` | Soldier |
| `token_enemy_bomb_carrier.png` | Bomb Carrier |
| `token_enemy_healer.png` | Healer |
| `token_enemy_banner_carrier.png` | Banner Carrier |
| `token_enemy_shield_bearer.png` | Shield Bearer |
| `token_enemy_hammer_brute.png` | Hammer Brute |
| `token_enemy_heavy_knight.png` | Heavy Knight |
| `token_enemy_siege_captain.png` | Siege Captain |
| `token_enemy_bomb_cart.png` | Bomb Cart |

All tokens share one gameplay disc diameter; the circular physics collider
(`TOKEN_RADIUS`) aligns with the visible disc, not the full canvas.

## Obstacles (`obstacles/`, three-quarter top-down, bottom-anchored on their footprint)

`obstacle_stone_wall_long_banner.png`, `obstacle_stone_wall_medium_banner.png`,
`obstacle_stone_wall_short_banner.png`, `obstacle_stone_wall_low_long.png`,
`obstacle_stone_wall_corner_left.png`, `obstacle_stone_wall_corner_right.png`,
`obstacle_pillar_large.png`, `obstacle_pillar_small.png`,
`obstacle_stone_block_square.png`, `obstacle_stone_block_l_low.png`,
`obstacle_stone_block_l_tall.png`, `obstacle_stone_block_l_small.png`,
`obstacle_wood_wall_straight.png`, `obstacle_wood_bumper_left.png`,
`obstacle_wood_bumper_right.png`, `obstacle_reinforced_stone_bumper.png`,
`obstacle_crate_single.png`, `obstacle_crates_stack_pyramid.png`,
`obstacle_crates_stack_offset.png`, `obstacle_bomb_barrel_single.png`,
`obstacle_bomb_barrels_pair.png`, `obstacle_bomb_barrels_stack.png`,
`obstacle_spike_barricade_small.png`, `obstacle_spike_barricade_large.png`

No pit sprites exist — pits are part of the board painting.

Obstacles carry **no baked ground shadow**: the packs shipped with a
white-matted gray shadow skirt that rendered lighter than the dark board, so
the skirt was stripped (2026-07-22, second pass) and obstacles sit directly on
the painted floor. The spike barricades' between-plank gaps are intentional
see-through openings.

## Aim pack (`aim/`, professional arrow pack — modular assembly only)

- `aim/modular/<mode>/aim_<mode>_start_cap.png` — fixed star cap
- `aim/modular/<mode>/aim_<mode>_shaft_tile.png` — the ONLY stretched piece
- `aim/modular/<mode>/aim_<mode>_arrow_head.png` — fixed head
  for modes `primary_gold`, `enemy_output`, `striker_deflection`,
  `sink_safe`, `danger`
- `aim/markers/aim_contact_enemy.png`, `aim_contact_wall.png`,
  `aim_contact_pillar.png`, `aim_ricochet_joint.png`, `aim_sink_target.png`,
  `aim_danger_target.png`
- `aim/power/aim_<mode>_power_glow_<1|2|3>.png` for modes `primary_gold`,
  `sink_safe`, `danger` (intentionally fully translucent — no opaque pixels)

Legacy single-piece arrows (`aim_arrow_*.png`), `aim/complete/**` and the two
`aim_ricochet_preview_*.png` reference images were **removed from the runtime
tree** (2026-07-22 sprite repair) — nothing referenced them.

## UI (`ui/`)

| Runtime path | Use | Text policy |
| --- | --- | --- |
| `ui_logo_castle_ricochet.png` | title logo (loading + neutral result) | baked "CASTLE RICOCHET" verified clean |
| `ui_hud_shots_left.png` | Shots Left frame + 5 socket pips | baked "SHOTS LEFT" clean; pips dimmed live per shot |
| `ui_hud_reward.png` | Reward frame + coin icon | baked "0" is repainted at load; amount drawn as live text |
| `ui_hud_enemies_sunk.png` | Enemies Sunk frame + target icon | baked "0 /3" repainted at load; progress drawn as live text |
| `ui_button_pause.png` | pause button | icon only |
| `ui_button_play.png` | play/resume icon | icon only |
| `ui_button_home.png` | home icon | icon only |
| `ui_button_restart.png` | restart icon | icon only |
| `ui_banner_game_over.png` | Game Over result banner | baked "GAME OVER" verified clean; reason is live text |
| `ui_banner_victory.png` | Victory result banner | baked "VICTORY!" verified clean; reward is live text |
| `ui_warning_player_token_game_over.png` | tutorial pit warning panel | decorative; tutorial message is live text |
| `ui_currency_coin_castle.png` | Castle Ricochet coin icon (menu button) | icon only |
| `ui_reward_badge_500.png` / `_1000.png` / `_1500.png` | result badges | decorative denomination medals; earned amount is live text ("N COINS EARNED") |

All dynamic values (shots remaining, enemies sunk, reward, cooldown timer,
result lines, replay cost) are live canvas/DOM text — never baked sprites.

## QA

Dev-only review screen (never packaged, not in game navigation):
`scripts/ricochet-sprite-review.html` — renders every sprite over light stone,
dark stone, blue-banner and torch-lit swatches.

2026-07-22 repair provenance: all tokens/obstacles/UI sprites were healed for
interior erasure holes (partially deleted white artwork), defringed of
white/gray matte halos, and despeckled; pre-repair originals are preserved in
the session scratchpad and in git history. Follow-up passes the same day:
(1) obstacle and UI baked shadow skirts (opaque white-matted neutral gray)
stripped — no sprite carries a baked drop shadow; (2) damaged baked lettering
(ENEMIES SUNK "M", SHOTS LEFT "O", REWARD "R"/"W", badge digits, GAME OVER,
logo "CASTLE") refilled with row-sampled intact glyph material plus a
luminance-preserving warm-chroma remap of residual gray murk.
