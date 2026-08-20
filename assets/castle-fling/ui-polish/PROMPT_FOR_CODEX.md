You are updating the Castle Fling browser/Android/Windows game.

Goal:
Install the new UI polish sprite pack and replace remaining emoji/placeholders and low-quality effects with polished Castle Fling fantasy arcade assets.

New file provided:
- castle-fling-ui-polish-sprites-pack.zip

Install location:
Unzip into:
assets/castle-fling/ui-polish/

Use this manifest as the source of truth:
assets/castle-fling/ui-polish/asset-manifest.json

Important:
This is an asset integration and UI polish pass. Do not rewrite gameplay. Do not break wave logic, enemy spawning, grabbing/throwing, castle upgrades, economy, save data, music, Android scaling, Windows build setup, or existing sprites.

--------------------------------------------------
TASK 1 — INSTALL THE ASSET PACK
--------------------------------------------------

Unzip the pack into:
assets/castle-fling/ui-polish/

Expected folders:
- sprites/settings/
- sprites/how_to_play/
- sprites/hud/
- sprites/death_marks/
- sprites/castle_damage/
- sprites/dangerous_bargains/
- asset-manifest.json

Load these assets through the existing asset loader/registry. Keep paths centralized. Do not hardcode long paths in many places.

--------------------------------------------------
TASK 2 — REPLACE SETTINGS EMOJI PLACEHOLDERS
--------------------------------------------------

Replace emoji/simple placeholders in the Settings panel with these PNG icons:

Sound Effects:
- settings_icon_sound_effects
- sprites/settings/settings_icon_sound_effects.png

Music:
- settings_icon_music
- sprites/settings/settings_icon_music.png

Music Volume:
- settings_slider_music_volume
- sprites/settings/settings_slider_music_volume.png

Screen Shake:
- settings_icon_screen_shake
- sprites/settings/settings_icon_screen_shake.png

Damage Numbers:
- settings_icon_damage_numbers
- sprites/settings/settings_icon_damage_numbers.png

Extra Particles:
- settings_icon_extra_particles
- sprites/settings/settings_icon_extra_particles.png

Requirements:
- Render PNG icons instead of emojis.
- Use center anchoring.
- Recommended display size: 36–48px depending on platform.
- Preserve aspect ratio.
- Do not crop, stretch, or pixelate icons.
- Keep row spacing clean on desktop and mobile.

--------------------------------------------------
TASK 3 — REPLACE HOW TO PLAY EMOJI PLACEHOLDERS
--------------------------------------------------

Replace How to Play emoji/simple placeholders with these PNG icons:

Grab & Throw:
- howto_icon_grab_throw
- sprites/how_to_play/howto_icon_grab_throw.png

Weight matters:
- howto_icon_weight_matters
- sprites/how_to_play/howto_icon_weight_matters.png

Defend the castle:
- howto_icon_defend_castle
- sprites/how_to_play/howto_icon_defend_castle.png

Convert:
- howto_icon_convert
- sprites/how_to_play/howto_icon_convert.png

Rooms:
- howto_icon_rooms
- sprites/how_to_play/howto_icon_rooms.png

Upgrades:
- howto_icon_upgrades
- sprites/how_to_play/howto_icon_upgrades.png

Keys:
- howto_icon_keys
- sprites/how_to_play/howto_icon_keys.png

Earn crowns:
- howto_icon_crowns
- sprites/how_to_play/howto_icon_crowns.png

Requirements:
- Icons should sit cleanly at the start of each How to Play line.
- Recommended display size: 28–40px.
- Text should align vertically with icons.
- No emojis should remain in this panel unless intentionally used as plain text.
- Panel must still fit on desktop and mobile.

--------------------------------------------------
TASK 4 — INSTALL NEW CASTLE LIFE BAR
--------------------------------------------------

Replace or upgrade the current castle health/life bar using these assets:

Empty frame:
- hud_lifebar_frame_empty
- sprites/hud/hud_lifebar_frame_empty.png

Fill bar:
- hud_lifebar_fill_gradient
- sprites/hud/hud_lifebar_fill_gradient.png

Optional decorative caps:
- hud_lifebar_left_endcap
- sprites/hud/hud_lifebar_left_endcap.png

- hud_lifebar_right_endcap
- sprites/hud/hud_lifebar_right_endcap.png

Implementation:
- Draw the fill first, clipped horizontally based on castle health percentage.
- Draw the empty frame above the fill.
- Preserve the current health text, such as 509 / 520, but place it cleanly within or above the new bar.
- Do not stretch unevenly.
- Preserve aspect ratio.
- Scale differently for desktop and mobile if needed.

Health thresholds:
- The bar may use the existing health color logic, or use the provided gradient fill clipped by HP ratio.
- Make sure low-health states still read clearly.

--------------------------------------------------
TASK 5 — REPLACE BAD ENEMY DEATH GROUND CIRCLES
--------------------------------------------------

Current issue:
When enemies die, the game leaves a bad blue or green textured circle on the ground.

Replace that effect with one of these death mark sprites:

- death_mark_cracked_dirt
- sprites/death_marks/death_mark_cracked_dirt.png

- death_mark_scorched_crater
- sprites/death_marks/death_mark_scorched_crater.png

- death_mark_rocky_crater
- sprites/death_marks/death_mark_rocky_crater.png

- death_mark_grass_scar
- sprites/death_marks/death_mark_grass_scar.png

