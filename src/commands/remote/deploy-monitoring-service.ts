/**
 * hydra remote deploy-monitoring-service — Deploy monitoring service to remote host via Ansible.
 *
 * Bash equivalent: remote-deploy-monitoring-service() / remote_deploy_monitoring_service() alias
 *                  → remote_deploy_monitoring_service() in
 *                    scripts/hydra-operations/remote-deploy-monitoring-service.sh
 *
 * Pre-flight checks:
 *   1. Validate monitoring host file (IP, SSH key)
 *   2. Validate config.json has all required fields
 *   3. Validate all privateKeyPath files exist locally
 *
 * Ansible invocation (exact match of bash):
 *   ANSIBLE_DEPRECATION_WARNINGS=False
 *   ansible-playbook -i <hostsFile> <monitoringDeployPlaybook>
 *
 * Required fields in metagraph-monitoring-service/config/config.json:
 *   .metagraph.id, .metagraph.name, .metagraph.version, .network.name,
 *   .metagraph.nodes[0..2].ip/username/privateKeyPath,
 *   .network.nodes[0..2].ip/port/id
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from '@oclif/core';
import { findConfigFile } from '../../config/loader.js';
import { loadAndValidateConfig } from '../../config/schema.js';
import { logger } from '../../utils/logger.js';
import { runPlaybook, checkMonitoringHostFile } from '../../utils/ansible.js';

/** Required fields in the monitoring service config.json */
const REQUIRED_CONFIG_FIELDS = [
  '.metagraph.id',
  '.metagraph.name',
  '.metagraph.version',
  '.network.name',
  '.metagraph.nodes[0].ip',
  '.metagraph.nodes[0].username',
  '.metagraph.nodes[0].privateKeyPath',
  '.metagraph.nodes[1].ip',
  '.metagraph.nodes[1].username',
  '.metagraph.nodes[1].privateKeyPath',
  '.metagraph.nodes[2].ip',
  '.metagraph.nodes[2].username',
  '.metagraph.nodes[2].privateKeyPath',
  '.network.nodes[0].ip',
  '.network.nodes[0].port',
  '.network.nodes[0].id',
  '.network.nodes[1].ip',
  '.network.nodes[1].port',
  '.network.nodes[1].id',
  '.network.nodes[2].ip',
  '.network.nodes[2].port',
  '.network.nodes[2].id',
];

/**
 * Resolve a dot-path like ".metagraph.nodes[0].ip" into a value from a JSON object.
 */
function resolveJsonPath(obj: unknown, dotPath: string): unknown {
  const parts = dotPath.replace(/^\./u, '').split('.');

  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/u);
    if (arrayMatch) {
      const key = arrayMatch[1];
      const idx = Number.parseInt(arrayMatch[2], 10);
      current = (current as Record<string, unknown[]>)[key]?.[idx];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  return current;
}

/**
 * Validate that all required fields in config.json are non-empty.
 */
function validateMonitoringConfig(
  configJson: unknown,
  configJsonPath: string
): void {
  const emptyFields: string[] = [];

  for (const field of REQUIRED_CONFIG_FIELDS) {
    const value = resolveJsonPath(configJson, field);
    if (value === null || value === undefined || value === '') {
      emptyFields.push(field);
    }
  }

  if (emptyFields.length > 0) {
    throw new Error(
      `Error: The following fields are empty and required in ${configJsonPath}:\n` +
        emptyFields.map((f) => `  - ${f}`).join('\n') +
        '\n\nEdit config.json and fill in all required fields before deploying.'
    );
  }
}

/**
 * Validate that all privateKeyPath files referenced in config.json exist on disk.
 */
function validatePrivateKeyPaths(
  configJson: Record<string, unknown>,
  monitoringServiceDir: string
): void {
  const metagraphNodes = (
    (configJson['metagraph'] as Record<string, unknown>)?.['nodes'] as Array<Record<string, unknown>>
  ) ?? [];

  const missingPaths: string[] = [];

  for (const node of metagraphNodes) {
    const keyPath = node['privateKeyPath'] as string | undefined;
    if (!keyPath) continue;

    const fullPath = path.join(monitoringServiceDir, keyPath);
    if (!fs.existsSync(fullPath)) {
      missingPaths.push(fullPath);
    }
  }

  if (missingPaths.length > 0) {
    throw new Error(
      `There were ${missingPaths.length} missing privateKeyPath file(s):\n` +
        missingPaths.map((p) => `  - ${p}`).join('\n') +
        '\n\nCopy the SSH private key files to the monitoring service directory.'
    );
  }
}

export default class DeployMonitoringService extends Command {
  static override id = 'remote:deploy-monitoring-service';

  static override description =
    'Deploy the metagraph monitoring service to the remote monitoring host via Ansible';

  static override examples = [
    '<%= config.bin %> remote deploy-monitoring-service',
    '<%= config.bin %> remote-deploy-monitoring-service',
    '<%= config.bin %> remote_deploy_monitoring_service',
  ];

  static override aliases = [
    'remote-deploy-monitoring-service',
    'remote_deploy_monitoring_service',
    'remote:remote-deploy-monitoring-service',
    'remote:remote_deploy_monitoring_service',
  ];

  async run(): Promise<void> {
    logger.section('REMOTE DEPLOY MONITORING SERVICE');

    const configPath = findConfigFile(process.cwd());
    if (!configPath) {
      logger.error(
        '✖  Command failed: remote deploy-monitoring-service\n   Reason: euclid.json not found\n   Fix:    Run this command from inside an Euclid project directory'
      );
    }
    const rootPath = path.dirname(configPath!);
    const config = loadAndValidateConfig(configPath!);

    const sourcePath = path.join(rootPath, 'source');
    const hostsFile = path.resolve(rootPath, config.deploy.ansible.hosts);
    const deployPlaybook = path.resolve(
      rootPath,
      config.deploy.ansible.monitoring.playbooks.deploy
    );

    // Validate monitoring host (IP, SSH key in agent)
    await checkMonitoringHostFile(hostsFile);

    // Validate monitoring service config.json
    const monitoringServiceDir = path.join(sourcePath, 'metagraph-monitoring-service');
    const configJsonPath = path.join(monitoringServiceDir, 'config', 'config.json');

    if (!fs.existsSync(configJsonPath)) {
      logger.error(
        `✖  Command failed: remote deploy-monitoring-service\n   Reason: config.json not found at ${configJsonPath}\n   Fix:    Run "hydra install-monitoring-service" first, then fill in config.json`
      );
    }

    const configJson = JSON.parse(fs.readFileSync(configJsonPath, 'utf-8')) as Record<string, unknown>;

    try {
      validateMonitoringConfig(configJson, configJsonPath);
      validatePrivateKeyPaths(configJson, monitoringServiceDir);
    } catch (err) {
      logger.error(
        `✖  Command failed: remote deploy-monitoring-service\n   Reason: ${(err as Error).message}\n   Fix:    Edit config.json at ${configJsonPath}`
      );
    }

    const spinner = logger.spin('Deploying monitoring service on remote host...');
    try {
      await runPlaybook(deployPlaybook, {}, hostsFile, {
        SOURCE_PATH: sourcePath,
      });
      spinner.succeed('Monitoring service deployed');
    } catch (err) {
      spinner.fail('Monitoring service deploy failed');
      logger.error(
        `✖  Command failed: remote deploy-monitoring-service\n   Reason: Ansible playbook failed — ${(err as Error).message}\n   Fix:    Check Ansible output above and verify SSH keys are loaded`
      );
    }

    logger.success('Monitoring service deployed successfully.');
  }
}
