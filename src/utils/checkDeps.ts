/**
 * Startup dependency check for the hydra CLI.
 *
 * Checks for required system tools before any command runs.
 * Runs silently when all deps are present.
 * Calls logger.error() (which calls process.exit(1)) on the first missing dep.
 *
 * Detection uses child_process.execSync with { stdio: 'ignore' }
 * to avoid polluting the terminal with version output.
 */

import { execSync } from 'node:child_process';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Dependency specifications
// ---------------------------------------------------------------------------

interface DepSpec {
  /** Binary name to check with which/where */
  bin: string;
  /** Install URL shown in the error message */
  installUrl: string;
  /** When true, only checked for remote sub-commands */
  remoteOnly?: boolean;
}

const DEPS: DepSpec[] = [
  {
    bin: 'docker',
    installUrl: 'https://docs.docker.com/engine/install/',
  },
  {
    bin: 'git',
    installUrl: 'https://git-scm.com/downloads',
  },
  {
    bin: 'ansible-playbook',
    installUrl:
      'https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html',
    remoteOnly: true,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isBinAvailable(bin: string): boolean {
  try {
    // Use 'where' on Windows, 'which' on Unix/macOS
    const cmd = process.platform === 'win32' ? `where ${bin}` : `which ${bin}`;
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isRemoteCommand(): boolean {
  const args = process.argv.slice(2);
  return args.some(
    (a) => a === 'remote' || a.startsWith('remote:') || a.startsWith('remote-')
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check required system dependencies before running any command.
 *
 * - docker and git are always checked.
 * - ansible-playbook is only checked for remote sub-commands.
 *
 * Calls logger.error() (process.exit(1)) on the first missing dependency.
 * Runs silently if all deps are present.
 */
export function checkDeps(): void {
  const remote = isRemoteCommand();

  for (const dep of DEPS) {
    if (dep.remoteOnly && !remote) continue;

    if (!isBinAvailable(dep.bin)) {
      logger.error(
        `Missing required dependency: ${dep.bin}\n` +
          `   Install: ${dep.installUrl}`
      );
    }
  }
}
