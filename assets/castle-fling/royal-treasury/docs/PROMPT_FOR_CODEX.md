You are updating the Castle Fling browser game.

Goal:
Install the new Royal Treasury icon sprite pack and replace the current emoji/simple icons in the Royal Treasury menu with polished fantasy arcade sprites that match the rest of the Castle Fling art style.

New file provided:
- royal-treasury-icons-pack.zip

Install location:
Unzip the pack into:
assets/castle-fling/royal-treasury/

Use this manifest as the source of truth:
assets/castle-fling/royal-treasury/asset-manifest.json

Important:
This is not a gameplay rewrite. Keep the Royal Treasury purchase/unlock logic intact. This is an asset/UI integration pass with a small polish pass.

--------------------------------------------------
TASK 1 — INSTALL AND LOAD THE PACK
--------------------------------------------------

Install these files under:
assets/castle-fling/royal-treasury/

Expected files:
- asset-manifest.json
- treasury-icon-map.json
- sprites/treasury/treasury_ironwall_castle.png
- sprites/treasury/treasury_spellspire_castle.png
- sprites/treasury/treasury_barracks_hold.png
- sprites/treasury/treasury_titan_grip.png
- sprites/treasury/treasury_storm_fingers.png
- sprites/treasury/treasury_golden_touch.png
- sprites/treasury/treasury_ballista_variant.png
- sprites/treasury/treasury_chaos_contract.png
- sprites/treasury/treasury_nightmare_sigil.png
- sprites/treasury/treasury_spectral_hand.png
- sprites/treasury/treasury_royal_gauntlet.png
- sprites/treasury/treasury_crimson_banners.png
- sprites/treasury/treasury_azure_banners.png

Load these images through the existing asset loader or add them to the centralized asset registry.
Do not hardcode long paths in many locations. Use a single treasury icon registry/config.

--------------------------------------------------
TASK 2 — REPLACE EACH ROYAL TREASURY MENU ICON
--------------------------------------------------

Replace the current Royal Treasury menu icons with the following exact mapping:

Ironwall Castle:
- id: treasury_ironwall_castle
- file: sprites/treasury/treasury_ironwall_castle.png
- cost: 30 crowns
- category: starting_castle
- type: unlock
- description: Unlock a fortress-style castle with mighty walls but slower gold income.

Spellspire Castle:
- id: treasury_spellspire_castle
- file: sprites/treasury/treasury_spellspire_castle.png
- cost: 50 crowns
- category: starting_castle
- type: unlock
- description: Unlock a magic-focused castle that begins with a Mage Tower.

Barracks Hold:
- id: treasury_barracks_hold
- file: sprites/treasury/treasury_barracks_hold.png
- cost: 50 crowns
- category: starting_castle
- type: unlock
- description: Unlock a castle built around converting enemies.

Titan Grip:
- id: treasury_titan_grip
- file: sprites/treasury/treasury_titan_grip.png
- cost: 40 crowns
- category: hand_power
- type: unlock
- description: Hand power: heavy enemies can be fully lifted.

Storm Fingers:
- id: treasury_storm_fingers
- file: sprites/treasury/treasury_storm_fingers.png
- cost: 60 crowns
- category: hand_power
- type: unlock
- description: Hand power: hard landings release a shock nova.

Golden Touch:
- id: treasury_golden_touch
- file: sprites/treasury/treasury_golden_touch.png
- cost: 50 crowns
- category: economy
- type: perk
- description: +15% gold from all sources.

Ballista Variant:
- id: treasury_ballista_variant
- file: sprites/treasury/treasury_ballista_variant.png
- cost: 45 crowns
- category: tower_variant
- type: unlock
- description: Archer Tower fires slow piercing bolts instead.

Chaos Contract:
- id: treasury_chaos_contract
- file: sprites/treasury/treasury_chaos_contract.png
- cost: 25 crowns
- category: risk_reward
- type: unlock
- description: Rare golden enemies appear, worth 5x gold.

