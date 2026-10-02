// Index width limits an individual index value, not the number of indices or
// expanded vertices in a draw. Keep host snapshots bounded by byte budgets.
export const MAX_DRAW_VERTICES = 1024 * 1024;
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_FRAME_COMMANDS = 4096;
