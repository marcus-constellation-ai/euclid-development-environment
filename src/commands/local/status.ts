/**
 * hydra local status — Check the health status of all local containers and cluster URLs.
 *
 * Bash equivalent: status() in scripts/hydra → status_containers() in scripts/hydra-operations/status.sh
 *
 * For each node: shows container running state, per-layer URLs and node/cluster info.
 * Port arithmetic: base_port + (node_index * 10)
 *   - global-l0:    9000, 9010, 9020
 *   - dag-l1:       9100, 9110, 9120
 *   - metagraph-l0: 9200, 9210, 9220
 *   - currency-l1:  9300, 9310, 9320
 *   - data-l1:      9400, 9410, 9420
 *
 * External dependencies: docker (≥26.0.0), curl
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from '@oclif/core';
import { execa } from 'execa';
import chalk from 'chalk';

import { findConfigFile } from '../../config/loader.js';
import { loadAndValidateConfig } from '../../config/schema.js';
import { requireDependencies, LOCAL_DEPS } from '../../utils/dependencies.js';
import { logger, BASE_PORTS, PORT_OFFSET, urlLine } from '../../utils/logger.js';
import { getContainerStatus } from '../../utils/docker.js';

/** Health check result for a single node */
interface NodeHealthResult {
  containerName: string;
  health: 'healthy' | 'unreachable' | 'starting';
}

/**
 * Check /node/info on a single endpoint with a 2000ms timeout.
 * Returns the health status string for the Health column.
 */
async function checkNodeHealth(url: string): Promise<'healthy' | 'unreachable' | 'starting'> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      return 'healthy';
    }
    return 'starting';
  } catch {
    return 'unreachable';
  }
}

/** Format the health status as a colored cell string */
function healthCell(health: 'healthy' | 'unreachable' | 'starting'): string {
  switch (health) {
    case 'healthy':
      return `${chalk.green('✔')} Healthy`;
    case 'unreachable':
      return `${chalk.red('✖')} Unreachable`;
    case 'starting':
      return `${chalk.yellow('⚠')} Starting`;
  }
}

export default class Status extends Command {
  static override id = 'local:status'

  static override description =
    'Show health status and URLs of all local metagraph containers'

  static override examples = [
    '<%= config.bin %> local status',
    '<%= config.bin %> status',
  ]

  static override aliases = ['status']