Nightmare Sigil:
- id: treasury_nightmare_sigil
- file: sprites/treasury/treasury_nightmare_sigil.png
- cost: 80 crowns
- category: challenge_mode
- type: unlock
- description: Unlock Nightmare mode: brutal enemies, double crowns.

Spectral Hand:
- id: treasury_spectral_hand
- file: sprites/treasury/treasury_spectral_hand.png
- cost: 20 crowns
- category: cosmetic
- type: cosmetic
- description: Cosmetic: a ghostly blue hand. Click to equip.

Royal Gauntlet:
- id: treasury_royal_gauntlet
- file: sprites/treasury/treasury_royal_gauntlet.png
- cost: 30 crowns
- category: cosmetic
- type: cosmetic
- description: Cosmetic: a gilded royal gauntlet. Click to equip.

Crimson Banners:
- id: treasury_crimson_banners
- file: sprites/treasury/treasury_crimson_banners.png
- cost: 10 crowns
- category: cosmetic
- type: cosmetic
- description: Cosmetic: dye your castle banners crimson.

Azure Banners:
- id: treasury_azure_banners
- file: sprites/treasury/treasury_azure_banners.png
- cost: 10 crowns
- category: cosmetic
- type: cosmetic
- description: Cosmetic: dye your castle banners azure.

--------------------------------------------------
TASK 3 — UI RENDERING REQUIREMENTS
--------------------------------------------------

Render all treasury item icons as real PNG sprites, not emojis.

Requirements:
- Use center anchoring for every icon.
- Preserve aspect ratio.
- Do not stretch icons.
- Do not crop icons.
- For DOM rendering, use object-fit: contain.
- For Canvas rendering, draw the entire image using:
  sx = 0
  sy = 0
  sw = image.width
  sh = image.height
- Keep icons inside the existing item cards with safe padding.
- Recommended menu icon display size is roughly 44–52 px depending on the item.
- Large castle/unlock icons may be slightly wider, but they must not overlap text.
- Hand/cosmetic icons should feel centered and readable.
- Banners should be slightly narrower and not oversized.

Do not allow any icon to be clipped by:
- parent overflow hidden
- incorrect sprite-sheet source rectangle
- incorrect atlas metadata
- too-small CSS width/height
- transform scale pushing the icon outside its card

--------------------------------------------------
TASK 4 — TREASURY MENU POLISH
--------------------------------------------------

Do a polish pass on the Royal Treasury menu so it visually matches the Castle Fling fantasy arcade style.

Requirements:
- Maintain the blue/gold/stone UI style.
- Improve card spacing if icons crowd the text.
- Keep text readable.
- Keep the cost button/crown badge aligned.
- Make unlocked/equipped states visually clear.
- Make locked/affordable/unaffordable states clear.
- Do not use default browser button styling.
- Keep the Back button working.
- The menu must fit on desktop and scale cleanly on smaller screens.

Suggested layout per card:
- icon on the left
- item name and description in the center
- cost/equip/purchased button on the right

--------------------------------------------------
TASK 5 — PRESERVE EXISTING FUNCTIONALITY
--------------------------------------------------

Do not break:
- crown currency balance
- purchase logic
- unlock state persistence
- equipped cosmetic state
- starting castle selection
- hand power selection
- challenge mode unlocks
- back/menu navigation
- music/audio behavior
- gameplay scene and existing enemy/castle systems

If an item currently uses an emoji or simple placeholder symbol, replace only the visual icon reference, not the game logic.

--------------------------------------------------
TASK 6 — FINAL QA CHECK
--------------------------------------------------

Test:
- Open Royal Treasury menu.
- Confirm every item displays the correct PNG icon.
- Confirm no icon is clipped, stretched, pixelated, or misaligned.
- Confirm every item still shows the correct name, description, cost, and status.
- Confirm purchase buttons still work.
- Confirm cosmetic equip buttons still work.
- Confirm Back button works.
- Confirm menu works on desktop and mobile-sized layouts.
- Confirm no console errors for missing image paths.

Deliverable:
A clean updated build where the Royal Treasury menu uses the new labeled sprite icons for every item, all icons are properly scaled and centered, and the menu remains fully functional and visually consistent with Castle Fling.
