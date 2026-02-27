/**
 * Docker helper utilities for the hydra CLI.
 *
 * Provides typed wrappers around docker and docker compose commands
 * as well as container status querying and health-waiting helpers.
 *
 * All shell invocations use execa (never child_process directly).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContainerStatusValue =
  | 'running'
  | 'exited'
  | 'paused'
  | 'created'
  | 'dead'
  | 'restarting'
  | 'removing'
  | 'not_found';

export interface ContainerStatus {
  name: string;
  status: ContainerStatusValue;
  id?: string;
}

/** Detected docker compose command — either 'docker compose' (v2) or 'docker-compose' (v1). */
export type DockerComposeCommand = 'docker compose' | 'docker-compose';

// ---------------------------------------------------------------------------
// Docker compose detection
// ---------------------------------------------------------------------------

let _cachedComposeCommand: DockerComposeCommand | null = null;

/**
 * Detect whether the system has Docker Compose v2 (built-in plugin) or v1.
 * Result is cached after the first call.
 *
 * Matches the bash set_docker_compose() function in scripts/docker/operations.sh.
 */
export async function detectDockerCompose(): Promise<DockerComposeCommand> {
  if (_cachedComposeCommand) return _cachedComposeCommand;

  // Try v2 first
  const v2Result = await execa('docker', ['compose', 'version'], { reject: false });
  if (v2Result.exitCode === 0) {
    _cachedComposeCommand = 'docker compose';
    return _cachedComposeCommand;
  }

  // Try v1
  const v1Result = await execa('docker-compose', ['--version'], { reject: false });
  if (v1Result.exitCode === 0) {
    _cachedComposeCommand = 'docker-compose';
    return _cachedComposeCommand;
  }

  throw new Error(
    'Neither "docker compose" (v2) nor "docker-compose" (v1) is available.\n' +
      'Install Docker Compose: https://docs.docker.com/compose/install/'
  );
}

// ---------------------------------------------------------------------------
// Core docker runner
// ---------------------------------------------------------------------------

/**
 * Run a docker command, inheriting stdio (visible to user).
 *
 * @param args - Arguments to pass to docker (e.g. ['ps', '-a'])
 * @param options - Optional execa overrides and cwd
 */
export async function runDocker(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  await execa('docker', args, {
    stdio: 'inherit',
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
  });
}

/**
 * Run a docker command and capture its stdout (not inherited).
 *
 * @param args - Arguments to pass to docker
 * @returns stdout string
 */
export async function runDockerCapture(
  args: string[],
  options: { cwd?: string } = {}
): Promise<string> {
  const result = await execa('docker', args, {
    cwd: options.cwd,
    env: process.env,
  });
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Docker Compose runner
// ---------------------------------------------------------------------------

/**
 * Run a docker compose command in the given working directory.
 *
 * Inherits stdio so build output is visible to the user.
 *
 * @param args - Arguments to pass after 'docker compose' / 'docker-compose'
 * @param cwd  - Working directory (directory containing docker-compose.yml)
 * @param env  - Additional environment variables
 */
export async function dockerCompose(
  args: string[],
  cwd?: string,
  env: NodeJS.ProcessEnv = {}
): Promise<void> {
  const composeCmd = await detectDockerCompose();
  const mergedEnv = { ...process.env, ...env };

  if (composeCmd === 'docker compose') {
    await execa('docker', ['compose', ...args], {
      stdio: 'inherit',
      cwd,
      env: mergedEnv,
    });
  } else {
    await execa('docker-compose', args, {
      stdio: 'inherit',
      cwd,
      env: mergedEnv,
    });
  }
}

// ---------------------------------------------------------------------------
// Container status
// ---------------------------------------------------------------------------

/**
 * Query the current status of a Docker container by name.
 *
 * Returns 'not_found' if the container does not exist.
 */
export async function getContainerStatus(name: string): Promise<ContainerStatus> {
  const result = await execa(
    'docker',
    ['inspect', '--format', '{{.State.Status}}', name],
    { reject: false, env: process.env }
  );

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return { name, status: 'not_found' };
  }

  const statusStr = result.stdout.trim().toLowerCase();
  const validStatuses: ContainerStatusValue[] = [
    'running', 'exited', 'paused', 'created', 'dead', 'restarting', 'removing',
  ];

  const status = validStatuses.includes(statusStr as ContainerStatusValue)
    ? (statusStr as ContainerStatusValue)
    : 'not_found';

  // Also get the container ID
  const idResult = await execa(
    'docker',
    ['inspect', '--format', '{{.Id}}', name],
    { reject: false, env: process.env }
  );

  return {
    name,
    status,
    id: idResult.exitCode === 0 ? idResult.stdout.trim().slice(0, 12) : undefined,
  };
}

/**
 * Check if a container is currently running.
 */
