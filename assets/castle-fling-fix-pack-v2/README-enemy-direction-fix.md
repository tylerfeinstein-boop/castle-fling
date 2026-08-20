# Castle Fling Enemy Direction Fix

This patch replaces the enemy sprites from `castle-fling-fix-pack`.

## What changed
- `enemy_siege_captain.png` has been flipped so the captain points/faces LEFT toward the castle.
- The enemy filenames were also corrected because the previous extracted pack had several sprites assigned to the wrong enemy IDs.

## Install
Copy the contents of this patch over your existing asset folder:

`assets/castle-fling-fix-pack/`

Allow it to replace files under:

`sprites/enemies/`

## Important code note
The new `enemy_siege_captain.png` is already left-facing. Do not horizontally mirror this sprite in code unless your engine mirrors all enemies consistently.
