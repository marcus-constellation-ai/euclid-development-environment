/**
 * Elapsed time utilities for the hydra CLI.
 *
 * Provides formatElapsed() for human-readable durations and a
 * module-level command start tracker used by logger.error() and index.ts.
 */

let _commandStart: number | null = null;

/**
 * Record the command start time. Call once before execute() in index.ts.
 */
export function setCommandStart(): void {
  _commandStart = Date.now();
}

/**
 * Return the recorded command start time, or null if not set.
 */
export function getCommandStart(): number | null {
  return _commandStart;
}

/**
 * Format elapsed milliseconds into a human-readable string.
 * Omits minutes when total elapsed is less than 60 seconds.
 *
 * @example
 *   formatElapsed(14000)   → "(14s)"
 *   formatElapsed(135000)  → "(2m 15s)"
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `(${totalSeconds}s)`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `(${minutes}m ${seconds}s)`;
}

/**
 * Return formatted elapsed time since setCommandStart() was called,
 * or null if setCommandStart() was never called.
 */
export function elapsedSinceStart(): string | null {
  if (_commandStart === null) return null;
  return formatElapsed(Date.now() - _commandStart);
}
