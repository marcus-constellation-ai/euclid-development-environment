/**
 * Interactive prompt utilities for the hydra CLI.
 *
 * Provides confirmation prompts for destructive operations using @inquirer/prompts.
 * All prompts default to the safe (non-destructive) option.
 */

import { confirm, input } from '@inquirer/prompts';
import boxen from 'boxen';
import chalk from 'chalk';
import { logger } from './logger.js';

/**
 * Show a y/N confirmation prompt (default: No).
 *
 * Logs 'Aborted.' and returns false if the user declines or presses Ctrl+C.
 *
 * @param message - The question to show (without trailing question mark)
 */
export async function confirmYN(message: string): Promise<boolean> {
  try {
    const result = await confirm({ message, default: false });
    if (!result) {
      logger.info('Aborted.');
    }
    return result;
  } catch {
    // Ctrl+C or other interruption
    logger.info('Aborted.');
    return false;
  }
}

/**
 * Show a red boxen warning box for --force-genesis operations and require
 * the user to type "yes" exactly to confirm.
 *
 * Logs 'Aborted — confirmation text did not match.' if the user types anything
 * other than exactly "yes". Logs 'Aborted.' on Ctrl+C.
 *
 * Returns true only if the user types exactly "yes".
 */
export async function confirmForceGenesis(): Promise<boolean> {
  const body = [
    chalk.bold('⚠  DESTRUCTIVE OPERATION'),
    '',
    `This will ${chalk.bold('ERASE')} all on-chain history on`,
    'the remote node and restart from genesis.',
    '',
    'This cannot be undone.',
  ].join('\n');

  process.stdout.write(
    boxen(body, { borderColor: 'red', borderStyle: 'round', padding: 1 }) + '\n'
  );

  try {
    const answer = await input({ message: "Type 'yes' to confirm" });
    if (answer !== 'yes') {
      logger.warn('Aborted — confirmation text did not match.');
      return false;
    }
    return true;
  } catch {
    // Ctrl+C
    logger.info('Aborted.');
    return false;
  }
}
