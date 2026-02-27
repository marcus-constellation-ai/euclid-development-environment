/**
 * hydra remote create-remote-genesis — Generate genesis files locally for remote deployment.
 *
 * Bash equivalent: create-remote-genesis() / create_remote_genesis() alias
 *                  → start_containers_remote_genesis(true) in
 *                    scripts/hydra-operations/create-remote-genesis.sh
 *
 * This command runs the metagraph locally in Docker to produce:
 *   infra/shared/genesis/genesis.snapshot
 *   infra/shared/genesis/genesis.address
 *
 * These files are then used by "hydra remote deploy" to send to remote nodes.
 *
 * Sequence (matches start_containers_remote_genesis(true) in create-remote-genesis.sh):
 *   1. Validate no placeholder values in deploy.network (euclid.json must be configured)
 *   2. Set NETWORK_HOST_IP / NETWORK_HOST_ID / NETWORK_HOST_PUBLIC_PORT
 *   3. Start Docker node containers (local containers playbook)
 *   4. Start global-l0 in genesis mode (if global-l0 is in layers)
 *   5. Start metagraph-l0 in genesis mode (if metagraph-l0 is in layers)
 *   6. Stop Docker containers
 *
 * Ansible env vars passed to local playbooks (via lookup('env', ...)):
 *   NODES                  = JSON.stringify(config.nodes)
 *   INFRA_PATH             = <rootPath>/infra
 *   NETWORK_HOST_IP        = config.deploy.network.gl0_node.ip
 *   NETWORK_HOST_ID        = config.deploy.network.gl0_node.id
 *   NETWORK_HOST_PUBLIC_PORT = config.deploy.network.gl0_node.public_port
 *   ANSIBLE_LOCALHOST_WARNING          = False
 *   ANSIBLE_INVENTORY_UNPARSED_WARNING = False
 *
 * Guard: exits with error if any deploy.network field still contains placeholder values
 *   (':gl0_node_ip', ':gl0_node_id', ':gl0_node_public_port', 'integrationnet|mainnet')
 */
import * as path from 'node:path';
import { Command } from '@oclif/core';
import { loadConfig, findConfigFile } from '../../config/loader.js';
import { requireDependencies, LOCAL_DEPS } from '../../utils/dependencies.js';
import { header, success, info } from '../../utils/logger.js';
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
    header('CREATE REMOTE GENESIS');

    // Load config and derive paths
    const configPath = findConfigFile(process.cwd());
    if (!configPath) {
      this.error(
        'Could not find euclid.json. Run this command from inside an Euclid project directory.'
      );
    }
    const rootPath = path.dirname(configPath);
    const config = loadConfig(configPath);

    // Check required tools (docker + ansible-playbook)
    requireDependencies(LOCAL_DEPS);

    // Guard: fail if any deploy.network fields still hold placeholder values.
    // Matches the check in create-remote-genesis.sh:
    //   if [[ "$DEPLOY_NETWORK_NAME" == "integrationnet|mainnet" ]] ||
    //      [[ "$DEPLOY_NETWORK_HOST_IP" == ":gl0_node_ip" ]] || ...
    const networkName = String(config.deploy.network.name);
    const gl0Ip = String(config.deploy.network.gl0_node.ip);
    const gl0Id = String(config.deploy.network.gl0_node.id);
    const gl0Port = String(config.deploy.network.gl0_node.public_port);

    const placeholderFound = PLACEHOLDER_PATTERNS.some(
      (p) => networkName === p || gl0Ip === p || gl0Id === p || gl0Port === p
    );

    if (placeholderFound) {
      this.error(
        '❌ ERROR: euclid.json contains default placeholder values.\n' +
          `Please update ${rootPath}/euclid.json with real network configuration:\n` +
          '  .deploy.network.name            (e.g. "integrationnet" or "mainnet")\n' +
          '  .deploy.network.gl0_node.ip     (e.g. "1.2.3.4")\n' +
          '  .deploy.network.gl0_node.id     (e.g. "abc123...")\n' +
          '  .deploy.network.gl0_node.public_port (e.g. 9000)'
      );
    }

    // Validate at least 3 nodes
    if (config.nodes.length < 3) {
      this.error(
        `At least 3 nodes are required. Found ${config.nodes.length} in euclid.json .nodes[].`
      );
    }

    // Validate p12 files exist locally
    const sourcePath = path.join(rootPath, 'source');
    const infraPath = path.join(rootPath, 'infra');
    const missingP12 = checkP12Files(sourcePath, config.nodes);
    if (missingP12.length > 0) {
      this.error(
        `Missing p12 files in ${sourcePath}/p12-files/:\n` +
          missingP12.map((f) => `  - ${f}`).join('\n')
      );
    }

    // Network host values (matches: export NETWORK_HOST_IP=$DEPLOY_NETWORK_HOST_IP etc.)
    const networkHostIp = gl0Ip;
    const networkHostId = gl0Id;
    const networkHostPublicPort = gl0Port;

    info(`✅ Network configuration validated. Using network ${networkName}`);
    this.log('');

    // Build local playbook paths (from infra/ansible/local/playbooks/)
    const ansiblePaths = buildAnsiblePaths(infraPath);
    const layers = config.layers;

    // Base env for all local playbook invocations
    // Ansible local playbooks use lookup('env', 'NODES') and lookup('env', 'INFRA_PATH')
    const baseEnv: NodeJS.ProcessEnv = {
      NODES: JSON.stringify(config.nodes),
      INFRA_PATH: infraPath,
      ANSIBLE_LOCALHOST_WARNING: 'False',
      ANSIBLE_INVENTORY_UNPARSED_WARNING: 'False',
    };

    // Step 1: Start Docker node containers
    // Matches: try_start_docker_nodes() → ansible-playbook $ANSIBLE_LOCAL_CONTAINERS_START_PLAYBOOK_FILE
    info('Starting docker containers...');
    await runPlaybook(ansiblePaths.containersStart, {}, undefined, baseEnv);
    success('Node containers started successfully.');
    this.log('');

    // Step 2: Start global-l0 in genesis mode
    // Matches: try_start_global_l0(true) — only if global-l0 in layers
    if (layers.includes('global-l0')) {
      info('Starting global-l0 layer...');
      await runPlaybook(
        ansiblePaths.globalL0Start,
        { force_genesis: 'true' },
        undefined,
        baseEnv
      );
      success('global-l0 started successfully.');
      this.log('');
    }

    // Step 3: Start metagraph-l0 in genesis mode
    // Matches: try_start_metagraph_l0(true) — only if metagraph-l0 in layers
    // Passes: force_genesis, network_host_ip, network_host_id, network_host_public_port
    if (layers.includes('metagraph-l0')) {
      info('Starting metagraph-l0 layer...');
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
      success('metagraph-l0 started successfully.');
      this.log('');
    }

    // Step 4: Stop Docker containers
    // Matches: try_stop_containers() → ansible-playbook $ANSIBLE_LOCAL_CONTAINERS_STOP_PLAYBOOK_FILE
    info('Stopping containers...');
    await runPlaybook(ansiblePaths.containersStop, {}, undefined, baseEnv);
    success('Containers stopped.');
    this.log('');

    success(
      'Remote genesis complete!\n' +
        `Genesis files are in: ${infraPath}/shared/genesis/\n` +
        'Now run: hydra remote deploy'
    );
  }
}