export async function isContainerRunning(name: string): Promise<boolean> {
  const status = await getContainerStatus(name);
  return status.status === 'running';
}

// ---------------------------------------------------------------------------
// Container wait
// ---------------------------------------------------------------------------

/**
 * Wait until a container reaches 'running' status, or throw on timeout.
 *
 * Polls every 2 seconds.
 *
 * @param name    - Container name to wait for
 * @param timeout - Max milliseconds to wait (default: 120_000 = 2 minutes)
 */
export async function waitForContainer(name: string, timeout = 120_000): Promise<void> {
  const pollInterval = 2000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const status = await getContainerStatus(name);
    if (status.status === 'running') return;
    if (status.status === 'dead' || status.status === 'exited') {
      throw new Error(`Container "${name}" exited unexpectedly (status: ${status.status})`);
    }
    await sleep(pollInterval);
  }

  throw new Error(
    `Timed out waiting for container "${name}" to start (${timeout / 1000}s timeout)`
  );
}

// ---------------------------------------------------------------------------
// Ansible runner
// ---------------------------------------------------------------------------

/** Environment variables to suppress Ansible noise (matches the bash exports). */
const ANSIBLE_QUIET_ENV: NodeJS.ProcessEnv = {
  ANSIBLE_LOCALHOST_WARNING: 'False',
  ANSIBLE_INVENTORY_UNPARSED_WARNING: 'False',
  ANSIBLE_DEPRECATION_WARNINGS: 'False',
};

/**
 * Run an ansible-playbook command, inheriting stdio.
 *
 * @param playbookPath - Absolute path to the .ansible.yml playbook
 * @param extraVars    - Key/value pairs passed as -e "key=value"
 * @param env          - Additional environment variables
 */
export async function runAnsible(
  playbookPath: string,
  extraVars: Record<string, string> = {},
  env: NodeJS.ProcessEnv = {}
): Promise<void> {
  const extraVarArgs: string[] = [];
  for (const [key, value] of Object.entries(extraVars)) {
    extraVarArgs.push('-e', `${key}=${value}`);
  }

  await execa('ansible-playbook', [playbookPath, ...extraVarArgs], {
    stdio: 'inherit',
    env: { ...process.env, ...ANSIBLE_QUIET_ENV, ...env },
  });
}

// ---------------------------------------------------------------------------
// Ansible playbook path resolver
// ---------------------------------------------------------------------------

/**
 * Build a record of all local Ansible playbook paths from the infra directory.
 * Matches the variable exports in scripts/utils/get-information.sh.
 */
export function buildAnsiblePaths(infraPath: string): AnsiblePaths {
  const local = path.join(infraPath, 'ansible', 'local', 'playbooks');
  return {
    vars: path.join(local, 'vars.ansible.yml'),
    containersStart: path.join(local, 'start', 'containers', 'nodes.ansible.yml'),
    containersStop: path.join(local, 'stop', 'containers', 'nodes.ansible.yml'),
    containersDestroy: path.join(local, 'destroy', 'containers', 'nodes.ansible.yml'),
    grafanaStart: path.join(local, 'start', 'containers', 'grafana.ansible.yml'),
    grafanaStop: path.join(local, 'stop', 'containers', 'grafana.ansible.yml'),
    globalL0Start: path.join(local, 'start', 'global-l0', 'cluster.ansible.yml'),
    globalL0Stop: path.join(local, 'stop', 'global-l0', 'cluster.ansible.yml'),
    dagL1Start: path.join(local, 'start', 'dag-l1', 'cluster.ansible.yml'),
    dagL1Stop: path.join(local, 'stop', 'dag-l1', 'cluster.ansible.yml'),
    metagraphL0Start: path.join(local, 'start', 'metagraph-l0', 'cluster.ansible.yml'),
    metagraphL0Stop: path.join(local, 'stop', 'metagraph-l0', 'cluster.ansible.yml'),
    currencyL1Start: path.join(local, 'start', 'currency-l1', 'cluster.ansible.yml'),
    currencyL1Stop: path.join(local, 'stop', 'currency-l1', 'cluster.ansible.yml'),
    dataL1Start: path.join(local, 'start', 'data-l1', 'cluster.ansible.yml'),
    dataL1Stop: path.join(local, 'stop', 'data-l1', 'cluster.ansible.yml'),
  };
}

export interface AnsiblePaths {
  vars: string;
  containersStart: string;
  containersStop: string;
  containersDestroy: string;
  grafanaStart: string;
  grafanaStop: string;
  globalL0Start: string;
  globalL0Stop: string;
  dagL1Start: string;
  dagL1Stop: string;
  metagraphL0Start: string;
  metagraphL0Stop: string;
  currencyL1Start: string;
  currencyL1Stop: string;
  dataL1Start: string;
  dataL1Stop: string;
}

// ---------------------------------------------------------------------------
// Tessellation version helpers
// ---------------------------------------------------------------------------