- death_mark_splinter_debris
- sprites/death_marks/death_mark_splinter_debris.png

- death_mark_smoke_puff
- sprites/death_marks/death_mark_smoke_puff.png

- death_mark_dust_smudge
- sprites/death_marks/death_mark_dust_smudge.png

- death_mark_arcane_residue
- sprites/death_marks/death_mark_arcane_residue.png

Suggested mapping:
- normal physical enemy death: death_mark_dust_smudge or death_mark_cracked_dirt
- heavy/brute ground slam: death_mark_rocky_crater or death_mark_splinter_debris
- bomb/explosion death: death_mark_scorched_crater
- magic/convert-related death: death_mark_arcane_residue
- quick fade effect: death_mark_smoke_puff

Requirements:
- Do not use the old blue/green circles.
- Use bottom/center ground anchoring.
- Fade marks out over time.
- Marks should sit on the ground plane, not float above enemies.
- Preserve gameplay performance on mobile.

--------------------------------------------------
TASK 6 — INSTALL NEW CASTLE DAMAGE STAGES
--------------------------------------------------

Current issue:
When the castle gets damaged, old/original crack sprites appear and do not match the current Castle Fling art style.

Use the new castle damage stage sprites:

Healthy / normal:
- castle_damage_stage_0_healthy
- sprites/castle_damage/castle_damage_stage_0_healthy.png

Light damage:
- castle_damage_stage_1_light
- sprites/castle_damage/castle_damage_stage_1_light.png

Heavy damage:
- castle_damage_stage_2_heavy
- sprites/castle_damage/castle_damage_stage_2_heavy.png

Critical damage:
- castle_damage_stage_3_critical
- sprites/castle_damage/castle_damage_stage_3_critical.png

Suggested HP mapping:
- 76%–100% HP: stage 0
- 51%–75% HP: stage 1
- 26%–50% HP: stage 2
- 0%–25% HP: stage 3

Requirements:
- Replace old crack overlays or old damage sprites.
- The castle should look actually damaged as health decreases.
- Use the same anchor, baseline, and scale as the current castle art.
- Do not let the castle jump position when switching damage stages.
- If castle upgrades are attached with sockets, keep socket positions aligned to the castle layout.
- If using full castle replacements is too disruptive, use these as stage art references and draw them on the castle layer with matching bounds.

--------------------------------------------------
TASK 7 — REPLACE DANGEROUS BARGAIN EMOJI PLACEHOLDERS
--------------------------------------------------

Replace dangerous bargain emoji/simple placeholders with these icons:

Generic warning/header:
- bargain_warning
- sprites/dangerous_bargains/bargain_warning.png

Arcane Overload:
- bargain_arcane_overload
- sprites/dangerous_bargains/bargain_arcane_overload.png

Blood Pact / HP tradeoff:
- bargain_blood_pact
- sprites/dangerous_bargains/bargain_blood_pact.png

Gold/greed reward bargain:
- bargain_golden_greed
- sprites/dangerous_bargains/bargain_golden_greed.png

Blade/enemy damage bargain:
- bargain_blade_frenzy
- sprites/dangerous_bargains/bargain_blade_frenzy.png

Armor/shield cracking bargain:
- bargain_shattered_armor
- sprites/dangerous_bargains/bargain_shattered_armor.png

Time/cooldown/speed bargain:
- bargain_time_warp
- sprites/dangerous_bargains/bargain_time_warp.png

Bomb/explosive bargain:
- bargain_bomb_madness
- sprites/dangerous_bargains/bargain_bomb_madness.png

Nightmare/curse bargain:
- bargain_nightmare_pact
- sprites/dangerous_bargains/bargain_nightmare_pact.png

Burning walls/castle risk bargain:
- bargain_burning_walls
- sprites/dangerous_bargains/bargain_burning_walls.png

Requirements:
- Use these icons in the Dangerous Bargain modal/card.
- Replace emoji warning/lightning/etc placeholders.
- Use a recommended icon size of 48–72px depending on modal layout.
- Preserve aspect ratio.
- Keep the modal centered and readable on desktop and mobile.

--------------------------------------------------
TASK 8 — RESPONSIVE UI FIT AND SCALING
--------------------------------------------------

All newly installed sprites must scale correctly on both Windows and Android.

Requirements:
- Do not hardcode one desktop-only size for all UI icons.
- Use UI scale values from the responsive layout system.
- Keep icons inside their rows/cards/buttons.
- No icon should push text off-screen.
- No icon should be clipped by panel bounds.
- Menus must fit on mobile.
- Use safe-area-aware sizing on Android.

--------------------------------------------------
TASK 9 — FINAL QA
--------------------------------------------------

Verify:
- Settings menu has no emoji placeholders.
- How to Play menu has no emoji placeholders.
- Dangerous Bargain modal has no emoji placeholders.
- Castle life bar uses the new fantasy HUD art.
- Enemy death markers no longer appear as blue/green circles.
- Castle damage visuals match the current castle art style.
- All sprites are transparent PNGs and render without white boxes.
- All UI panels still fit on desktop and Android.
- No missing image path errors appear.
- Gameplay remains unchanged.

Deliverable:
A clean updated Castle Fling build where the remaining emoji/placeholders, bad death marks, old castle damage cracks, and mismatched life bar are replaced with the new install-ready Castle Fling UI polish sprites.
