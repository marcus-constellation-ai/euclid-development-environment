/**
 * hydra version — Print hydra version and environment information.
 *
 * Usage: hydra version
 *
 * Prints a full info block including versions of key tools,
 * platform details, euclid.json validity, Docker status, and
 * ansible-playbook availability.
 */
import { Command } from '@oclif/core';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import chalk from 'chalk';
import { execa } from 'execa';

import { findConfigFile, loadConfig } from '../config/loader.js';

const _require = createRequire(import.meta.url);
const _dir = path.dirname(fileURLToPath(import.meta.url));

const LABEL_WIDTH = 15;

/**
 * Load version string from package.json at runtime.
 * Never hardcoded — always reflects the installed package version.
 */
function pkgVersion(): string {
  try {
    const pkg = _require(path.resolve(_dir, '..', '..', 'package.json')) as {
      version?: string;
    };
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

export default class VersionCommand extends Command {
  static override id = 'version';

  static override description = 'Print hydra version and environment information';

  static override examples = ['<%= config.bin %> version'];

  async run(): Promise<void> {
    const version = pkgVersion();
    const lines: string[] = [];

    // hydra
    lines.push(`  ${chalk.bold('hydra'.padEnd(LABEL_WIDTH))} v${version}`);

    // node
    lines.push(`  ${chalk.bold('node'.padEnd(LABEL_WIDTH))} ${process.version}`);

    // platform
    lines.push(
      `  ${chalk.bold('platform'.padEnd(LABEL_WIDTH))} ${process.platform} ${process.arch}`
    );

    // euclid.json — attempt loadConfig(); show ✔ valid or ✖ invalid
    const configPath = findConfigFile();
    if (!configPath) {
      lines.push(
        `  ${chalk.bold('euclid.json'.padEnd(LABEL_WIDTH))} ${chalk.red('✖')} not found`
      );
    } else {
      try {
        loadConfig(configPath);
        lines.push(
          `  ${chalk.bold('euclid.json'.padEnd(LABEL_WIDTH))} ${chalk.green('✔')} valid`
        );
      } catch (err) {
        const detail = (err as Error).message.split('\n')[0] ?? 'invalid';
        lines.push(
          `  ${chalk.bold('euclid.json'.padEnd(LABEL_WIDTH))} ${chalk.red('✖')} invalid  ` +
            chalk.dim(detail)
        );
      }
    }

    // docker — run docker version --format '{{.Server.Version}}'
    try {
      const dockerResult = await execa(
        'docker',
        ['version', '--format', '{{.Server.Version}}'],
        { reject: false, env: process.env }
      );
      if (dockerResult.exitCode === 0 && dockerResult.stdout.trim()) {
        const dv = dockerResult.stdout.trim();
        lines.push(
          `  ${chalk.bold('docker'.padEnd(LABEL_WIDTH))} ${chalk.green('✔')} running (v${dv})`
        );
      } else {
        lines.push(
          `  ${chalk.bold('docker'.padEnd(LABEL_WIDTH))} ${chalk.red('✖')} not running`
        );
      }
    } catch {
      lines.push(`  ${chalk.bold('docker'.padEnd(LABEL_WIDTH))} ${chalk.red('✖')} not running`);
    }

    // ansible-playbook — run ansible-playbook --version | head -1
    try {
      const ansibleResult = await execa('ansible-playbook', ['--version'], {
        reject: false,
        env: process.env,
      });
      if (ansibleResult.exitCode === 0) {
        const firstLine = (ansibleResult.stdout.split('\n')[0] ?? '').trim();
        const vMatch = firstLine.match(/(\d+\.\d+\.\d+[\w.-]*)/);
        const av = vMatch ? vMatch[1] : firstLine;
        lines.push(
          `  ${chalk.bold('ansible'.padEnd(LABEL_WIDTH))} ${chalk.green('✔')} found  (v${av})`
        );
      } else {
        lines.push(
          `  ${chalk.bold('ansible'.padEnd(LABEL_WIDTH))} ${chalk.gray('✖ not found')}`
        );
      }
    } catch {
      lines.push(`  ${chalk.bold('ansible'.padEnd(LABEL_WIDTH))} ${chalk.gray('✖ not found')}`);
    }

    for (const line of lines) {
      process.stdout.write(line + '\n');
    }
  }
}
