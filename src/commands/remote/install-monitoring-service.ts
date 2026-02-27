/**
 * hydra remote install-monitoring-service — Clone and configure the monitoring service locally.
 *
 * Bash equivalent: install-monitoring-service() / install_monitoring_service() alias
 *                  → install_monitoring_service() in scripts/hydra-operations/install-monitoring-service.sh
 *
 * Operations:
 *   1. Check that infra/shared/genesis/genesis.address exists (genesis must have run)
 *   2. Read metagraph_id from infra/shared/genesis/genesis.address
 *   3. Clone metagraph-monitoring-service into source/metagraph-monitoring-service/
 *   4. Update metagraph-monitoring-service/package.json: name = "<project>-monitoring"
 *   5. Update metagraph-monitoring-service/config/config.json with:
 *      - .metagraph.name = project_name
 *      - .metagraph.id = metagraph_id
 *      - .metagraph.version = "1.0.0"
 *      - .metagraph.nodes[0..2].key_file.name/alias/password from euclid.json nodes
 *   6. Remove .git directory from cloned repo
 *
 * After this command, edit metagraph-monitoring-service/config/config.json
 * to fill in node IPs, usernames, private key paths, and network details.
 * Then run: hydra remote deploy-monitoring-service
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from '@oclif/core';
import { execa } from 'execa';
import { loadConfig, findConfigFile } from '../../config/loader.js';
import { header, success, info } from '../../utils/logger.js';

const MONITORING_REPO = 'https://github.com/Constellation-Labs/metagraph-monitoring-service';
const MONITORING_SERVICE_VERSION = '1.0.0';

/**
 * Update a JSON field if the value is non-empty.
 * Matches update_json_if_not_empty() in install-monitoring-service.sh.
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
    header('INSTALL REMOTE MONITORING SERVICE');

    const configPath = findConfigFile(process.cwd());
    if (!configPath) {
      this.error(
        'Could not find euclid.json. Run this command from inside an Euclid project directory.'
      );
    }
    const rootPath = path.dirname(configPath);
    const config = loadConfig(configPath);

    const infraPath = path.join(rootPath, 'infra');
    const sourcePath = path.join(rootPath, 'source');

    // Check genesis files exist (matches check_if_genesis_files_exists())
    const genesisAddressFile = path.join(infraPath, 'shared', 'genesis', 'genesis.address');
    if (!fs.existsSync(genesisAddressFile)) {
      this.error(
        `Genesis address file not found: ${genesisAddressFile}\n` +
          'Please run "hydra create-remote-genesis" or "hydra start-genesis" first.'
      );
    }

    const metagraphId = fs.readFileSync(genesisAddressFile, 'utf-8').trim();
    if (!metagraphId) {
      this.error('Genesis address file is empty. Please run genesis first.');
    }

    const projectName = config.project_name;
    const nodes = config.nodes;

    // Clone monitoring service repo
    const targetDir = path.join(sourcePath, 'metagraph-monitoring-service');
    if (fs.existsSync(targetDir)) {
      this.error(
        `Directory already exists: ${targetDir}\n` +
          'Remove it first if you want to re-install.'
      );
    }

    info(`Downloading the metagraph-monitoring-service under directory ${sourcePath}/metagraph-monitoring-service`);
    this.log('');

    await execa('git', ['clone', '--quiet', MONITORING_REPO], {
      cwd: sourcePath,
      stdio: 'inherit',
    });

    success('metagraph-monitoring-service downloaded');

    // Update package.json name field
    info(`Updating project name in metagraph-monitoring-service/package.json`);
    const packageJsonPath = path.join(targetDir, 'package.json');
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, 'utf-8')
    ) as Record<string, unknown>;
    packageJson['name'] = `${projectName}-monitoring`;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    success('Updated');

    // Update config.json fields
    info('Updating the config.json');
    const configJsonPath = path.join(targetDir, 'config', 'config.json');
    const configJson = JSON.parse(
      fs.readFileSync(configJsonPath, 'utf-8')
    ) as Record<string, unknown>;

    // Matches the update_json_if_not_empty calls in install-monitoring-service.sh
    updateJsonField(configJson, '.metagraph.name', projectName);
    updateJsonField(configJson, '.metagraph.id', metagraphId);
    updateJsonField(configJson, '.metagraph.version', MONITORING_SERVICE_VERSION);

    // Node 0 (genesis node)
    if (nodes[0]) {
      updateJsonField(configJson, '.metagraph.nodes[0].key_file.name', nodes[0].key_file.name);
      updateJsonField(configJson, '.metagraph.nodes[0].key_file.alias', nodes[0].key_file.alias);
      updateJsonField(configJson, '.metagraph.nodes[0].key_file.password', nodes[0].key_file.password);
    }

    // Node 1
    if (nodes[1]) {
      updateJsonField(configJson, '.metagraph.nodes[1].key_file.name', nodes[1].key_file.name);
      updateJsonField(configJson, '.metagraph.nodes[1].key_file.alias', nodes[1].key_file.alias);
      updateJsonField(configJson, '.metagraph.nodes[1].key_file.password', nodes[1].key_file.password);
    }

    // Node 2
    if (nodes[2]) {
      updateJsonField(configJson, '.metagraph.nodes[2].key_file.name', nodes[2].key_file.name);
      updateJsonField(configJson, '.metagraph.nodes[2].key_file.alias', nodes[2].key_file.alias);
      updateJsonField(configJson, '.metagraph.nodes[2].key_file.password', nodes[2].key_file.password);
    }

    fs.writeFileSync(configJsonPath, JSON.stringify(configJson, null, 2));
    success('config.json updated');

    // Remove .git directory (matches bash: chmod -R +w ... && rm -r ...)
    const gitDir = path.join(targetDir, '.git');
    if (fs.existsSync(gitDir)) {
      fs.chmodSync(gitDir, 0o755);
      fs.rmSync(gitDir, { recursive: true, force: true });
    }

    this.log('');
    success('Monitoring service installed successfully.');
    info(
      `Next steps:\n` +
        `  1. Edit ${targetDir}/config/config.json to fill in:\n` +
        `     - .metagraph.nodes[*].ip, .username, .privateKeyPath\n` +
        `     - .network.name and .network.nodes[*] (GL0 peer info)\n` +
        `  2. Run: hydra remote deploy-monitoring-service\n` +
        `  3. Run: hydra remote start-monitoring-service`
    );
  }
}
