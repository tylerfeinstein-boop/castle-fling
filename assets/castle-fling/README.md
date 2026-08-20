# Castle Fling Game Assets

Prepared transparent PNG assets for direct game integration.

## Folder Map

- `branding/` - main game logo
- `backgrounds/` - battlefield/background layer
- `sprites/enemies/` - individual enemy and siege sprites
- `sprites/defenders/` - player-side defender sprites
- `sprites/upgrades/` - castle room/upgrade sprites
- `ui/buttons/` - prebuilt button states
- `ui/icons/` - ability/menu icons
- `source_sheets/` - original transparent sheets for reference

## Integration Notes

Use `asset-manifest.json` to load assets by stable ID. Most gameplay sprites use `center-bottom` anchoring. UI and branding use `center` anchoring.
