/**
 * hydra local destroy — Destroy all containers, networks, and genesis files.
 *
 * Bash equivalent: destroy() in scripts/hydra → destroy_containers() in scripts/hydra-operations/destroy.sh
 *
 * Runs the Ansible destroy playbook which:
 *   - Stops and removes all node containers (metagraph-node-1, -2, -3)
 *   - Removes the custom-network Docker network
 *   - Deletes infra/shared/genesis/ files (genesis.address, genesis.snapshot)
 *
 * External dependencies: docker (≥26.0.0), ansible-playbook (≥2.16)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command, Flags } from '@oclif/core';

import { findConfigFile } from '../../config/loader.js';
import { loadAndValidateConfig } from '../../config/schema.js';
import { requireDependencies, LOCAL_DEPS } from '../../utils/dependencies.js';
import { logger } from '../../utils/logger.js';
import { confirmYN } from '../../utils/prompt.js';
import { buildAnsiblePaths, runAnsible } from '../../utils/docker.js';

export default class Destroy extends Command {
  static override id = 'local:destroy'

  static override description =
    'Destroy all local containers, Docker network, and genesis files'

  static override examples = [
    '<%= config.bin %> local destroy',
    '<%= config.bin %> local destroy --delete_project',
    '<%= config.bin %> destroy',
  ]

  static override aliases = ['destroy']

  static override flags = {
    delete_project: Flags.boolean({
      description: 'Also delete the custom project source directory (source/project/<project_name>)',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Destroy);

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
    // 3. Run destroy playbook (matches destroy_containers() in bash)
    // ----------------------------------------------------------------
    logger.section('DESTROY');

    if (!(await confirmYN('⚠  This will stop and remove all containers. Continue?'))) {
      return;
    }

    const spinner = logger.spin('Destroying containers...');

    const ansible = buildAnsiblePaths(infraPath);
    const nodesJson = JSON.stringify(config.nodes);
    const baseEnv: NodeJS.ProcessEnv = {
      NODES: nodesJson,
      INFRA_PATH: infraPath,
    };

    try {
      await runAnsible(ansible.containersDestroy, {}, baseEnv);
      spinner.succeed('Containers destroyed');
    } catch (err) {
      spinner.fail('Failed to destroy containers');
      logger.error(
        `✖  Command failed: local destroy\n   Reason: Ansible destroy playbook failed — ${(err as Error).message}\n   Fix:    Check Docker is running and try again`
      );
    }

    // ----------------------------------------------------------------
    // 4. Optionally delete source/project/<project_name>
    // ----------------------------------------------------------------
    if (flags.delete_project && config.projectName) {
      const projectDir = path.join(sourcePath, 'project', config.projectName);
      if (fs.existsSync(projectDir)) {
        logger.step(`Deleting project directory: source/project/${config.projectName}`);
        fs.rmSync(projectDir, { recursive: true, force: true });
        logger.success('Project directory deleted');
      } else {
        logger.warn(`Project directory not found: source/project/${config.projectName}`);
      }
    }

    logger.success('Containers destroyed successfully');
  }
}
