/**
 * Dependency checker for the hydra CLI.
 *
 * Provides:
 *  - checkDependencies(deps)  — verify a list of tools are available in PATH
 *  - Pre-defined dependency lists per command group (LOCAL_DEPS, REMOTE_DEPS, etc.)
 *
 * Each tool entry describes how to check it and what install instructions to show.
 */

import { execFileSync } from 'node:child_process';
import { error, warn } from './logger.js';

// ---------------------------------------------------------------------------
// Tool descriptor
// ---------------------------------------------------------------------------

export interface ToolDescriptor {
  /** The name to display in messages */
  name: string;
  /**
   * Command to run to check presence.
   * First element is the binary, rest are arguments.
   * e.g. ['docker', '--version']
   */
  checkCommand: string[];
  /**
   * Optional: run a second verification pass (e.g. check version).
   * Return a string describing the version problem, or null if OK.
   */
  versionCheck?: (stdout: string) => string | null;
  /** Install instructions to display when the tool is missing */
  installHint: string;
  /**
   * If true, a missing tool is a warning rather than a fatal error.
   * Default: false (fatal).
   */
  optional?: boolean;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * Check for Docker (and enforce minimum version 26.0.0 matching bash validation).
 */
export const TOOL_DOCKER: ToolDescriptor = {
  name: 'docker',
  checkCommand: ['docker', '--version'],
  versionCheck: (stdout) => {
    // "Docker version 26.1.0, build ..." or "Docker version 25.0.0, ..."
    const match = stdout.match(/Docker version (\d+)\.(\d+)\.(\d+)/i);
    if (!match) return 'Cannot parse docker version string.';
    const [, major] = match.map(Number);
    if (major < 26) {
      return `Docker version ${match[1]}.${match[2]}.${match[3]} detected. Minimum required: 26.0.0.`;
    }
    return null;
  },
  installHint:
    'Install Docker from https://docs.docker.com/engine/install/ (minimum version 26.0.0 required)',
};

/**
 * docker compose (v2 plugin) — preferred.
 * Falls back gracefully if absent; TOOL_DOCKER_COMPOSE_V1 covers the legacy binary.
 */
export const TOOL_DOCKER_COMPOSE_V2: ToolDescriptor = {
  name: 'docker compose (v2)',
  checkCommand: ['docker', 'compose', 'version'],
  optional: true,
  installHint:
    'docker compose v2 is bundled with Docker Desktop and Docker Engine >= 23. ' +
    'If missing, install Docker Compose plugin: https://docs.docker.com/compose/install/',
};

/** docker-compose (v1 binary) — fallback */
export const TOOL_DOCKER_COMPOSE_V1: ToolDescriptor = {
  name: 'docker-compose',
  checkCommand: ['docker-compose', '--version'],
  optional: true,
  installHint:
    'Install docker-compose v1: https://docs.docker.com/compose/install/other/ or upgrade to Docker Engine >= 23 for v2.',
};

/** ansible-playbook (minimum 2.16 matching bash validation) */
export const TOOL_ANSIBLE_PLAYBOOK: ToolDescriptor = {
  name: 'ansible-playbook',
  checkCommand: ['ansible-playbook', '--version'],
  versionCheck: (stdout) => {
    // "ansible-playbook [core 2.16.0]" or "ansible-playbook 2.16.0"
    const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return 'Cannot parse ansible-playbook version.';
    const [, major, minor] = match.map(Number);
    if (major < 2 || (major === 2 && minor < 16)) {
      return `ansible-playbook ${match[1]}.${match[2]} detected. Minimum required: 2.16.`;
    }
    return null;
  },
  installHint:
    'Install Ansible >= 2.16: https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html\n' +
    '  pip install "ansible>=2.16"',
};

/** jq — JSON processor used to parse euclid.json in bash scripts */
export const TOOL_JQ: ToolDescriptor = {
  name: 'jq',
  checkCommand: ['jq', '--version'],
  installHint:
    'Install jq:\n' +
    '  macOS:  brew install jq\n' +
    '  Ubuntu: apt-get install jq\n' +
    '  https://stedolan.github.io/jq/download/',
};

/**
 * yq — must be Mike Farah's Go-based yq (not PyYAML yq).
 * Bash validation checks the output of `yq --version` for "mikefarah".
 */
export const TOOL_YQ: ToolDescriptor = {
  name: 'yq (mikefarah)',
  checkCommand: ['yq', '--version'],
  versionCheck: (stdout) => {
    if (!stdout.toLowerCase().includes('mikefarah') && !stdout.includes('yq (https://github.com/mikefarah/yq)')) {
      // Some distributions ship PyYAML's yq — that one is incompatible
      return (
        'The installed "yq" does not appear to be Mike Farah\'s Go-based yq. ' +
        'The PyYAML-based yq is incompatible with hydra.'
      );
    }
    return null;
  },
  installHint:
    'Install Mike Farah\'s yq (Go binary):\n' +
    '  macOS:  brew install yq\n' +
    '  Linux:  https://github.com/mikefarah/yq#install\n' +
    '  Binary releases: https://github.com/mikefarah/yq/releases',
};

/** ssh — OpenSSH client for remote log tailing */
export const TOOL_SSH: ToolDescriptor = {
  name: 'ssh',
  checkCommand: ['ssh', '-V'],
  installHint:
    'Install OpenSSH client:\n' +
    '  macOS: included by default\n' +
    '  Ubuntu: apt-get install openssh-client',
};

/** scp — used by remote-deploy for file transfers */
export const TOOL_SCP: ToolDescriptor = {
  name: 'scp',
  checkCommand: ['scp', '-V'],  // scp outputs to stderr; we just check exit code
  installHint:
    'Install scp (part of OpenSSH):\n' +
    '  macOS: included by default\n' +
    '  Ubuntu: apt-get install openssh-client',
};

/** curl — HTTP requests for status endpoints and seedlist fetch */
export const TOOL_CURL: ToolDescriptor = {
  name: 'curl',
  checkCommand: ['curl', '--version'],
  installHint:
    'Install curl:\n' +
    '  macOS:  brew install curl\n' +
    '  Ubuntu: apt-get install curl',
};

/** git — used for template install, update, and ref checking */
export const TOOL_GIT: ToolDescriptor = {
  name: 'git',
  checkCommand: ['git', '--version'],
  installHint:
    'Install git:\n' +
    '  macOS:  brew install git  (or Xcode Command Line Tools)\n' +
    '  Ubuntu: apt-get install git\n' +
    '  https://git-scm.com/downloads',
};

/** ansible — needed for check_ansible() version validation */
export const TOOL_ANSIBLE: ToolDescriptor = {
  name: 'ansible',
  checkCommand: ['ansible', '--version'],
  installHint:
    'Install Ansible >= 2.16: pip install "ansible>=2.16"',
};

// ---------------------------------------------------------------------------
// Dependency groups per command
// ---------------------------------------------------------------------------

/**
 * Dependencies for local commands:
 * build, start-genesis, start-rollback, stop, destroy, purge, status, logs.
 */
export const LOCAL_DEPS: ToolDescriptor[] = [
  TOOL_DOCKER,
  TOOL_DOCKER_COMPOSE_V2,   // optional — fallback to v1 at runtime
  TOOL_DOCKER_COMPOSE_V1,   // optional — only one of v1/v2 needs to exist
  TOOL_ANSIBLE_PLAYBOOK,
  TOOL_JQ,
  TOOL_YQ,
];

/**
 * Dependencies for remote commands:
 * remote-deploy, remote-start, remote-status, remote-logs, remote-snapshot-fee-config,
 * create-remote-genesis.
 */
export const REMOTE_DEPS: ToolDescriptor[] = [
  TOOL_DOCKER,
  TOOL_ANSIBLE_PLAYBOOK,
  TOOL_JQ,
  TOOL_YQ,
  TOOL_SSH,
  TOOL_SCP,
  TOOL_CURL,
];

/**
 * Dependencies for monitoring commands:
 * install-monitoring-service, remote-deploy-monitoring-service, remote-start-monitoring-service.
 */
export const MONITORING_DEPS: ToolDescriptor[] = [
  TOOL_ANSIBLE_PLAYBOOK,
  TOOL_SSH,
  TOOL_CURL,
];

/**
 * Dependencies for scaffolding commands:
 * install, install-template, update.
 */
export const INSTALL_DEPS: ToolDescriptor[] = [
  TOOL_GIT,
  TOOL_JQ,
];

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

export interface DependencyCheckResult {
  /** True if all non-optional deps are present and version-compatible */
  ok: boolean;
  /** Missing required tools */
  missing: ToolDescriptor[];
  /** Present but version-incompatible tools */
  versionErrors: Array<{ tool: ToolDescriptor; message: string }>;
  /** Missing optional tools (informational) */
  missingOptional: ToolDescriptor[];
}

/**
 * Check that all tools in `deps` are available in PATH.
 *
 * For docker compose, exactly one of v1 or v2 must be present (special-cased below).
 *
 * @param deps - List of ToolDescriptors to check. Pass one of the pre-defined lists
 *               (LOCAL_DEPS, REMOTE_DEPS, etc.) or build a custom list.
 * @param silent - If true, suppress console output (useful for tests).
 * @returns DependencyCheckResult with details.
 *
 * @example
 * const result = checkDependencies(LOCAL_DEPS);
 * if (!result.ok) process.exit(1);
 */
export function checkDependencies(
  deps: ToolDescriptor[],
  silent = false
): DependencyCheckResult {
  const missing: ToolDescriptor[] = [];
  const versionErrors: Array<{ tool: ToolDescriptor; message: string }> = [];
  const missingOptional: ToolDescriptor[] = [];

  for (const tool of deps) {
    const result = checkSingleTool(tool);

    if (result.type === 'missing') {
      if (tool.optional) {
        missingOptional.push(tool);
      } else {
        missing.push(tool);
        if (!silent) {
          error(`Missing required tool: ${tool.name}`);
          error(`  Install: ${tool.installHint}`);
        }
      }
    } else if (result.type === 'version_error') {
      versionErrors.push({ tool, message: result.message });
      if (!silent) {
        error(`Version requirement not met for ${tool.name}: ${result.message}`);
        error(`  Install: ${tool.installHint}`);
      }
    }
  }

  // Special case: docker compose — exactly one of v1 or v2 is sufficient
  const hasDockerComposeV2 = !missingOptional.some((t) => t === TOOL_DOCKER_COMPOSE_V2);
  const hasDockerComposeV1 = !missingOptional.some((t) => t === TOOL_DOCKER_COMPOSE_V1);
  const wantsDockerCompose =
    deps.includes(TOOL_DOCKER_COMPOSE_V2) || deps.includes(TOOL_DOCKER_COMPOSE_V1);

  if (wantsDockerCompose && !hasDockerComposeV2 && !hasDockerComposeV1) {
    // Neither found — escalate to required error
    if (!silent) {
      error('Neither "docker compose" (v2) nor "docker-compose" (v1) was found.');
      error(
        '  Install Docker Compose: https://docs.docker.com/compose/install/'
      );
    }
    // Add a synthetic entry so callers know
    missing.push({
      name: 'docker compose (v1 or v2)',
      checkCommand: [],
      installHint: 'https://docs.docker.com/compose/install/',
    });
  } else if (wantsDockerCompose && !hasDockerComposeV2) {
    if (!silent) {
      warn(
        'docker compose v2 not found; falling back to docker-compose v1. ' +
          'Consider upgrading Docker for v2 support.'
      );
    }
  }

  const ok = missing.length === 0 && versionErrors.length === 0;
  return { ok, missing, versionErrors, missingOptional };
}

/**
 * Like checkDependencies() but throws on failure.
 *
 * @throws Error listing all missing / version-incompatible tools.
 */
export function requireDependencies(deps: ToolDescriptor[]): void {
  const result = checkDependencies(deps);
  if (!result.ok) {
    const problems: string[] = [];
    for (const t of result.missing) {
      problems.push(`Missing: ${t.name}\n    Install: ${t.installHint}`);
    }
    for (const { tool, message } of result.versionErrors) {
      problems.push(`Version error (${tool.name}): ${message}\n    Install: ${tool.installHint}`);
    }
    throw new Error(
      `Dependency check failed:\n${problems.map((p) => `  • ${p}`).join('\n')}`
    );
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

type ToolCheckResult =
  | { type: 'ok'; stdout: string }
  | { type: 'missing' }
  | { type: 'version_error'; message: string };

function checkSingleTool(tool: ToolDescriptor): ToolCheckResult {
  if (tool.checkCommand.length === 0) {
    return { type: 'missing' };
  }

  const [bin, ...args] = tool.checkCommand;

  let stdout: string;
  try {
    // scp -V writes to stderr; stdio: 'pipe' captures both
    const output = execFileSync(bin!, args, {
      stdio: 'pipe',
      timeout: 5000,
      encoding: 'utf-8',
    });
    // execFileSync returns stdout; for scp -V we need stderr too
    stdout = typeof output === 'string' ? output : '';
  } catch (err: unknown) {
    // Some tools (scp) write version to stderr and exit 1 — check if stderr has content
    const execErr = err as { stderr?: string | Buffer; status?: number };
    if (execErr.stderr) {
      stdout = Buffer.isBuffer(execErr.stderr)
        ? execErr.stderr.toString('utf-8')
        : String(execErr.stderr);
      // If we got stderr content, the binary exists
    } else {
      // Binary truly not found (ENOENT)
      return { type: 'missing' };
    }
  }

  if (tool.versionCheck) {
    const versionProblem = tool.versionCheck(stdout);
    if (versionProblem) {
      return { type: 'version_error', message: versionProblem };
    }
  }

  return { type: 'ok', stdout };
}
