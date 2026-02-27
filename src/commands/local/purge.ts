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

import { loadConfig, findConfigFile } from '../../config/loader.js';
import { requireDependencies, LOCAL_DEPS } from '../../utils/dependencies.js';
import * as logger from '../../utils/logger.js';
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
    // 3. Destroy containers (matches destroy_containers() call in bash)
    // ----------------------------------------------------------------
    logger.header('################################## PURGE ##################################');
    logger.detail('Starting purging containers ...');

    const ansible = buildAnsiblePaths(infraPath);
    const nodesJson = JSON.stringify(config.nodes);
    const baseEnv: NodeJS.ProcessEnv = {
      NODES: nodesJson,
      INFRA_PATH: infraPath,
    };

    await runAnsible(ansible.containersDestroy, {}, baseEnv);

    // ----------------------------------------------------------------
    // 4. Remove Docker images (matches destroy_images() in purge.sh)
    // ----------------------------------------------------------------
    await this.destroyImages();

    // ----------------------------------------------------------------
    // 5. Optionally delete source/project/<project_name>
    // ----------------------------------------------------------------
    if (flags.delete_project && config.project_name) {
      const projectDir = path.join(sourcePath, 'project', config.project_name);
      if (fs.existsSync(projectDir)) {
        logger.info(`Deleting project directory: source/project/${config.project_name}`);
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
    logger.info('Starting to remove the images...');

    // Get all metagraph-ubuntu-* image IDs
    const ubuntuImagesResult = await execa(
      'docker', ['images', '-q', 'metagraph-ubuntu-*'],
      { reject: false, env: process.env }
    );

    // metagraph-base-image
    logger.detail('Removing image metagraph-base-image');
    await execa('docker', ['rmi', '-f', 'metagraph-base-image'], {
      reject: false, env: process.env
    });
    logger.success('Removed');

    // metagraph-ubuntu-* (all tessellation base images)
    logger.detail('Removing image metagraph-ubuntu-*');
    if (ubuntuImagesResult.stdout.trim()) {
      const imageIds = ubuntuImagesResult.stdout.trim().split('\n').filter(Boolean);
      await execa('docker', ['rmi', '-f', ...imageIds], {
        reject: false, env: process.env
      });
    }
    logger.success('Removed');

    // grafana
    logger.detail('Removing image grafana/grafana-oss');
    await execa('docker', ['rmi', '-f', 'grafana/grafana-oss'], {
      reject: false, env: process.env
    });
    logger.success('Removed');

    // prometheus
    logger.detail('Removing image prom/prometheus');
    await execa('docker', ['rmi', '-f', 'prom/prometheus'], {
      reject: false, env: process.env
    });
    logger.success('Removed');

    // Prune dangling images
    await execa('docker', ['image', 'prune', '-f'], {
      stdio: 'inherit', env: process.env
    });
  }
}