  async run(): Promise<void> {
    // ----------------------------------------------------------------
    // 1. Load config and resolve paths
    // ----------------------------------------------------------------
    const configFilePath = findConfigFile();
    if (!configFilePath) {
      logger.error('Could not find euclid.json. Run from inside an Euclid project directory.');
    }
    const config = loadAndValidateConfig(configFilePath!);
    const rootPath = path.dirname(configFilePath!);
    const sourcePath = path.join(rootPath, 'source');

    // ----------------------------------------------------------------
    // 2. Check dependencies
    // ----------------------------------------------------------------
    requireDependencies(LOCAL_DEPS);

    // ----------------------------------------------------------------
    // 3. Print status header
    // ----------------------------------------------------------------
    logger.section('STATUS');

    // Docker health check
    const dockerInfo = await execa('docker', ['info'], { reject: false, env: process.env });
    if (dockerInfo.exitCode !== 0) {
      logger.error(
        '✖  Command failed: local status\n   Reason: Docker daemon is not running\n   Fix:    Start Docker Desktop or run: sudo systemctl start docker'
      );
    }
    logger.success('Docker is healthy and running.');

    // ----------------------------------------------------------------
    // 4. Show metagraph ID (from genesis.address if it exists)
    // ----------------------------------------------------------------
    const genesisAddressFile = path.join(
      sourcePath, 'metagraph-l0', 'genesis', 'genesis.address'
    );
    if (fs.existsSync(genesisAddressFile)) {
      const metagraphId = fs.readFileSync(genesisAddressFile, 'utf-8').trim();
      if (metagraphId) {
        urlLine('Metagraph ID:', metagraphId);
      }
    } else {
      logger.warn(`Could not get Metagraph ID, file ${genesisAddressFile} does not exist`);
    }

    const layers = config.layers;

    // ----------------------------------------------------------------
    // 5. Per-node status
    // ----------------------------------------------------------------
    for (let index = 0; index < config.nodes.length; index++) {
      const node = config.nodes[index];
      logger.section(`Container ${node.name}`);

      const containerStatus = await getContainerStatus(node.name);

      if (containerStatus.status === 'running') {
        logger.success(`Container '${node.name}' is running.`);

        // Show peer ID by running cl-wallet.jar show-id inside the container
        const peerIdResult = await execa(
          'docker',
          [
            'exec', node.name, 'bash', '-c',
            `cd metagraph-l0 && export CL_KEYSTORE=${node.key_file.name} && ` +
            `export CL_KEYALIAS=${node.key_file.alias} && ` +
            `export CL_PASSWORD=${node.key_file.password} && ` +
            `java -jar cl-wallet.jar show-id`,
          ],
          { reject: false, env: process.env }
        );
        if (peerIdResult.exitCode === 0) {
          urlLine('PeerID:', peerIdResult.stdout.trim());
        }

        // Global L0 (only on node 0 — the genesis/lead node)
        if (index === 0 && layers.includes('global-l0')) {
          logger.info('Global L0');
          const port = BASE_PORTS['global-l0'];
          const url = `http://localhost:${port}/node/info`;
          urlLine('URL:', url);
          urlLine('Node info:', await this.fetchJson(url));
        }

        // DAG L1
        if (layers.includes('dag-l1')) {
          logger.info('DAG L1');
          const port = BASE_PORTS['dag-l1'] + index * PORT_OFFSET;
          const url = `http://localhost:${port}/node/info`;
          urlLine('URL:', url);
          urlLine('Node info:', await this.fetchJson(url));
        }

        // Metagraph L0
        if (layers.includes('metagraph-l0')) {
          logger.info('Metagraph L0');
          const port = BASE_PORTS['metagraph-l0'] + index * PORT_OFFSET;
          const url = `http://localhost:${port}/node/info`;
          urlLine('URL:', url);
          urlLine('Node info:', await this.fetchJson(url));
        }

        // Currency L1
        if (layers.includes('currency-l1') || layers.includes('metagraph-l1-currency')) {
          logger.info('Currency L1');
          const port = BASE_PORTS['currency-l1'] + index * PORT_OFFSET;
          const url = `http://localhost:${port}/node/info`;
          urlLine('URL:', url);
          urlLine('Node info:', await this.fetchJson(url));
        }

        // Data L1
        if (layers.includes('data-l1') || layers.includes('metagraph-l1-data')) {
          logger.info('Data L1');
          const port = BASE_PORTS['data-l1'] + index * PORT_OFFSET;
          const url = `http://localhost:${port}/node/info`;
          urlLine('URL:', url);
          urlLine('Node info:', await this.fetchJson(url));
        }
      } else {
        logger.warn(`Container '${node.name}' is not running or does not exist.`);
      }
    }

    // ----------------------------------------------------------------
    // 6. Cluster URLs (matches status.sh bottom section)
    // ----------------------------------------------------------------
    logger.section('Clusters');

    if (layers.includes('global-l0')) {
      logger.info('Global L0');
      const url = `http://localhost:${BASE_PORTS['global-l0']}/cluster/info`;
      urlLine('URL:', url);
      urlLine('Cluster info:', await this.fetchJson(url));
    }

    if (layers.includes('dag-l1')) {
      logger.info('DAG L1');
      const url = `http://localhost:${BASE_PORTS['dag-l1']}/cluster/info`;
      urlLine('URL:', url);
      urlLine('Cluster info:', await this.fetchJson(url));
    }

    if (layers.includes('metagraph-l0')) {
      logger.info('Metagraph L0');
      const url = `http://localhost:${BASE_PORTS['metagraph-l0']}/cluster/info`;
      urlLine('URL:', url);
      urlLine('Cluster info:', await this.fetchJson(url));
    }

    if (layers.includes('currency-l1') || layers.includes('metagraph-l1-currency')) {
      logger.info('Currency L1');
      const url = `http://localhost:${BASE_PORTS['currency-l1']}/cluster/info`;
      urlLine('URL:', url);
      urlLine('Cluster info:', await this.fetchJson(url));
    }

    if (layers.includes('data-l1') || layers.includes('metagraph-l1-data')) {
      logger.info('Data L1');
      const url = `http://localhost:${BASE_PORTS['data-l1']}/cluster/info`;
      urlLine('URL:', url);
      urlLine('Cluster info:', await this.fetchJson(url));
    }

    // ----------------------------------------------------------------
    // 7. Docker container status table
    // ----------------------------------------------------------------
    logger.section('Docker Containers');

    const dockerPs = await execa(
      'docker',
      ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}'],
      { reject: false, env: process.env }
    );

