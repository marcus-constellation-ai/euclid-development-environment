/**
 * hydra local start-genesis — Start containers from the genesis snapshot (erasing history).
 *
 * Bash equivalent: start-genesis() / start_genesis() alias in scripts/hydra
 *                  → start_containers(true) in scripts/hydra-operations/start.sh
 *
 * Starts all enabled layers in order:
 *   1. Start node Docker containers (via Ansible nodes playbook)
 *   2. Start global-l0 (genesis mode)
 *   3. Start dag-l1 (if in layers)
 *   4. Start metagraph-l0 (genesis mode) — generates genesis files + polls genesis.address
 *   5. Start currency-l1 (if in layers)
 *   6. Start data-l1 (if in layers)
 *   7. Start Grafana (if docker.start_grafana_container = true)
 *   8. Print all node URLs
 *
 * External dependencies: docker (≥26.0.0), ansible-playbook (≥2.16)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from '@oclif/core';

import { loadConfig, findConfigFile } from '../../config/loader.js';
import { requireDependencies, LOCAL_DEPS } from '../../utils/dependencies.js';
import * as logger from '../../utils/logger.js';
import {
  buildAnsiblePaths,
  checkP12Files,
  pollMetagraphId,
  runAnsible,
} from '../../utils/docker.js';

export default class StartGenesis extends Command {
  static override id = 'local:start-genesis'

  static override description =
    'Start containers from the genesis snapshot (erasing all chain history)'

  static override examples = [
    '<%= config.bin %> local start-genesis',
    '<%= config.bin %> start-genesis',
    '<%= config.bin %> start_genesis',
  ]

  /**
   * Aliases:
   *   - `start_genesis`  — original bash underscore variant
   *   - `start-genesis`  — top-level backward-compat alias
   */
  static override aliases = ['start-genesis', 'start_genesis', 'local:start_genesis']

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
    const infraPath = path.join(rootPath, 'infra');
    const sourcePath = path.join(rootPath, 'source');

    // ----------------------------------------------------------------
    // 2. Check tool dependencies
    // ----------------------------------------------------------------
    requireDependencies(LOCAL_DEPS);

    // ----------------------------------------------------------------
    // 3. Pre-start validations (matches start_containers() in bash)
    // ----------------------------------------------------------------
    logger.header('################################## START (GENESIS) ##################################');

    // At least 3 nodes required
    if (config.nodes.length < 3) {
      this.error(`At least 3 nodes are required. Found: ${config.nodes.length}`);
    }

    // All node p12 files must exist
    const missingP12 = checkP12Files(sourcePath, config.nodes);
    if (missingP12.length > 0) {
      this.error(
        `Missing p12 files in source/p12-files/:\n  ${missingP12.join('\n  ')}`
      );
    }

    // ----------------------------------------------------------------
    // 4. Build Ansible playbook paths and node env from config
    // ----------------------------------------------------------------
    const ansible = buildAnsiblePaths(infraPath);
    const nodesJson = JSON.stringify(config.nodes);
    const baseEnv: NodeJS.ProcessEnv = {
      NODES: nodesJson,
      INFRA_PATH: infraPath,
    };

    // Network host info from config (may be placeholder values for local — that's OK)
    const networkHostIp = config.deploy.network.gl0_node.ip;
    const networkHostId = config.deploy.network.gl0_node.id;
    const networkHostPublicPort = String(config.deploy.network.gl0_node.public_port);

    const layers = config.layers;
    const forceGenesis = 'true';

    // ----------------------------------------------------------------
    // 5. Start Docker node containers (creates custom-network)
    // ----------------------------------------------------------------
    await this.tryStartLayer(
      'Docker node containers',
      ansible.containersStart,
      {},
      baseEnv
    );

    // ----------------------------------------------------------------
    // 6. Start global-l0 (genesis mode)
    // ----------------------------------------------------------------
    if (layers.includes('global-l0')) {
      await this.tryStartLayer(
        'global-l0',
        ansible.globalL0Start,
        { force_genesis: forceGenesis },
        baseEnv
      );
    }

    // ----------------------------------------------------------------
    // 7. Start dag-l1 (if configured)
    // ----------------------------------------------------------------
    if (layers.includes('dag-l1')) {
      await this.tryStartLayer(
        'dag-l1',
        ansible.dagL1Start,
        { force_genesis: forceGenesis },
        baseEnv
      );
    }

    // ----------------------------------------------------------------
    // 8. Start metagraph-l0 (genesis mode) — generates genesis files
    // ----------------------------------------------------------------
    if (layers.includes('metagraph-l0')) {
      await this.tryStartLayer(
        'metagraph-l0',
        ansible.metagraphL0Start,
        {
          force_genesis: forceGenesis,
          network_host_ip: networkHostIp,
          network_host_id: networkHostId,
          network_host_public_port: networkHostPublicPort,
        },
        baseEnv
      );

      // Poll genesis.address file until metagraph_id is available
      logger.info('Waiting for metagraph genesis.address...');
      try {
        const metagraphId = await pollMetagraphId(sourcePath, rootPath);
        logger.urlLine('METAGRAPH_ID:', metagraphId);
        logger.detail('Filling the euclid.json file');
      } catch (err) {
        this.error(`Failed to get metagraph ID: ${(err as Error).message}`);
      }
    }

    // ----------------------------------------------------------------
    // 9. Start currency-l1 (if configured)
    // ----------------------------------------------------------------
    if (layers.includes('currency-l1') || layers.includes('metagraph-l1-currency')) {
      await this.tryStartLayer(
        'currency-l1',
        ansible.currencyL1Start,
        {},
        baseEnv
      );
    }

    // ----------------------------------------------------------------
    // 10. Start data-l1 (if configured)
    // ----------------------------------------------------------------
    if (layers.includes('data-l1') || layers.includes('metagraph-l1-data')) {
      await this.tryStartLayer(
        'data-l1',
        ansible.dataL1Start,
        {},
        baseEnv
      );
    }

    // ----------------------------------------------------------------
    // 11. Start Grafana (if configured)
    // ----------------------------------------------------------------
    if (config.docker.start_grafana_container) {
      await this.tryStartLayer(
        'Grafana',
        ansible.grafanaStart,
        {},
        baseEnv
      );
    }

    // ----------------------------------------------------------------
    // 12. Print all node URLs
    // ----------------------------------------------------------------
    // Reload config to pick up metagraph_id written by pollMetagraphId
    const updatedConfig = loadConfig(configFilePath);
    const genesisAddressFile = path.join(
      sourcePath, 'metagraph-l0', 'genesis', 'genesis.address'
    );
    const metagraphId = fs.existsSync(genesisAddressFile)
      ? fs.readFileSync(genesisAddressFile, 'utf-8').trim()
      : (updatedConfig.metagraph_id ?? '(not available)');

    logger.printMetagraphInfo(updatedConfig, { metagraphId });
  }

  // ------------------------------------------------------------------
  // Private: run one Ansible layer playbook with success/error logging
  // ------------------------------------------------------------------

  private async tryStartLayer(
    layerName: string,
    playbookPath: string,
    extraVars: Record<string, string>,
    env: NodeJS.ProcessEnv
  ): Promise<void> {
    logger.detail('');
    logger.detail('');
    logger.header();
    logger.info(`Starting ${layerName}...`);
    logger.detail('');

    try {
      await runAnsible(playbookPath, extraVars, env);
      logger.success(`${layerName} started successfully`);
    } catch {
      logger.error(`Failed when starting ${layerName}, take a look at the logs.`);
      this.exit(1);
    }

    logger.header();
  }
}
