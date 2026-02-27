/**
 * hydra local purge — Destroy all containers, networks, genesis files, AND Docker images.
 *
 * Bash equivalent: purge() in scripts/hydra → purge_containers() in scripts/hydra-operations/purge.sh
 *
 * Superset of destroy: also removes the built Docker images:
 *   - metagraph-base-image:latest
 *   - metagraph-ubuntu-* (all tessellation ubuntu images)
 *   - grafana/grafana-oss
 *   - prom/prometheus
 *
 * Then runs `docker image prune -f` to remove dangling images.
 *
 * External dependencies: docker (≥26.0.0), ansible-playbook (≥2.16)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command, Flags } from '@oclif/core';
import { execa } from 'execa';

import { findConfigFile } from '../../config/loader.js';
import { loadAndValidateConfig } from '../../config/schema.js';
import { requireDependencies, LOCAL_DEPS } from '../../utils/dependencies.js';
import { logger } from '../../utils/logger.js';
import { confirmYN } from '../../utils/prompt.js';
import { buildAnsiblePaths, runAnsible } from '../../utils/docker.js';

export default class Purge extends Command {
  static override id = 'local:purge'

  static override description =
    'Destroy all containers, Docker images, networks, and genesis files (full reset)'

  static override examples = [
    '<%= config.bin %> local purge',
    '<%= config.bin %> local purge --delete_project',
    '<%= config.bin %> purge',
  ]

  static override aliases = ['purge']

  static override flags = {
    delete_project: Flags.boolean({
      description: 'Also delete the custom project source directory (source/project/<project_name>)',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Purge);

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
    // 3. Destroy containers (matches destroy_containers() call in bash)
    // ----------------------------------------------------------------
    logger.section('PURGE');

    if (!(await confirmYN('⚠  This will destroy all containers AND delete all images. Continue?'))) {
      return;
    }

    const destroySpinner = logger.spin('Destroying containers...');
    const ansible = buildAnsiblePaths(infraPath);
    const nodesJson = JSON.stringify(config.nodes);
    const baseEnv: NodeJS.ProcessEnv = {
      NODES: nodesJson,
      INFRA_PATH: infraPath,
    };

    try {
      await runAnsible(ansible.containersDestroy, {}, baseEnv);
      destroySpinner.succeed('Containers destroyed');
    } catch (err) {
      destroySpinner.fail('Failed to destroy containers');
      logger.error(
        `✖  Command failed: local purge\n   Reason: Ansible destroy playbook failed — ${(err as Error).message}\n   Fix:    Check Docker is running and try again`
      );
    }

    // ----------------------------------------------------------------
    // 4. Remove Docker images (matches destroy_images() in purge.sh)
    // ----------------------------------------------------------------
    await this.destroyImages();

    // ----------------------------------------------------------------
    // 5. Optionally delete source/project/<project_name>
    // ----------------------------------------------------------------
    if (flags.delete_project && config.projectName) {
      const projectDir = path.join(sourcePath, 'project', config.projectName);
      if (fs.existsSync(projectDir)) {
        logger.step(`Deleting project directory: source/project/${config.projectName}`);
        fs.rmSync(projectDir, { recursive: true, force: true });
        logger.success('Project directory deleted');
      }
    }

    logger.success('Purge complete');
  }

  // ------------------------------------------------------------------
  // Private: remove Docker images — matches destroy_images() in purge.sh
  // ------------------------------------------------------------------

  private async destroyImages(): Promise<void> {
    logger.step('Removing Docker images...');

    // Get all metagraph-ubuntu-* image IDs
    const ubuntuImagesResult = await execa(
      'docker', ['images', '-q', 'metagraph-ubuntu-*'],
      { reject: false, env: process.env }
    );

    // metagraph-base-image
    const baseImageSpinner = logger.spin('Removing metagraph-base-image...');
    await execa('docker', ['rmi', '-f', 'metagraph-base-image'], {
      reject: false, env: process.env
    });
    baseImageSpinner.succeed('metagraph-base-image removed');

    // metagraph-ubuntu-* (all tessellation base images)
    const ubuntuSpinner = logger.spin('Removing metagraph-ubuntu-* images...');
    if (ubuntuImagesResult.stdout.trim()) {
      const imageIds = ubuntuImagesResult.stdout.trim().split('\n').filter(Boolean);
      await execa('docker', ['rmi', '-f', ...imageIds], {
        reject: false, env: process.env
      });
    }
    ubuntuSpinner.succeed('metagraph-ubuntu images removed');

    // grafana
    const grafanaSpinner = logger.spin('Removing grafana/grafana-oss...');
    await execa('docker', ['rmi', '-f', 'grafana/grafana-oss'], {
      reject: false, env: process.env
    });
    grafanaSpinner.succeed('grafana/grafana-oss removed');

    // prometheus
    const prometheusSpinner = logger.spin('Removing prom/prometheus...');
    await execa('docker', ['rmi', '-f', 'prom/prometheus'], {
      reject: false, env: process.env
    });
    prometheusSpinner.succeed('prom/prometheus removed');

    // Prune dangling images
    const pruneSpinner = logger.spin('Pruning dangling images...');
    await execa('docker', ['image', 'prune', '-f'], {
      stdio: 'inherit', env: process.env
    });
    pruneSpinner.succeed('Dangling images pruned');
  }
}
