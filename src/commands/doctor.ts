/**
 * hydra doctor — Environment health check.
 *
 * Runs a series of checks and prints a full health report.
 * This is the first command users should run after cloning the repo.
 *
 * Usage: hydra doctor
 *
 * Checks:
 *   1. Node.js version (warn <18, error <16)
 *   2. Docker running (docker info)
 *   3. docker compose (v2 or v1 fallback)
 *   4. ansible-playbook (with install hint if missing)
 *   5. euclid.json (exists and validates)
 *   6. p12 files (count in source/p12-files/)
 *   7. githubToken (non-empty in euclid.json)
 *   8. SSH key (~/.ssh/id_rsa or ~/.ssh/id_ed25519)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from '@oclif/core';
import chalk from 'chalk';
import { execa } from 'execa';

import { findConfigFile, loadConfig } from '../config/loader.js';
import type { EuclidConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CheckStatus = 'ok' | 'warn' | 'error';

interface CheckResult {
  label: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LABEL_WIDTH = 14;

function renderLine(result: CheckResult): string {
  const icon =
    result.status === 'ok'
      ? chalk.green('✔')
      : result.status === 'warn'
        ? chalk.yellow('⚠')
        : chalk.red('✖');
  const detail = result.hint ? `${result.detail}  → ${result.hint}` : result.detail;
  return `  ${icon}  ${result.label.padEnd(LABEL_WIDTH)} ${detail}`;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/** 1. Node.js version — warn if <18, error if <16 */
function checkNode(): CheckResult {
  const versionStr = process.version;
  const parts = versionStr.slice(1).split('.');
  const major = parseInt(parts[0] ?? '0', 10);
  if (major >= 18) {
    return { label: 'Node.js', status: 'ok', detail: `${versionStr}   (≥18 required)` };
  }
  if (major >= 16) {
    return {
      label: 'Node.js',
      status: 'warn',
      detail: `${versionStr}   (≥18 recommended)`,
      hint: 'upgrade to Node.js 18+',
    };
  }
  return {
    label: 'Node.js',
    status: 'error',
    detail: `${versionStr}   (≥18 required)`,
    hint: 'upgrade Node.js from https://nodejs.org',
  };
}

/** 2. Docker running — docker info exit code 0 */
async function checkDocker(): Promise<CheckResult> {
  try {
    const infoResult = await execa('docker', ['info'], { reject: false, env: process.env });
    if (infoResult.exitCode !== 0) {
      return {
        label: 'Docker',
        status: 'error',
        detail: 'not running',
        hint: 'start Docker Desktop or: sudo systemctl start docker',
      };
    }
    const vResult = await execa(
      'docker',
      ['version', '--format', '{{.Server.Version}}'],
      { reject: false, env: process.env }
    );
    const version = vResult.exitCode === 0 ? vResult.stdout.trim() : '';
    return {
      label: 'Docker',
      status: 'ok',
      detail: version ? `running    (v${version})` : 'running',
    };
  } catch {
    return {
      label: 'Docker',
      status: 'error',
      detail: 'not running',
      hint: 'start Docker Desktop or: sudo systemctl start docker',
    };
  }
}

/** 3. docker compose — v2 plugin or v1 standalone fallback */
async function checkDockerCompose(): Promise<CheckResult> {
  try {
    const v2 = await execa('docker', ['compose', 'version'], { reject: false, env: process.env });
    if (v2.exitCode === 0) {
      return { label: 'docker compose', status: 'ok', detail: 'available' };
    }
    const v1 = await execa('docker-compose', ['--version'], {
      reject: false,
      env: process.env,
    });
    if (v1.exitCode === 0) {
      return { label: 'docker compose', status: 'ok', detail: 'available (v1)' };
    }
    return {
      label: 'docker compose',
      status: 'error',
      detail: 'not found',
      hint: 'install docker compose plugin',
    };
  } catch {
    return {
      label: 'docker compose',
      status: 'error',
      detail: 'not found',
      hint: 'install docker compose plugin',
    };
  }
}

/** 4. ansible-playbook — check binary + version */
async function checkAnsible(): Promise<CheckResult> {
  try {
    const vResult = await execa('ansible-playbook', ['--version'], {
      reject: false,
      env: process.env,
    });
    if (vResult.exitCode !== 0) {
      return {
        label: 'Ansible',
        status: 'warn',
        detail: 'not found',
        hint: 'pip install ansible',
      };
    }
    const firstLine = (vResult.stdout.split('\n')[0] ?? '').trim();
    const vMatch = firstLine.match(/(\d+\.\d+\.\d+[\w.-]*)/);
    const version = vMatch ? vMatch[1] : '';
    return {
      label: 'Ansible',
      status: 'ok',
      detail: version ? `found      (v${version})` : 'found',
    };
  } catch {
    return {
      label: 'Ansible',
      status: 'warn',
      detail: 'not found',
      hint: 'pip install ansible',
    };
  }
}

