/**
 * hydra remote install-monitoring-service — Clone and configure the monitoring service locally.
 *
 * Bash equivalent: install-monitoring-service() / install_monitoring_service() alias
 *                  → install_monitoring_service() in scripts/hydra-operations/install-monitoring-service.sh
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from '@oclif/core';
import { execa } from 'execa';
import { findConfigFile } from '../../config/loader.js';
import { loadAndValidateConfig } from '../../config/schema.js';
import { logger } from '../../utils/logger.js';

const MONITORING_REPO = 'https://github.com/Constellation-Labs/metagraph-monitoring-service';
const MONITORING_SERVICE_VERSION = '1.0.0';

/**
 * Update a JSON field if the value is non-empty.
 */
function updateJsonField(
  obj: Record<string, unknown>,
  dotPath: string,
  value: string
): void {
  if (!value) return;

  const parts = dotPath.replace(/^\./u, '').split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const match = part.match(/^(\w+)\[(\d+)\]$/u);

    if (match) {
      const arrayKey = match[1];
      const arrayIdx = Number.parseInt(match[2], 10);
      if (!Array.isArray(current[arrayKey])) {
        current[arrayKey] = [];
      }
      const arr = current[arrayKey] as Record<string, unknown>[];
      if (!arr[arrayIdx]) {
        arr[arrayIdx] = {};
      }
      current = arr[arrayIdx];
    } else {
      if (typeof current[part] !== 'object' || current[part] === null) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
  }

  const lastPart = parts[parts.length - 1];
  const lastMatch = lastPart.match(/^(\w+)\[(\d+)\]$/u);

  if (lastMatch) {
    const arrayKey = lastMatch[1];
    const arrayIdx = Number.parseInt(lastMatch[2], 10);
    if (!Array.isArray(current[arrayKey])) {
      current[arrayKey] = [];
    }
    (current[arrayKey] as unknown[])[arrayIdx] = value;
  } else {
    current[lastPart] = value;
  }
}

export default class InstallMonitoringService extends Command {
  static override id = 'remote:install-monitoring-service';

  static override description =
    'Download and configure the metagraph monitoring service locally';

  static override examples = [
    '<%= config.bin %> remote install-monitoring-service',
    '<%= config.bin %> install-monitoring-service',
    '<%= config.bin %> install_monitoring_service',
  ];

  static override aliases = [
    'install-monitoring-service',
    'install_monitoring_service',
    'remote:install_monitoring_service',
  ];

  async run(): Promise<void> {
    logger.section('INSTALL REMOTE MONITORING SERVICE');

    const configPath = findConfigFile(process.cwd());
    if (!configPath) {
      logger.error(
        '✖  Command failed: remote install-monitoring-service\n   Reason: euclid.json not found\n   Fix:    Run this command from inside an Euclid project directory'
      );
    }
    const rootPath = path.dirname(configPath!);
    const config = loadAndValidateConfig(configPath!);

    const infraPath = path.join(rootPath, 'infra');
    const sourcePath = path.join(rootPath, 'source');

    // Check genesis files exist (matches check_if_genesis_files_exists())
    const genesisAddressFile = path.join(infraPath, 'shared', 'genesis', 'genesis.address');
    if (!fs.existsSync(genesisAddressFile)) {
      logger.error(
        `✖  Command failed: remote install-monitoring-service\n   Reason: Genesis address file not found at ${genesisAddressFile}\n   Fix:    Run "hydra create-remote-genesis" or "hydra start-genesis" first`
      );
    }

    const metagraphId = fs.readFileSync(genesisAddressFile, 'utf-8').trim();
    if (!metagraphId) {
      logger.error(
        '✖  Command failed: remote install-monitoring-service\n   Reason: Genesis address file is empty\n   Fix:    Run genesis first to generate the metagraph ID'
      );
    }

    const projectName = config.projectName;
    const nodes = config.nodes;

    // Clone monitoring service repo
    const targetDir = path.join(sourcePath, 'metagraph-monitoring-service');
    if (fs.existsSync(targetDir)) {
      logger.error(
        `✖  Command failed: remote install-monitoring-service\n   Reason: Directory already exists: ${targetDir}\n   Fix:    Remove it first if you want to re-install`
      );
    }

    const cloneSpinner = logger.spin(
      `Downloading metagraph-monitoring-service to ${sourcePath}/metagraph-monitoring-service...`
    );
    try {
      await execa('git', ['clone', '--quiet', MONITORING_REPO], {
        cwd: sourcePath,
        stdio: 'inherit',
      });
      cloneSpinner.succeed('metagraph-monitoring-service downloaded');
    } catch (err) {
      cloneSpinner.fail('Failed to download monitoring service');
      logger.error(
        `✖  Command failed: remote install-monitoring-service\n   Reason: git clone failed — ${(err as Error).message}\n   Fix:    Check network connectivity`
      );
    }

    // Update package.json name field
    logger.step(`Updating project name in package.json`);
    const packageJsonPath = path.join(targetDir, 'package.json');
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, 'utf-8')
    ) as Record<string, unknown>;
    packageJson['name'] = `${projectName}-monitoring`;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    logger.success('package.json updated');

    // Update config.json fields
    logger.step('Updating config.json');
    const configJsonPath = path.join(targetDir, 'config', 'config.json');
    const configJson = JSON.parse(
      fs.readFileSync(configJsonPath, 'utf-8')
    ) as Record<string, unknown>;

    updateJsonField(configJson, '.metagraph.name', projectName);
    updateJsonField(configJson, '.metagraph.id', metagraphId);
    updateJsonField(configJson, '.metagraph.version', MONITORING_SERVICE_VERSION);

    if (nodes[0]) {
      updateJsonField(configJson, '.metagraph.nodes[0].key_file.name', nodes[0].key_file.name);
      updateJsonField(configJson, '.metagraph.nodes[0].key_file.alias', nodes[0].key_file.alias);
      updateJsonField(configJson, '.metagraph.nodes[0].key_file.password', nodes[0].key_file.password);
    }

    if (nodes[1]) {
      updateJsonField(configJson, '.metagraph.nodes[1].key_file.name', nodes[1].key_file.name);
      updateJsonField(configJson, '.metagraph.nodes[1].key_file.alias', nodes[1].key_file.alias);
      updateJsonField(configJson, '.metagraph.nodes[1].key_file.password', nodes[1].key_file.password);
    }

    if (nodes[2]) {
      updateJsonField(configJson, '.metagraph.nodes[2].key_file.name', nodes[2].key_file.name);
      updateJsonField(configJson, '.metagraph.nodes[2].key_file.alias', nodes[2].key_file.alias);
      updateJsonField(configJson, '.metagraph.nodes[2].key_file.password', nodes[2].key_file.password);
    }

    fs.writeFileSync(configJsonPath, JSON.stringify(configJson, null, 2));
    logger.success('config.json updated');

    // Remove .git directory
    const gitDir = path.join(targetDir, '.git');
    if (fs.existsSync(gitDir)) {
      fs.chmodSync(gitDir, 0o755);
      fs.rmSync(gitDir, { recursive: true, force: true });
    }

    logger.success('Monitoring service installed successfully.');
    logger.panel('Next Steps', [
      `1. Edit ${targetDir}/config/config.json to fill in:`,
      `   - .metagraph.nodes[*].ip, .username, .privateKeyPath`,
      `   - .network.name and .network.nodes[*] (GL0 peer info)`,
      `2. Run: hydra remote deploy-monitoring-service`,
      `3. Run: hydra remote start-monitoring-service`,
    ]);
  }
}