/**
 * Compute the Docker image tag for a tessellation version.
 * Branch: sanitized to alphanumeric + underscore, lowercased.
 * Tag: used as-is.
 *
 * Matches get_tessellation_version_name() in scripts/utils/get-information.sh.
 */
export function getTessellationVersionName(
  version: string,
  refType: 'tag' | 'branch'
): string {
  if (refType === 'branch') {
    return version
      .replace(/[^a-zA-Z0-9 ]/g, '') // keep only alphanumeric and space
      .toLowerCase()
      .replace(/ /g, '_');
  }
  return version;
}

/**
 * Return the semver to use for tessellation.
 * Branch: always "99.99.99" (mocked version).
 * Tag: the version as-is.
 *
 * Matches get_tessellation_version_semver() in scripts/utils/get-information.sh.
 */
export function getTessellationVersionSemver(
  version: string,
  refType: 'tag' | 'branch'
): string {
  return refType === 'branch' ? '99.99.99' : version;
}

/**
 * Compute the git checkout ref for a tessellation version.
 * Semver tags get a 'v' prefix. Branch names are used as-is.
 *
 * Matches get_checkout_tessellation_version() in scripts/utils/get-information.sh.
 */
export function getCheckoutTessellationVersion(version: string): string {
  const semverRegex =
    /^([0-9]+)\.([0-9]+)\.([0-9]+)(-([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$/;
  return semverRegex.test(version) ? `v${version}` : version;
}

// ---------------------------------------------------------------------------
// Metagraph ID polling
// ---------------------------------------------------------------------------

/**
 * Poll source/metagraph-l0/genesis/genesis.address until it is non-empty,
 * then write the metagraph ID into euclid.json.
 *
 * Matches get_metagraph_id_from_metagraph_l0_genesis() in get-information.sh.
 *
 * @param sourcePath - Absolute path to the source/ directory
 * @param rootPath   - Absolute path to the project root (where euclid.json lives)
 * @param maxRetries - How many times to retry (default: 51 to match bash)
 * @param sleepMs    - Sleep between retries in ms (default: 5000)
 * @returns The metagraph ID string
 */
export async function pollMetagraphId(
  sourcePath: string,
  rootPath: string,
  maxRetries = 51,
  sleepMs = 5000
): Promise<string> {
  const addressFile = path.join(sourcePath, 'metagraph-l0', 'genesis', 'genesis.address');

  for (let i = 1; i <= maxRetries; i++) {
    if (fs.existsSync(addressFile)) {
      const content = fs.readFileSync(addressFile, 'utf-8').trim();
      if (content) {
        // Write metagraph_id into euclid.json
        const euclidJsonPath = path.join(rootPath, 'euclid.json');
        const euclidJson = JSON.parse(fs.readFileSync(euclidJsonPath, 'utf-8')) as Record<string, unknown>;
        euclidJson['metagraph_id'] = content;
        fs.writeFileSync(euclidJsonPath, JSON.stringify(euclidJson, null, 2));
        return content;
      }
    }

    if (i === maxRetries) {
      throw new Error('Could not find the metagraph_id after maximum retries');
    }

    // Use direct stderr write to avoid circular import with logger
    process.stderr.write(`  · metagraph_id not found, retrying in ${sleepMs / 1000}s...\n`);
    await sleep(sleepMs);
  }

  throw new Error('Could not find the metagraph_id');
}

// ---------------------------------------------------------------------------
// P12 validation
// ---------------------------------------------------------------------------

/**
 * Verify that all node p12 files exist in source/p12-files/.
 *
 * Matches check_p12_files() in scripts/utils/validations.sh.
 *
 * @param sourcePath - Absolute path to the source/ directory
 * @param nodes      - Array of node definitions (from euclid config)
 * @returns Array of missing file names (empty if all present)
 */
export function checkP12Files(
  sourcePath: string,
  nodes: Array<{ key_file: { name: string } }>
): string[] {
  const p12Dir = path.join(sourcePath, 'p12-files');
  const missing: string[] = [];

  for (const node of nodes) {
    const p12Path = path.join(p12Dir, node.key_file.name);
    if (!fs.existsSync(p12Path)) {
      missing.push(node.key_file.name);
    }
  }

  return missing;
}

/**
 * Check whether a p12 file exists in source/p12-files/.
 */
export function p12FileExists(sourcePath: string, fileName: string): boolean {
  return fs.existsSync(path.join(sourcePath, 'p12-files', fileName));
}

// ---------------------------------------------------------------------------
// Project directory check
// ---------------------------------------------------------------------------

/**
 * Check whether source/project/<projectName> exists.
 *
 * Matches check_if_project_directory_exists() in validations.sh.
 */
export function projectDirectoryExists(sourcePath: string, projectName: string): boolean {
  return fs.existsSync(path.join(sourcePath, 'project', projectName));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