    if (dockerPs.exitCode !== 0 || !dockerPs.stdout.trim()) {
      return;
    }

    // Determine which config nodes have running containers
    const runningNodeNames = new Set<string>();
    for (const node of config.nodes) {
      const cs = await getContainerStatus(node.name);
      if (cs.status === 'running') {
        runningNodeNames.add(node.name);
      }
    }

    // ----------------------------------------------------------------
    // 8. Health check — run in parallel for all running nodes
    // ----------------------------------------------------------------
    const healthSpinner = logger.spin('Checking node health...');

    const healthChecks: Array<Promise<NodeHealthResult>> = config.nodes
      .filter((node) => runningNodeNames.has(node.name))
      .map((node, idx) => {
        const port = BASE_PORTS['metagraph-l0'] + idx * PORT_OFFSET;
        const url = `http://localhost:${port}/node/info`;
        return checkNodeHealth(url).then((health) => ({
          containerName: node.name,
          health,
        }));
      });

    const healthResults = await Promise.all(healthChecks);
    healthSpinner.stop();

    // Build map: containerName → health result
    const healthMap = new Map<string, 'healthy' | 'unreachable' | 'starting'>();
    for (const result of healthResults) {
      healthMap.set(result.containerName, result.health);
    }

    // Build table rows with Health column
    const rows: string[][] = dockerPs.stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [name = '', status = '', ports = ''] = line.split('\t');

        // Determine layer from container name
        let layer = 'N/A';
        if (name.includes('node')) layer = 'node';
        else if (name.includes('grafana')) layer = 'grafana';
        else if (name.includes('prometheus')) layer = 'prometheus';

        // Parse a port number from the ports field
        const portMatch = ports.match(/:(\d+)->/);
        const port = portMatch ? portMatch[1] : ports.slice(0, 20);

        // Color the status cell
        const statusLower = status.toLowerCase();
        let statusCell: string;
        if (statusLower.startsWith('up')) {
          statusCell = `${chalk.green('✔')} Up`;
        } else if (statusLower.startsWith('exited') || statusLower.startsWith('dead')) {
          statusCell = `${chalk.red('✖')} Down`;
        } else {
          statusCell = `${chalk.yellow('⚠')} ${status.slice(0, 20)}`;
        }

        // Health cell: use check result for node containers, N/A for others
        const health = healthMap.get(name);
        const healthCol = health ? healthCell(health) : chalk.dim('N/A');

        return [name, statusCell, layer, port ?? '', healthCol];
      });

    logger.table(['Container', 'Status', 'Layer', 'Port', 'Health'], rows);
  }

  // ------------------------------------------------------------------
  // Private: fetch JSON from URL, return raw string (like bash curl -s)
  // ------------------------------------------------------------------

  private async fetchJson(url: string): Promise<string> {
    try {
      const result = await execa('curl', ['-s', '--max-time', '5', url], {
        reject: false,
        env: process.env,
      });
      return result.stdout.trim() || '(no response)';
    } catch {
      return '(connection refused)';
    }
  }
}
