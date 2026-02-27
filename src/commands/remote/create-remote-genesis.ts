/**
 * hydra remote create-remote-genesis — Generate genesis files locally for remote deployment.
 *
 * Bash equivalent: create-remote-genesis() / create_remote_genesis() alias
 *                  → start_containers_remote_genesis(true) in
 *                    scripts/hydra-operations/create-remote-genesis.sh
 */
import * as path from 'node:path';
import { Command } from '@oclif/core';
import { findConfigFile } from '../../config/loader.js';
import { loadAndValidateConfig } from '../../config/schema.js';
import { requireDependencies, LOCAL_DEPS } from '../../utils/dependencies.js';
import { logger } from '../../utils/logger.js';
import { runPlaybook } from '../../utils/ansible.js';
import { buildAnsiblePaths, checkP12Files } from '../../utils/docker.js';

/** Placeholder values that indicate euclid.json has not been configured. */
const PLACEHOLDER_PATTERNS = [
  'integrationnet|mainnet',
  ':gl0_node_ip',
  ':gl0_node_id',
  ':gl0_node_public_port',
];

export default class CreateRemoteGenesis extends Command {
  static override id = 'remote:create-remote-genesis';

  static override description =
    'Create genesis files locally (using Docker) to be deployed to remote cloud hosts';

  static override examples = [
    '<%= config.bin %> remote create-remote-genesis',
    '<%= config.bin %> create-remote-genesis',
    '<%= config.bin %> create_remote_genesis',
  ];

  static override aliases = [
    'create-remote-genesis',
    'create_remote_genesis',
    'remote:create_remote_genesis',
  ];

  async run(): Promise<void> {
    logger.section('CREATE REMOTE GENESIS');

    // Load config and derive paths
    const configPath = findConfigFile(process.cwd());
    if (!configPath) {
      logger.error(
        '✖  Command failed: remote create-remote-genesis\n   Reason: euclid.json not found\n   Fix:    Run this command from inside an Euclid project directory'
      );
    }
    const rootPath = path.dirname(configPath!);
    const config = loadAndValidateConfig(configPath!);

    // Check required tools (docker + ansible-playbook)
    requireDependencies(LOCAL_DEPS);

    // Guard: fail if any deploy fields still hold placeholder values.
    const networkName = config.deploy.network;
    const gl0Ip = String(config.deploy.gl0Node.ip);
    const gl0Id = String(config.deploy.gl0Node.id);
    const gl0Port = String(config.deploy.gl0Node.publicPort);

    const placeholderFound = PLACEHOLDER_PATTERNS.some(
      (p) => networkName === p || gl0Ip === p || gl0Id === p || gl0Port === p
    );

    if (placeholderFound) {
      logger.error(
        `✖  Command failed: remote create-remote-genesis\n   Reason: euclid.json contains default placeholder values\n   Fix:    Update ${rootPath}/euclid.json with real network configuration (.deploy.network.*)`
      );
    }

    // Validate at least 3 nodes
    if (config.nodes.length < 3) {
      logger.error(
        `✖  Command failed: remote create-remote-genesis\n   Reason: At least 3 nodes are required, found ${config.nodes.length}\n   Fix:    Add more nodes to euclid.json .nodes[]`
      );
    }

    // Validate p12 files exist locally
    const sourcePath = path.join(rootPath, 'source');
    const infraPath = path.join(rootPath, 'infra');
    const missingP12 = checkP12Files(sourcePath, config.nodes);
    if (missingP12.length > 0) {
      logger.error(
        `✖  Command failed: remote create-remote-genesis\n   Reason: Missing p12 files:\n${missingP12.map((f) => `   - ${f}`).join('\n')}\n   Fix:    Copy the required p12 files to ${sourcePath}/p12-files/`
      );
    }

    const networkHostIp = gl0Ip;
    const networkHostId = gl0Id;
    const networkHostPublicPort = gl0Port;

    logger.success(`Network configuration validated. Using network: ${networkName}`);

    // Build local playbook paths
    const ansiblePaths = buildAnsiblePaths(infraPath);
    const layers = config.layers;

    const baseEnv: NodeJS.ProcessEnv = {
      NODES: JSON.stringify(config.nodes),
      INFRA_PATH: infraPath,
      ANSIBLE_LOCALHOST_WARNING: 'False',
      ANSIBLE_INVENTORY_UNPARSED_WARNING: 'False',
    };

    // Step 1: Start Docker node containers
    const containersSpinner = logger.spin('Starting docker containers...');
    try {
      await runPlaybook(ansiblePaths.containersStart, {}, undefined, baseEnv);
      containersSpinner.succeed('Node containers started');
    } catch (err) {
      containersSpinner.fail('Failed to start containers');
      logger.error(
        `✖  Command failed: remote create-remote-genesis\n   Reason: Ansible failed to start containers — ${(err as Error).message}\n   Fix:    Ensure Docker is running`
      );
    }

    // Step 2: Start global-l0 in genesis mode
    if (layers.includes('global-l0')) {
      const gl0Spinner = logger.spin('Starting global-l0 layer...');
      try {
        await runPlaybook(
          ansiblePaths.globalL0Start,
          { force_genesis: 'true' },
          undefined,
          baseEnv
        );
        gl0Spinner.succeed('global-l0 started');
      } catch (err) {
        gl0Spinner.fail('Failed to start global-l0');
        logger.error(
          `✖  Command failed: remote create-remote-genesis\n   Reason: Ansible failed for global-l0 — ${(err as Error).message}\n   Fix:    Check Ansible output above`
        );
      }
    }

    // Step 3: Start metagraph-l0 in genesis mode
    if (layers.includes('metagraph-l0')) {
      const ml0Spinner = logger.spin('Starting metagraph-l0 layer...');
      try {
        await runPlaybook(
          ansiblePaths.metagraphL0Start,
          {
            force_genesis: 'true',
            network_host_ip: networkHostIp,
            network_host_id: networkHostId,
            network_host_public_port: networkHostPublicPort,
          },
          undefined,
          baseEnv
        );
        ml0Spinner.succeed('metagraph-l0 started');
      } catch (err) {
        ml0Spinner.fail('Failed to start metagraph-l0');
        logger.error(
          `✖  Command failed: remote create-remote-genesis\n   Reason: Ansible failed for metagraph-l0 — ${(err as Error).message}\n   Fix:    Check Ansible output above`
        );
      }
    }

    // Step 4: Stop Docker containers
    const stopSpinner = logger.spin('Stopping containers...');
    try {
      await runPlaybook(ansiblePaths.containersStop, {}, undefined, baseEnv);
      stopSpinner.succeed('Containers stopped');
    } catch (err) {
      stopSpinner.fail('Failed to stop containers');
      logger.error(
        `✖  Command failed: remote create-remote-genesis\n   Reason: Ansible failed to stop containers — ${(err as Error).message}\n   Fix:    Try: docker stop $(docker ps -q)`
      );
    }

    logger.success('Remote genesis complete!');
    logger.panel('Next Step', [
      `Genesis files generated in: ${infraPath}/shared/genesis/`,
      `Run: hydra remote deploy`,
    ]);
  }
}
