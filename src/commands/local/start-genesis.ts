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

import { findConfigFile } from '../../config/loader.js';
import { loadAndValidateConfig } from '../../config/schema.js';
import { requireDependencies, LOCAL_DEPS } from '../../utils/dependencies.js';
import { logger, printMetagraphInfo } from '../../utils/logger.js';
import { confirmYN } from '../../utils/prompt.js';
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
      logger.error('Could not find euclid.json. Run from inside an Euclid project directory.');
    }
    const config = loadAndValidateConfig(configFilePath!);
    const rootPath = path.dirname(configFilePath!);
    const infraPath = path.join(rootPath, 'infra');
    const sourcePath = path.join(rootPath, 'source');

    // ----------------------------------------------------------------
    // 2. Check tool dependencies
    // ----------------------------------------------------------------
    requireDependencies(LOCAL_DEPS);

    // ----------------------------------------------------------------
    // 3. Pre-start validations (matches start_containers() in bash)
    // ----------------------------------------------------------------
    logger.section('START (GENESIS)');

    if (!(await confirmYN('⚠  This will erase all local chain history. Continue?'))) {
      return;
    }

    // At least 3 nodes required
    if (config.nodes.length < 3) {
      logger.error(`At least 3 nodes are required. Found: ${config.nodes.length}`);
    }

    // All node p12 files must exist
    const missingP12 = checkP12Files(sourcePath, config.nodes);
    if (missingP12.length > 0) {
      logger.error(
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
    const networkHostIp = config.deploy.gl0Node.ip;
    const networkHostId = config.deploy.gl0Node.id;
    const networkHostPublicPort = String(config.deploy.gl0Node.publicPort);

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
      const idSpinner = logger.spin('Waiting for metagraph genesis.address...');
      try {
        const metagraphId = await pollMetagraphId(sourcePath, rootPath);
        idSpinner.succeed(`Metagraph ID: ${metagraphId}`);
        logger.info('Filling the euclid.json file');
      } catch (err) {
        idSpinner.fail('Failed to get metagraph ID');
        logger.error(
          `✖  Command failed: local start-genesis\n   Reason: ${(err as Error).message}\n   Fix:    Check metagraph-l0 logs with: hydra logs metagraph-node-1 metagraph-l0`
        );
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
    if (config.monitoring?.grafana.enabled) {
      await this.tryStartLayer(
        'Grafana',
        ansible.grafanaStart,
        {},
        baseEnv
      );
    }

    // ----------------------------------------------------------------
    // 12. Print metagraph info panel (boxen)
    // ----------------------------------------------------------------
    // Reload config to pick up metagraph_id written by pollMetagraphId
    const updatedConfig = loadAndValidateConfig(configFilePath!);
    const genesisAddressFile = path.join(
      sourcePath, 'metagraph-l0', 'genesis', 'genesis.address'
    );
    const metagraphId = fs.existsSync(genesisAddressFile)
      ? fs.readFileSync(genesisAddressFile, 'utf-8').trim()
      : (updatedConfig.metagraph_id ?? '(not available)');

    printMetagraphInfo(updatedConfig, { metagraphId });
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
    const spinner = logger.spin(`Starting ${layerName}...`);

    try {
      await runAnsible(playbookPath, extraVars, env);
      spinner.succeed(`${layerName} started`);
    } catch {
      spinner.fail(`Failed to start ${layerName}`);
      logger.error(
        `✖  Command failed: local start-genesis\n   Reason: Ansible playbook failed for ${layerName}\n   Fix:    Check the Ansible output above and container logs`
      );
    }
  }
}
