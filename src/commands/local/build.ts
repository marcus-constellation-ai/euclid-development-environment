/**
 * hydra local build — Build Docker images for the metagraph project.
 *
 * Bash equivalent: build() in scripts/hydra → build_containers() in scripts/hydra-operations/build.sh
 *
 * Two-phase build:
 *   1. Build metagraph-ubuntu-{TESSELLATION_VERSION_NAME} image (downloads tessellation JARs)
 *   2. Build metagraph-base-image (compiles the user's Scala project via sbt)
 *   3. Copy JARs from metagraph-base-image to infra/shared/jars/
 *
 * External dependencies: docker, docker compose / docker-compose (≥26.0.0)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command, Flags } from '@oclif/core';
import { execa } from 'execa';

import { loadConfig, findConfigFile } from '../../config/loader.js';
import { requireDependencies, LOCAL_DEPS } from '../../utils/dependencies.js';
import * as logger from '../../utils/logger.js';
import {
  dockerCompose,
  runDocker,
  runDockerCapture,
  getTessellationVersionName,
  getTessellationVersionSemver,
  getCheckoutTessellationVersion,
  checkP12Files,
  projectDirectoryExists,
} from '../../utils/docker.js';

export default class Build extends Command {
  static override id = 'local:build'

  static override description =
    'Build Docker images for the metagraph project (ubuntu base image + metagraph base image)'

  static override examples = [
    '<%= config.bin %> local build',
    '<%= config.bin %> local build --no_cache',
    '<%= config.bin %> local build --no_cache --run',
    '<%= config.bin %> build',
  ]

  /**
   * Backward-compatible top-level aliases.
   * Allows `hydra build` in addition to `hydra local build`.
   */
  static override aliases = ['build']

  static override flags = {
    no_cache: Flags.boolean({
      description: 'Build Docker containers with --no-cache (forces full rebuild)',
      default: false,
    }),
    run: Flags.boolean({
      description: 'Run containers (start-genesis) immediately after a successful build',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Build);

    // ----------------------------------------------------------------
    // 1. Locate and load euclid.json
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
    // 3. Pre-build validations (matches build_containers() in bash)
    // ----------------------------------------------------------------
    logger.buildBanner();

    // Tessellation version must not start with 'v'
    if (config.tessellation_version.startsWith('v')) {
      this.error(
        `tessellation_version "${config.tessellation_version}" must not start with "v". ` +
          'Remove the "v" prefix from tessellation_version in euclid.json.'
      );
    }

    // All node p12 files must exist
    const missingP12 = checkP12Files(sourcePath, config.nodes);
    if (missingP12.length > 0) {
      this.error(
        `Missing p12 files in source/p12-files/:\n  ${missingP12.join('\n  ')}\n` +
          'Copy the required p12 files before building.'
      );
    }

    // project_name must be set
    if (!config.project_name) {
      this.error('project_name is not set in euclid.json.');
    }

    // source/project/<project_name> must exist
    if (!projectDirectoryExists(sourcePath, config.project_name)) {
      this.error(
        `Project directory source/project/${config.project_name} does not exist. ` +
          'Run `hydra local install-template` first or create the project directory.'
      );
    }

    // At least 3 nodes required
    if (config.nodes.length < 3) {
      this.error(
        `At least 3 nodes are required in euclid.json. Found: ${config.nodes.length}`
      );
    }

    // ----------------------------------------------------------------
    // 4. Compute version-derived values
    // ----------------------------------------------------------------
    const tessVersion = config.tessellation_version;
    const refType = config.ref_type;
    const tessVersionName = getTessellationVersionName(tessVersion, refType);
    const tessVersionSemver = getTessellationVersionSemver(tessVersion, refType);
    const checkoutVersion = getCheckoutTessellationVersion(tessVersion);

    // ----------------------------------------------------------------
    // 5. Build metagraph-ubuntu image (skip if already built)
    // ----------------------------------------------------------------
    await this.buildMetagraphUbuntu({
      infraPath,
      tessVersion,
      tessVersionName,
      tessVersionSemver,
      checkoutVersion,
      refType,
      noCache: flags.no_cache,
    });

    // ----------------------------------------------------------------
    // 6. Build metagraph-base-image (compile Scala project)
    // ----------------------------------------------------------------
    await this.buildMetagraphBaseImage({
      infraPath,
      tessVersionName,
      projectName: config.project_name,
      layers: config.layers,
      noCache: flags.no_cache,
    });

    // ----------------------------------------------------------------
    // 7. Optionally start containers (--run flag)
    // ----------------------------------------------------------------
    if (flags.run) {
      logger.info('Starting containers after build...');
      const { default: StartGenesis } = await import('./start-genesis.js');
      await StartGenesis.run([], this.config);
    }
  }

  // ------------------------------------------------------------------
  // Private: build metagraph-ubuntu-<version> base image
  // ------------------------------------------------------------------

  private async buildMetagraphUbuntu(opts: {
    infraPath: string;
    tessVersion: string;
    tessVersionName: string;
    tessVersionSemver: string;
    checkoutVersion: string;
    refType: 'tag' | 'branch';
    noCache: boolean;
  }): Promise<void> {
    const imageName = `metagraph-ubuntu-${opts.tessVersionName}`;

    // Skip build if image already exists (matches bash check)
    const existing = await runDockerCapture(['images', '-q', imageName]);
    if (existing) {
      logger.success(`Ubuntu for tessellation ${opts.tessVersion} already built, skipping...`);
      return;
    }

    logger.detail('');
    logger.detail('');
    logger.detail(
      `Building metagraph ubuntu for tessellation ${opts.tessVersion} in image name ${imageName}`
    );

    const ubuntuDir = path.join(opts.infraPath, 'metagraph-ubuntu');
    const buildArgs = [
      '--build-arg', `TESSELLATION_VERSION=${opts.tessVersion}`,
      '--build-arg', `TESSELLATION_VERSION_SEMVER=${opts.tessVersionSemver}`,
      '--build-arg', `CHECKOUT_TESSELLATION_VERSION=${opts.checkoutVersion}`,
      '--build-arg', `TESSELLATION_VERSION_IS_TAG_OR_BRANCH=${opts.refType}`,
    ];

    if (opts.noCache) buildArgs.push('--no-cache');

    await dockerCompose(['build', ...buildArgs], ubuntuDir);

    logger.success(`Ubuntu for tessellation ${opts.tessVersion} built`);
  }

  // ------------------------------------------------------------------
  // Private: build metagraph-base-image (sbt compile + package JARs)
  // ------------------------------------------------------------------

  private async buildMetagraphBaseImage(opts: {
    infraPath: string;
    tessVersionName: string;
    projectName: string;
    layers: string[];
    noCache: boolean;
  }): Promise<void> {
    logger.detail('');
    logger.detail('');
    logger.detail('Building metagraph base image...');

    const baseImageDir = path.join(opts.infraPath, 'metagraph-base-image');

    // Check for custom Dockerfile override
    const customDockerfile = path.join(
      opts.infraPath, 'docker', 'custom', 'metagraph-base-image', 'Dockerfile'
    );
    const dockerfilePath = fs.existsSync(customDockerfile)
      ? customDockerfile
      : path.join(opts.infraPath, 'metagraph-base-image', 'Dockerfile');

    if (fs.existsSync(customDockerfile)) {
      logger.info('Custom Dockerfile detected...');
    }

    // Layer build flags — matches get_layers_to_run() in bash
    const shouldBuildGlobalL0 = opts.layers.includes('global-l0');
    const shouldBuildDagL1 = opts.layers.includes('dag-l1');
    const shouldBuildMetagraphL0 = opts.layers.includes('metagraph-l0');
    const shouldBuildCurrencyL1 =
      opts.layers.includes('currency-l1') || opts.layers.includes('metagraph-l1-currency');
    const shouldBuildDataL1 =
      opts.layers.includes('data-l1') || opts.layers.includes('metagraph-l1-data');

    const buildArgs = [
      '--build-arg', `TESSELLATION_VERSION_NAME=${opts.tessVersionName}`,
      '--build-arg', `TEMPLATE_NAME=${opts.projectName}`,
      '--build-arg', `SHOULD_BUILD_GLOBAL_L0=${shouldBuildGlobalL0}`,
      '--build-arg', `SHOULD_BUILD_DAG_L1=${shouldBuildDagL1}`,
      '--build-arg', `SHOULD_BUILD_METAGRAPH_L0=${shouldBuildMetagraphL0}`,
      '--build-arg', `SHOULD_BUILD_CURRENCY_L1=${shouldBuildCurrencyL1}`,
      '--build-arg', `SHOULD_BUILD_DATA_L1=${shouldBuildDataL1}`,
      '--build-arg', `METAGRAPH_BASE_IMAGE_DOCKERFILE=${dockerfilePath}`,
    ];

    if (opts.noCache) buildArgs.push('--no-cache');

    try {
      await dockerCompose(['build', ...buildArgs], baseImageDir, {
        METAGRAPH_BASE_IMAGE_DOCKERFILE: dockerfilePath,
      });
    } catch {
      this.error(
        'Error building Metagraph base image. Check the Docker build output for details.'
      );
    }

    logger.success('Metagraph base image built');

    // Copy JARs from built image to infra/shared/jars/
    await this.copyJarsFromImage(opts.infraPath);
  }

  // ------------------------------------------------------------------
  // Private: copy /code/shared_jars/ from container to infra/shared/jars/
  // ------------------------------------------------------------------

  private async copyJarsFromImage(infraPath: string): Promise<void> {
    logger.detail('Copying jars to infra/shared/jars...');
    const jarsDestination = path.join(infraPath, 'shared', 'jars');

    // Create a temporary container from the base image (do not start it)
    const containerId = await runDockerCapture(['create', 'metagraph-base-image']);

    try {
      await runDocker(['cp', `${containerId}:/code/shared_jars/.`, jarsDestination]);
    } finally {
      // Always clean up the temp container
      await execa('docker', ['rm', containerId], { reject: false, env: process.env });
    }

    logger.success('Jars copied to infra/shared/jars');
  }
}
