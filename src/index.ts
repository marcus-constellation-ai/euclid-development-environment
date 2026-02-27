/**
 * Hydra CLI — Euclid Development Environment
 *
 * TypeScript rewrite of the original bash-based hydra CLI.
 * Uses oclif for plugin-extensible command dispatch.
 *
 * Entry point: delegates to oclif's execute() which reads oclif config
 * from package.json and dispatches to the appropriate command class.
 */
import { execute, flush, handle } from '@oclif/core'
import chalk from 'chalk'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

import { checkDeps } from './utils/checkDeps.js'
import { setCommandStart, getCommandStart, formatElapsed } from './utils/time.js'
import { logger } from './utils/logger.js'

const _require = createRequire(import.meta.url)
const _dir = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Shell completion interception (tabtab)
//
// When the shell requests completions it sets COMP_CWORD / COMP_LINE /
// COMP_POINT and then calls the binary as:
//   hydra completion -- <words…>
//
// We must handle this before the banner, dependency checks, and oclif
// dispatch so that only the completion candidates are written to stdout.
// ---------------------------------------------------------------------------
function handleCompletions(): void {
  const tabtab = _require('tabtab') as {
    parseEnv(env: NodeJS.ProcessEnv): { complete: boolean; prev: string | undefined }
    log(completions: string[]): void
  }

  const env = tabtab.parseEnv(process.env)
  if (!env.complete) return

  const prev = env.prev ?? ''

  if (!prev || prev === 'hydra') {
    // Top-level: all commands (both topics and top-level aliases)
    tabtab.log([
      'build',
      'start-genesis',
      'start-rollback',
      'stop',
      'status',
      'logs',
      'install',
      'install-template',
      'destroy',
      'purge',
      'remote-deploy',
      'remote-start',
      'remote-status',
      'remote-logs',
      'create-remote-genesis',
      'remote-snapshot-fee-config',
      'install-monitoring-service',
      'remote-deploy-monitoring-service',
      'remote-start-monitoring-service',
      'version',
      'doctor',
      'local',
      'remote',
      'completion',
      'help',
    ])
  } else if (prev === 'local') {
    tabtab.log([
      'build',
      'start-genesis',
      'start-rollback',
      'stop',
      'status',
      'logs',
      'install',
      'install-template',
      'destroy',
      'purge',
    ])
  } else if (prev === 'remote') {
    tabtab.log([
      'deploy',
      'start',
      'status',
      'logs',
      'create-remote-genesis',
      'snapshot-fee-config',
      'install-monitoring-service',
      'deploy-monitoring-service',
      'start-monitoring-service',
    ])
  } else if (prev === 'remote-deploy' || prev === 'remote_deploy' || prev === 'deploy') {
    tabtab.log(['--force-genesis', '--force-owner-message', '--force-staking-message'])
  } else if (prev === 'remote-start' || prev === 'remote_start' || prev === 'start') {
    tabtab.log(['--force-genesis', '--force-owner-message', '--force-staking-message'])
  } else if (prev === 'start-genesis' || prev === 'start_genesis') {
    tabtab.log([])
  } else if (prev === 'start-rollback' || prev === 'start_rollback') {
    tabtab.log([])
  } else if (prev === 'build') {
    tabtab.log(['--no_cache', '--run'])
  } else if (prev === 'logs') {
    tabtab.log(['-n', '--follow'])
  } else if (prev === 'status') {
    tabtab.log([])
  } else if (prev === 'completion') {
    tabtab.log(['install', 'uninstall'])
  } else if (prev === '--network' || prev === '-n') {
    // Network name argument
    tabtab.log(['integrationnet', 'testnet', 'mainnet'])
  }

  process.exit(0)
}

handleCompletions()

/** Read version from package.json relative to the compiled output */
function getVersion(): string {
  try {
    const pkg = _require(path.resolve(_dir, '..', 'package.json')) as { version: string }
    return pkg.version ?? '0.1.0'
  } catch {
    return '0.1.0'
  }
}

function printBanner(): void {
  const version = getVersion()
  const banner =
    chalk.cyan(`
  ██╗  ██╗██╗   ██╗██████╗ ██████╗  █████╗
  ██║  ██║╚██╗ ██╔╝██╔══██╗██╔══██╗██╔══██╗
  ███████║ ╚████╔╝ ██║  ██║██████╔╝███████║
  ██╔══██║  ╚██╔╝  ██║  ██║██╔══██╗██╔══██║
  ██║  ██║   ██║   ██████╔╝██║  ██║██║  ██║
  ╚═╝  ╚═╝   ╚═╝   ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝
`) +
    `  ${chalk.bold.white('Euclid Development Environment')}  ${chalk.dim(`v${version}`)}\n` +
    `  ${chalk.dim('Constellation Network — Metagraph Tooling')}\n\n`
  process.stdout.write(banner)
}

/**
 * Show the banner when user runs `hydra` with no args or `hydra --help` / `hydra -h`.
 */
function shouldShowBanner(): boolean {
  const args = process.argv.slice(2)
  if (args.length === 0) return true
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') return true
  return false
}

/**
 * Returns true when an actual command (not help/version) is being run.
 * Used to gate dependency checks and elapsed time tracking.
 */
function isActualCommand(): boolean {
  const args = process.argv.slice(2)
  if (args.length === 0) return false
  const first = args[0] ?? ''
  if (first === '--help' || first === '-h' || first === 'help') return false
  if (first === '--version' || first === '-v') return false
  return true
}

/**
 * Get the command name from process.argv for display in timing output.
 * Returns the first 1-2 non-flag args, e.g. "local build" or "status".
 */
function getCommandName(): string {
  const args = process.argv.slice(2)
  const nonFlags = args.filter((a) => !a.startsWith('-'))
  return nonFlags.slice(0, 2).join(' ') || 'hydra'
}

// Handle --version / -v early: print custom format instead of oclif's default output
if (process.argv[2] === '--version' || process.argv[2] === '-v') {
  process.stdout.write(`hydra v${getVersion()}\n`)
  process.exit(0)
}

if (shouldShowBanner()) {
  printBanner()
}

if (isActualCommand()) {
  // Record start time before any work so logger.error() can show elapsed
  setCommandStart()
  // Skip dep checks for info-only commands that inspect dependencies themselves
  const first = process.argv[2] ?? ''
  if (first !== 'version' && first !== 'doctor') {
    checkDeps()
  }
}

await execute({ development: false, dir: import.meta.url })
  .then(async () => {
    await flush()
    // Print elapsed time on successful command completion
    const start = getCommandStart()
    if (start !== null) {
      const elapsed = formatElapsed(Date.now() - start)
      const cmdName = getCommandName()
      logger.success(`${cmdName} complete  ${elapsed}`)
    }
  })
  .catch((err: unknown) => {
    // Print elapsed even for oclif-level errors (this.error() calls)
    const start = getCommandStart()
    if (start !== null) {
      const elapsed = formatElapsed(Date.now() - start)
      process.stderr.write(chalk.dim(`  ${elapsed}\n`))
    }
    handle(err as Error)
  })
