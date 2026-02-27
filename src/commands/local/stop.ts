/**
 * hydra local stop — Stop all running local containers.
 *
 * Bash equivalent: stop() in scripts/hydra → stop_containers() in scripts/hydra-operations/stop.sh
 *
 * Stops layers in reverse order:
 *   global-l0 → dag-l1 → metagraph-l0 → currency-l1 → data-l1 → node containers → grafana
 *
 * Note: bash stops global-l0 first (not last). This matches stop.sh order.
 *
 * External dependencies: docker (≥26.0.0), ansible-playbook (≥2.16)
 */
import * as path from 'node:path';
import { Command } from '@oclif/core';

import { findConfigFile } from '../../config/loader.js';
import { loadAndValidateConfig } from '../../config/schema.js';
import { requireDependencies, LOCAL_DEPS } from '../../utils/dependencies.js';
import { logger } from '../../utils/logger.js';
import { buildAnsiblePaths, runAnsible } from '../../utils/docker.js';

export default class Stop extends Command {
  static override id = 'local:stop'

  static override description = 'Stop all running local metagraph containers'

  static override examples = [
    '<%= config.bin %> local stop',
    '<%= config.bin %> stop',
  ]

  static override aliases = ['stop']

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

    // ----------------------------------------------------------------
    // 2. Check tool dependencies
    // ----------------------------------------------------------------
    requireDependencies(LOCAL_DEPS);

    // ----------------------------------------------------------------
    // 3. Stop layers (matches stop_containers() order in stop.sh)
    // ----------------------------------------------------------------
    logger.section('STOP');

    const ansible = buildAnsiblePaths(infraPath);
    const nodesJson = JSON.stringify(config.nodes);
    const baseEnv: NodeJS.ProcessEnv = {
      NODES: nodesJson,
      INFRA_PATH: infraPath,
    };
    const layers = config.layers;

    // Stop in the same order as bash stop.sh: gl0, dag-l1, metagraph-l0, currency-l1, data-l1,
    // then containers, then grafana
    if (layers.includes('global-l0')) {
      await this.tryStopLayer('global-l0', ansible.globalL0Stop, baseEnv);
    }

    if (layers.includes('dag-l1')) {
      await this.tryStopLayer('dag-l1', ansible.dagL1Stop, baseEnv);
    }

    if (layers.includes('metagraph-l0')) {
      await this.tryStopLayer('metagraph-l0', ansible.metagraphL0Stop, baseEnv);
    }

    if (layers.includes('currency-l1') || layers.includes('metagraph-l1-currency')) {
      await this.tryStopLayer('currency-l1', ansible.currencyL1Stop, baseEnv);
    }

    if (layers.includes('data-l1') || layers.includes('metagraph-l1-data')) {
      await this.tryStopLayer('data-l1', ansible.dataL1Stop, baseEnv);
    }

    // Stop Docker node containers
    await this.tryStopLayer('Docker node containers', ansible.containersStop, baseEnv);

    // Stop Grafana (if configured)
    if (config.monitoring?.grafana.enabled) {
      await this.tryStopLayer('Grafana', ansible.grafanaStop, baseEnv);
    }
  }

  // ------------------------------------------------------------------
  // Private: run one Ansible stop playbook with success/error logging
  // ------------------------------------------------------------------

  private async tryStopLayer(
    layerName: string,
    playbookPath: string,
    env: NodeJS.ProcessEnv
  ): Promise<void> {
    const spinner = logger.spin(`Stopping ${layerName}...`);

    try {
      await runAnsible(playbookPath, {}, env);
      spinner.succeed(`${layerName} stopped`);
    } catch {
      spinner.fail(`Failed to stop ${layerName}`);
      // Non-fatal: log warning and continue stopping other layers
      logger.warn(
        `Ansible playbook failed for ${layerName}. Check the output above. You may need to manually stop: docker stop <container>`
      );
    }
  }
}
