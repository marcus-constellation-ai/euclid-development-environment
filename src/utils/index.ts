/**
 * Shared utilities for the Hydra CLI.
 *
 * Provides typed wrappers around:
 *   - Chalk-based color output (mirrors echo_green, echo_red, etc. from bash)
 *   - Shell execution via execa (mirrors ansible-playbook, docker invocations)
 *   - Path resolution helpers (mirrors build_paths() from hydra)
 *   - Validation helpers (mirrors scripts/utils/validations.sh)
 *
 * TODO (Agent 2 — Local commands, Agent 4 — Remote commands):
 *   Use these utilities in command implementations.
 *
 * TODO (Agent 3 — Config & Validation):
 *   Implement the validation functions (checkDocker, checkAnsible, checkP12Files, etc.)
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Path resolution (mirrors build_paths() from hydra) ───────────────────────

/**
 * Resolves the repository root directory by walking up from the given URL.
 * In the compiled CLI, `import.meta.url` of the command file points into dist/.
 */
export function getRepositoryRoot(fromUrl?: string): string {
  if (fromUrl) {
    // Walk up from dist/commands/[local|remote]/ to repo root
    const dir = path.dirname(fileURLToPath(fromUrl))
    return path.resolve(dir, '..', '..', '..', '..')
  }
  return process.cwd()
}

export function getScriptsPath(rootPath: string): string {
  return path.join(rootPath, 'scripts')
}

export function getInfraPath(rootPath: string): string {
  return path.join(rootPath, 'infra')
}

export function getSourcePath(rootPath: string): string {
  return path.join(rootPath, 'source')
}

// ── Layer names ───────────────────────────────────────────────────────────────

export const VALID_LAYERS = [
  'global-l0',
  'dag-l1',
  'metagraph-l0',
  'currency-l1',
  'data-l1',
] as const

export type LayerName = (typeof VALID_LAYERS)[number]

export const VALID_REMOTE_LAYERS = [...VALID_LAYERS, 'monitoring'] as const
export type RemoteLayerName = (typeof VALID_REMOTE_LAYERS)[number]

// ── Network names ─────────────────────────────────────────────────────────────

export const VALID_NETWORKS = ['integrationnet', 'mainnet'] as const
export type NetworkName = (typeof VALID_NETWORKS)[number]

// ── Ansible playbook runner (stub) ────────────────────────────────────────────

export interface AnsibleOptions {
  playbookPath: string
  inventoryPath?: string
  extraVars?: Record<string, string | number | boolean>
  env?: Record<string, string>
  verbose?: boolean
}

/**
 * Runs an Ansible playbook via execa.
 * TODO (Agent 2 / Agent 4): implement using execa
 */
export async function runAnsiblePlaybook(_opts: AnsibleOptions): Promise<void> {
  // TODO: implement using execa
  // const args = buildAnsibleArgs(opts)
  // await execa('ansible-playbook', args, { stdio: 'inherit', env: { ...process.env, ...opts.env } })
  throw new Error('runAnsiblePlaybook() not yet implemented')
}

// ── Docker helpers (stub) ─────────────────────────────────────────────────────

/**
 * Detects whether docker compose v2 or docker-compose v1 is installed.
 * Mirrors set_docker_compose() and check_if_docker_is_running() from bash.
 * TODO (Agent 2): implement
 */
export async function detectDockerCompose(): Promise<'docker compose' | 'docker-compose'> {
  // TODO: use execa to test docker compose version
  throw new Error('detectDockerCompose() not yet implemented')
}

// ── Validation stubs (mirrors validations.sh) ────────────────────────────────

/**
 * Validates that Ansible ≥ 2.16 is installed.
 * TODO (Agent 3): implement
 */
export async function checkAnsible(): Promise<void> {
  throw new Error('checkAnsible() not yet implemented')
}

/**
 * Validates that Docker ≥ v26.0.0 is running.
 * TODO (Agent 2): implement
 */
export async function checkDocker(): Promise<void> {
  throw new Error('checkDocker() not yet implemented')
}

/**
 * Validates that all p12 files defined in euclid.json exist in source/p12-files/.
 * TODO (Agent 3): implement
 */
export async function checkP12Files(_rootPath: string, _nodes: unknown[]): Promise<void> {
  throw new Error('checkP12Files() not yet implemented')
}
