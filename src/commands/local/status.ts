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

import { loadConfig, findConfigFile } from '../../config/loader.js';
import { requireDependencies, LOCAL_DEPS } from '../../utils/dependencies.js';
import * as logger from '../../utils/logger.js';
import { getContainerStatus } from '../../utils/docker.js';

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
      this.error('Could not find euclid.json. Run from inside an Euclid project directory.');
    }
    const config = loadConfig(configFilePath);
    const rootPath = path.dirname(configFilePath);
    const sourcePath = path.join(rootPath, 'source');

    // ----------------------------------------------------------------
    // 2. Check dependencies
    // ----------------------------------------------------------------
    requireDependencies(LOCAL_DEPS);

    // ----------------------------------------------------------------
    // 3. Print status header
    // ----------------------------------------------------------------
    logger.header('################################## STATUS ##################################');

    // Docker health check
    const dockerInfo = await execa('docker', ['info'], { reject: false, env: process.env });
    if (dockerInfo.exitCode !== 0) {
      logger.error('Docker is not running');
      this.exit(1);
    }
    logger.success('Docker is healthy and running.');

    // ----------------------------------------------------------------
    // 4. Show metagraph ID (from genesis.address if it exists)
    // ----------------------------------------------------------------
    logger.detail('');
    const genesisAddressFile = path.join(
      sourcePath, 'metagraph-l0', 'genesis', 'genesis.address'
    );
    if (fs.existsSync(genesisAddressFile)) {
      const metagraphId = fs.readFileSync(genesisAddressFile, 'utf-8').trim();
      if (metagraphId) {
        logger.urlLine('Metagraph ID:', metagraphId);
      }
    } else {
      logger.info(`Could not get Metagraph ID, file ${genesisAddressFile} does not exist`);
    }
    logger.detail('');

    const layers = config.layers;

    // ----------------------------------------------------------------
    // 5. Per-node status
    // ----------------------------------------------------------------
    for (let index = 0; index < config.nodes.length; index++) {
      const node = config.nodes[index];
      logger.success(`Container ${node.name}`);

      const containerStatus = await getContainerStatus(node.name);

      if (containerStatus.status === 'running') {
        logger.success(`Container '${node.name}' is running.`);

        // Show peer ID by running cl-wallet.jar show-id inside the container
        // (matches bash: docker exec $name bash -c "cd metagraph-l0 && ...")
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
          logger.urlLine('PeerID:', peerIdResult.stdout.trim());
        }

        // Global L0 (only on node 0 — the genesis/lead node)
        if (index === 0 && layers.includes('global-l0')) {
          logger.detail('');
          logger.success('Global L0');
          const port = logger.BASE_PORTS['global-l0'];
          const url = `http://localhost:${port}/node/info`;
          logger.urlLine('URL:', url);
          logger.urlLine('Node info:', await this.fetchJson(url));
        }

        // DAG L1
        if (layers.includes('dag-l1')) {
          logger.detail('');
          logger.success('DAG L1');
          const port = logger.BASE_PORTS['dag-l1'] + index * logger.PORT_OFFSET;
          const url = `http://localhost:${port}/node/info`;
          logger.urlLine('URL:', url);
          logger.urlLine('Node info:', await this.fetchJson(url));
        }

        // Metagraph L0
        if (layers.includes('metagraph-l0')) {
          logger.detail('');
          logger.success('Metagraph L0');
          const port = logger.BASE_PORTS['metagraph-l0'] + index * logger.PORT_OFFSET;
          const url = `http://localhost:${port}/node/info`;
          logger.urlLine('URL:', url);
          logger.urlLine('Node info:', await this.fetchJson(url));
        }

        // Currency L1
        if (layers.includes('currency-l1') || layers.includes('metagraph-l1-currency')) {
          logger.detail('');
          logger.success('Currency L1');
          const port = logger.BASE_PORTS['currency-l1'] + index * logger.PORT_OFFSET;
          const url = `http://localhost:${port}/node/info`;
          logger.urlLine('URL:', url);
          logger.urlLine('Node info:', await this.fetchJson(url));
        }

        // Data L1
        if (layers.includes('data-l1') || layers.includes('metagraph-l1-data')) {
          logger.detail('');
          logger.success('Data L1');
          const port = logger.BASE_PORTS['data-l1'] + index * logger.PORT_OFFSET;
          const url = `http://localhost:${port}/node/info`;
          logger.urlLine('URL:', url);
          logger.urlLine('Node info:', await this.fetchJson(url));
        }
      } else {
        logger.error(`Container '${node.name}' is not running or does not exist.`);
      }

      logger.detail('');
      logger.detail('');
    }

    // ----------------------------------------------------------------
    // 6. Cluster URLs (matches status.sh bottom section)
    // ----------------------------------------------------------------
    logger.success('Clusters');

    if (layers.includes('global-l0')) {
      logger.detail('');
      logger.success('Global L0');
      const url = `http://localhost:${logger.BASE_PORTS['global-l0']}/cluster/info`;
      logger.urlLine('URL:', url);
      logger.urlLine('Cluster info:', await this.fetchJson(url));
      logger.detail('');
    }

    if (layers.includes('dag-l1')) {
      logger.detail('');
      logger.success('DAG L1');
      const url = `http://localhost:${logger.BASE_PORTS['dag-l1']}/cluster/info`;
      logger.urlLine('URL:', url);
      logger.urlLine('Cluster info:', await this.fetchJson(url));
    }

    if (layers.includes('metagraph-l0')) {
      logger.detail('');
      logger.success('Metagraph L0');
      const url = `http://localhost:${logger.BASE_PORTS['metagraph-l0']}/cluster/info`;
      logger.urlLine('URL:', url);
      logger.urlLine('Cluster info:', await this.fetchJson(url));
      logger.detail('');
    }

    if (layers.includes('currency-l1') || layers.includes('metagraph-l1-currency')) {
      logger.detail('');
      logger.success('Currency L1');
      const url = `http://localhost:${logger.BASE_PORTS['currency-l1']}/cluster/info`;
      logger.urlLine('URL:', url);
      logger.urlLine('Cluster info:', await this.fetchJson(url));
      logger.detail('');
    }

    if (layers.includes('data-l1') || layers.includes('metagraph-l1-data')) {
      logger.detail('');
      logger.success('Data L1');
      const url = `http://localhost:${logger.BASE_PORTS['data-l1']}/cluster/info`;
      logger.urlLine('URL:', url);
      logger.urlLine('Cluster info:', await this.fetchJson(url));
      logger.detail('');
    }

    // ----------------------------------------------------------------
    // 7. Docker container status table (matches bash: docker ps -a --format ...)
    // ----------------------------------------------------------------
    logger.detail('');
    logger.info('Docker containers status');
    logger.detail('');

    const dockerPs = await execa(
      'docker',
      ['ps', '-a', '--format', 'table {{.Names}}\t{{.Ports}}\t{{.Status}}'],
      { reject: false, env: process.env }
    );
    if (dockerPs.exitCode === 0) {
      process.stdout.write(dockerPs.stdout + '\n');
    }

    logger.detail('');
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
