# Royal Treasury Icons Pack

Install path recommendation:
`assets/castle-fling/royal-treasury/`

This pack contains one individual transparent PNG icon for every visible item in the current Royal Treasury menu.

Included items:
- `treasury_ironwall_castle` — Ironwall Castle
- `treasury_spellspire_castle` — Spellspire Castle
- `treasury_barracks_hold` — Barracks Hold
- `treasury_titan_grip` — Titan Grip
- `treasury_storm_fingers` — Storm Fingers
- `treasury_golden_touch` — Golden Touch
- `treasury_ballista_variant` — Ballista Variant
- `treasury_chaos_contract` — Chaos Contract
- `treasury_nightmare_sigil` — Nightmare Sigil
- `treasury_spectral_hand` — Spectral Hand
- `treasury_royal_gauntlet` — Royal Gauntlet
- `treasury_crimson_banners` — Crimson Banners
- `treasury_azure_banners` — Azure Banners

Use `asset-manifest.json` as the source of truth for display names, costs, categories, descriptions, file paths, and recommended display sizes.

Important implementation notes:
- Use center anchoring for menu icons.
- Preserve aspect ratio.
- Do not crop icons using partial source rectangles.
- Use `object-fit: contain` for DOM UI or full-image `drawImage` source rectangles for Canvas.
- The menu cards should remain blue/gold/stone styled and should not fall back to emoji icons once this pack is installed.
