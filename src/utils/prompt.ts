/**
 * Interactive prompt utilities for the hydra CLI.
 *
 * Provides confirmation prompts for destructive operations like
 * --force-genesis (wipes remote node state) and similar dangerous flags.
 */

import * as readline from 'node:readline';

/**
 * Show a Y/N confirmation prompt for a destructive operation.
 *
 * Defaults to "No" (safe default) to prevent accidental data loss.
 * Returns true if the user typed "y" or "Y", false otherwise.
 *
 * Matches confirm_force_genesis() in scripts/utils/validations.sh:
 *   - Called when --force_genesis is passed
 *   - Warns that node data will be wiped
 *   - Exits if user declines
 *
 * @param message - Warning message to show before the prompt
 * @returns Promise resolving to true if confirmed, false if declined
 */
export function confirmDestructive(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`\n${message}\nAre you sure you want to proceed? [y/N]: `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}
