/**
 * hydra local start-rollback — Start containers from the last snapshot (maintaining history).
 *
 * Bash equivalent: start-rollback() / start_rollback() alias in scripts/hydra
 *                  → start_containers(false) in scripts/hydra-operations/start.sh
 *
 * Identical flow to start-genesis but passes forceGenesis=false to all layer playbooks,
 * causing nodes to run run-validator instead of run-genesis.
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
import {
  buildAnsiblePaths,
  checkP12Files,
  runAnsible,
} from '../../utils/docker.js';

export default class StartRollback extends Command {
  static override id = 'local:start-rollback'

  static override description =
    'Start containers from the last saved snapshot (maintaining chain history)'

  static override examples = [
    '<%= config.bin %> local start-rollback',
    '<%= config.bin %> start-rollback',
    '<%= config.bin %> start_rollback',
  ]

  /**
   * Aliases:
   *   - `start_rollback`  — original bash underscore variant
   *   - `start-rollback`  — top-level backward-compat alias
   */
  static override aliases = ['start-rollback', 'start_rollback', 'local:start_rollback']

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
    // 3. Pre-start validations
    // ----------------------------------------------------------------
    logger.section('START (ROLLBACK)');

    if (config.nodes.length < 3) {
      logger.error(`At least 3 nodes are required. Found: ${config.nodes.length}`);
    }

    const missingP12 = checkP12Files(sourcePath, config.nodes);
    if (missingP12.length > 0) {
      logger.error(
        `Missing p12 files in source/p12-files/:\n  ${missingP12.join('\n  ')}`
      );
    }

    // ----------------------------------------------------------------
    // 4. Build Ansible playbook paths
    // ----------------------------------------------------------------
    const ansible = buildAnsiblePaths(infraPath);
    const nodesJson = JSON.stringify(config.nodes);
    const baseEnv: NodeJS.ProcessEnv = {
      NODES: nodesJson,
      INFRA_PATH: infraPath,
    };

    const networkHostIp = config.deploy.gl0Node.ip;
    const networkHostId = config.deploy.gl0Node.id;
    const networkHostPublicPort = String(config.deploy.gl0Node.publicPort);

    const layers = config.layers;
    const forceGenesis = 'false'; // rollback = do not run genesis

    // ----------------------------------------------------------------
    // 5. Start Docker node containers
    // ----------------------------------------------------------------
    await this.tryStartLayer(
      'Docker node containers',
      ansible.containersStart,
      {},
      baseEnv
    );

    // ----------------------------------------------------------------
    // 6. Start global-l0 (rollback mode)
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
    // 7. Start dag-l1 (rollback mode)
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
    // 8. Start metagraph-l0 (rollback mode — no genesis.address polling)
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
    }

    // ----------------------------------------------------------------
    // 9. Start currency-l1
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
    // 10. Start data-l1
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
    const genesisAddressFile = path.join(
      sourcePath, 'metagraph-l0', 'genesis', 'genesis.address'
    );
    const metagraphId = fs.existsSync(genesisAddressFile)
      ? fs.readFileSync(genesisAddressFile, 'utf-8').trim()
      : (config.metagraph_id ?? '(not available)');

    printMetagraphInfo(config, { metagraphId });
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
        `✖  Command failed: local start-rollback\n   Reason: Ansible playbook failed for ${layerName}\n   Fix:    Check the Ansible output above and container logs`
      );
    }
  }
}
