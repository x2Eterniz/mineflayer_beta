# Mine 1.1.45 - Crosshair targeting

`/mine` now chooses **B1 from the exact block under the player's crosshair** using Mineflayer `blockAtCursor()` when available, with a world-raycast fallback.

After B1 is selected, `/mine blocks 1..10` controls how many consecutive blocks are selected along the dominant horizontal look axis.

Examples:
- `/mine blocks 1` = only the crosshair block
- `/mine blocks 5` = crosshair block + 4 blocks forward on the same row
- `/mine blocks 10` = up to 10 blocks on that row

`/mine packet <ms>` remains the runtime packet cadence setting.