/** 5. euclid.json — attempt to parse and validate with Zod */
function checkEuclid(configPath: string | null): {
  result: CheckResult;
  config: EuclidConfig | null;
} {
  if (!configPath) {
    return {
      result: {
        label: 'euclid.json',
        status: 'error',
        detail: 'not found',
        hint: 'run from inside a euclid project directory',
      },
      config: null,
    };
  }
  try {
    const config = loadConfig(configPath);
    return {
      result: { label: 'euclid.json', status: 'ok', detail: 'valid' },
      config,
    };
  } catch (err) {
    const detail = (err as Error).message.split('\n')[0] ?? 'invalid config';
    return {
      result: {
        label: 'euclid.json',
        status: 'error',
        detail: 'invalid',
        hint: detail,
      },
      config: null,
    };
  }
}

/** 6. p12 files — count .p12 files in source/p12-files/ */
function checkP12Files(projectRoot: string | null): CheckResult {
  if (!projectRoot) {
    return {
      label: 'p12 files',
      status: 'warn',
      detail: 'cannot check (euclid.json not found)',
    };
  }
  const p12Dir = path.join(projectRoot, 'source', 'p12-files');
  if (!fs.existsSync(p12Dir)) {
    return {
      label: 'p12 files',
      status: 'warn',
      detail: '0 found in source/p12-files/',
      hint: 'add .p12 key files to source/p12-files/',
    };
  }
  const files = fs.readdirSync(p12Dir).filter((f) => f.endsWith('.p12'));
  if (files.length === 0) {
    return {
      label: 'p12 files',
      status: 'warn',
      detail: '0 found in source/p12-files/',
      hint: 'add .p12 key files to source/p12-files/',
    };
  }
  return {
    label: 'p12 files',
    status: 'ok',
    detail: `${files.length} found in source/p12-files/`,
  };
}

/** 7. githubToken — non-empty string in euclid.json */
function checkGithubToken(config: EuclidConfig | null): CheckResult {
  if (!config) {
    return {
      label: 'githubToken',
      status: 'warn',
      detail: 'cannot check (invalid config)',
    };
  }
  const token = config.githubToken ?? '';
  if (!token.trim()) {
    return {
      label: 'githubToken',
      status: 'error',
      detail: 'empty',
      hint: 'Required for install and install-template',
    };
  }
  return { label: 'githubToken', status: 'ok', detail: 'set' };
}

/** 8. SSH key — ~/.ssh/id_rsa or ~/.ssh/id_ed25519 */
function checkSshKey(): CheckResult {
  const home = os.homedir();
  for (const keyName of ['id_rsa', 'id_ed25519']) {
    const keyPath = path.join(home, '.ssh', keyName);
    if (fs.existsSync(keyPath)) {
      return { label: 'SSH key', status: 'ok', detail: `~/.ssh/${keyName} found` };
    }
  }
  return {
    label: 'SSH key',
    status: 'warn',
    detail: 'not found',
    hint: 'generate with: ssh-keygen -t ed25519',
  };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export default class Doctor extends Command {
  static override id = 'doctor';

  static override description =
    'Check your environment for common issues — run this first after cloning';

  static override examples = ['<%= config.bin %> doctor'];

  async run(): Promise<void> {
    const spinner = logger.spin('Checking your environment...');

    // Load config synchronously — needed by p12Files and githubToken checks
    const configPath = findConfigFile();
    const euclidCheck = checkEuclid(configPath);
    const projectRoot = configPath ? path.dirname(configPath) : null;

    // Run all checks in parallel; synchronous checks wrapped in Promise.resolve
    const [nodeResult, dockerResult, composeResult, ansibleResult, p12Result, sshResult] =
      await Promise.all([
        Promise.resolve(checkNode()),
        checkDocker(),
        checkDockerCompose(),
        checkAnsible(),
        Promise.resolve(checkP12Files(projectRoot)),
        Promise.resolve(checkSshKey()),
      ]);

    // Synchronous checks that depend on already-loaded config
    const githubResult = checkGithubToken(euclidCheck.config);

    spinner.stop();

    // Collect results in fixed display order
    const results: CheckResult[] = [
      nodeResult,
      dockerResult,
      composeResult,
      ansibleResult,
      euclidCheck.result,
      p12Result,
      githubResult,
      sshResult,
    ];

    // Count issues — both warn and error count as issues
    const issueCount = results.filter((r) => r.status !== 'ok').length;
    const lines = results.map(renderLine);

    const summary =
      issueCount === 0
        ? chalk.green('  All checks passed.')
        : chalk.yellow(
            `  ${issueCount} issue${issueCount === 1 ? '' : 's'} found. Run the commands above to fix them.`
          );

    lines.push('');
    lines.push(summary);

    logger.panel('Environment Health Check', lines);
  }
}
