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

import { findConfigFile } from '../../config/loader.js';
import { loadAndValidateConfig } from '../../config/schema.js';
import { requireDependencies, LOCAL_DEPS } from '../../utils/dependencies.js';
import { logger } from '../../utils/logger.js';
import { formatElapsed } from '../../utils/time.js';
import {
  detectDockerCompose,
  runDocker,
  runDockerCapture,
  getTessellationVersionName,
  getTessellationVersionSemver,
  getCheckoutTessellationVersion,
  checkP12Files,
  projectDirectoryExists,
} from '../../utils/docker.js';

/** Return last N non-empty lines from a captured output string */
function lastLines(output: string, n: number): string {
  return output
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-n)
    .join('\n');
}

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
      logger.error(
        'Could not find euclid.json. Run from inside an Euclid project directory.'
      );
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
    // 3. Pre-build validations (matches build_containers() in bash)
    // ----------------------------------------------------------------
    logger.section('BUILD');

    // Tessellation version must not start with 'v'
    if (config.tessellation_version.startsWith('v')) {
      logger.error(
        `tessellation_version "${config.tessellation_version}" must not start with "v". ` +
          'Remove the "v" prefix from tessellation_version in euclid.json.'
      );
    }

    // All node p12 files must exist
    const missingP12 = checkP12Files(sourcePath, config.nodes);
    if (missingP12.length > 0) {
      logger.error(
        `Missing p12 files in source/p12-files/:\n  ${missingP12.join('\n  ')}\n` +
          'Copy the required p12 files before building.'
      );
    }

    // projectName must be set
    if (!config.projectName) {
      logger.error('projectName is not set in euclid.json.');
    }

    // source/project/<projectName> must exist
    if (!projectDirectoryExists(sourcePath, config.projectName)) {
      logger.error(
        `Project directory source/project/${config.projectName} does not exist. ` +
          'Run `hydra local install-template` first or create the project directory.'
      );
    }

    // At least 3 nodes required
    if (config.nodes.length < 3) {
      logger.error(
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

    // Determine total steps: ubuntu (1) + base-image (2) + copy JARs (3) + optional run (4)
    const totalSteps = flags.run ? 4 : 3;

    // ----------------------------------------------------------------
    // 5. Step 1 — Build metagraph-ubuntu image (skip if already built)
    // ----------------------------------------------------------------
    await this.buildMetagraphUbuntu({
      infraPath,
      tessVersion,
      tessVersionName,
      tessVersionSemver,
      checkoutVersion,
      refType,
      noCache: flags.no_cache,
      stepNum: 1,
      totalSteps,
    });

    // ----------------------------------------------------------------
    // 6. Step 2/3 — Build metagraph-base-image + copy JARs
    // ----------------------------------------------------------------
    await this.buildMetagraphBaseImage({
      infraPath,
      tessVersionName,
      projectName: config.projectName,
      layers: config.layers,
      noCache: flags.no_cache,
      stepNum: 2,
      totalSteps,
    });

    // ----------------------------------------------------------------
    // 7. Step 4 (optional) — start containers (--run flag)
    // ----------------------------------------------------------------
    if (flags.run) {
      logger.step(`Step 4/${totalSteps}  Starting containers...`);
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
    stepNum: number;
    totalSteps: number;
  }): Promise<void> {
    const imageName = `metagraph-ubuntu-${opts.tessVersionName}`;
    const stepLabel = `Step ${opts.stepNum}/${opts.totalSteps}`;

    // Skip build if image already exists (matches bash check)
    const existing = await runDockerCapture(['images', '-q', imageName]);
    if (existing) {
      logger.success(`${stepLabel}  metagraph-ubuntu already built, skipping...`);
      return;
    }

    logger.step(`${stepLabel}  Building metagraph-ubuntu base image...`);
    const spinner = logger.spin(`Building metagraph-ubuntu for tessellation ${opts.tessVersion}...`);
    const stepStart = Date.now();

    const ubuntuDir = path.join(opts.infraPath, 'metagraph-ubuntu');
    const buildArgs = [
      '--build-arg', `TESSELLATION_VERSION=${opts.tessVersion}`,
      '--build-arg', `TESSELLATION_VERSION_SEMVER=${opts.tessVersionSemver}`,
      '--build-arg', `CHECKOUT_TESSELLATION_VERSION=${opts.checkoutVersion}`,
      '--build-arg', `TESSELLATION_VERSION_IS_TAG_OR_BRANCH=${opts.refType}`,
    ];

    if (opts.noCache) buildArgs.push('--no-cache');

    const composeCmd = await detectDockerCompose();
    const mergedEnv = { ...process.env };

    let capturedOutput = '';
    try {
      const result = composeCmd === 'docker compose'
        ? await execa('docker', ['compose', 'build', ...buildArgs], {
            cwd: ubuntuDir, env: mergedEnv, reject: false, all: true,
          })
        : await execa('docker-compose', ['build', ...buildArgs], {
            cwd: ubuntuDir, env: mergedEnv, reject: false, all: true,
          });

      capturedOutput = result.all ?? (result.stdout + '\n' + result.stderr);

      if (result.exitCode !== 0) {
        spinner.fail(`${stepLabel}  metagraph-ubuntu build failed`);
        const tail = lastLines(capturedOutput, 10);
        if (tail) {
          logger.section('Last 10 lines of Docker output');
          process.stderr.write(tail + '\n');
        }
        logger.error(
          `${stepLabel} failed: Docker image build failed for metagraph-ubuntu-${opts.tessVersionName}\n` +
            `   Check Docker daemon is running and re-run with --no_cache`
        );
      }

      const elapsed = formatElapsed(Date.now() - stepStart);
      spinner.succeed(`${stepLabel}  metagraph-ubuntu ready   ${elapsed}`);
    } catch (err) {
      spinner.fail(`${stepLabel}  metagraph-ubuntu build failed`);
      const tail = lastLines(capturedOutput, 10);
      if (tail) {
        logger.section('Last 10 lines of Docker output');
        process.stderr.write(tail + '\n');
      }
      logger.error(
        `${stepLabel} failed: Docker image build failed for metagraph-ubuntu-${opts.tessVersionName}\n` +
          `   Error: ${(err as Error).message}\n` +
          `   Check Docker daemon is running and re-run with --no_cache`
      );
    }
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
    stepNum: number;
    totalSteps: number;
  }): Promise<void> {
    const baseImageDir = path.join(opts.infraPath, 'metagraph-base-image');
    const stepLabel = `Step ${opts.stepNum}/${opts.totalSteps}`;

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

    logger.step(`${stepLabel}  Building metagraph-base-image...`);
    const spinner = logger.spin('Building metagraph base image...');
    const stepStart = Date.now();

    const composeCmd = await detectDockerCompose();
    const mergedEnv = { ...process.env, METAGRAPH_BASE_IMAGE_DOCKERFILE: dockerfilePath };

    let capturedOutput = '';
    try {
      const result = composeCmd === 'docker compose'
        ? await execa('docker', ['compose', 'build', ...buildArgs], {
            cwd: baseImageDir, env: mergedEnv, reject: false, all: true,
          })
        : await execa('docker-compose', ['build', ...buildArgs], {
            cwd: baseImageDir, env: mergedEnv, reject: false, all: true,
          });

      capturedOutput = result.all ?? (result.stdout + '\n' + result.stderr);

      if (result.exitCode !== 0) {
        spinner.fail(`${stepLabel}  metagraph-base-image build failed`);
        const tail = lastLines(capturedOutput, 10);
        if (tail) {
          logger.section('Last 10 lines of Docker output');
          process.stderr.write(tail + '\n');
        }
        logger.error(
          `${stepLabel} failed: Docker build failed for metagraph-base-image\n` +
            `   Check the Docker build output above and re-run with --no_cache`
        );
      }

      const elapsed = formatElapsed(Date.now() - stepStart);
      spinner.succeed(`${stepLabel}  metagraph-base-image ready   ${elapsed}`);
    } catch (err) {
      spinner.fail(`${stepLabel}  metagraph-base-image build failed`);
      const tail = lastLines(capturedOutput, 10);
      if (tail) {
        logger.section('Last 10 lines of Docker output');
        process.stderr.write(tail + '\n');
      }
      logger.error(
        `${stepLabel} failed: Docker build failed for metagraph-base-image\n` +
          `   Error: ${(err as Error).message}`
      );
    }

    // Copy JARs (Step 3)
    await this.copyJarsFromImage(opts.infraPath, opts.stepNum + 1, opts.totalSteps);
  }

  // ------------------------------------------------------------------
  // Private: copy /code/shared_jars/ from container to infra/shared/jars/
  // ------------------------------------------------------------------

  private async copyJarsFromImage(
    infraPath: string,
    stepNum: number,
    totalSteps: number
  ): Promise<void> {
    const stepLabel = `Step ${stepNum}/${totalSteps}`;
    logger.step(`${stepLabel}  Copying JARs to infra/shared/jars...`);
    const spinner = logger.spin('Copying JARs to infra/shared/jars...');
    const stepStart = Date.now();
    const jarsDestination = path.join(infraPath, 'shared', 'jars');

    // Create a temporary container from the base image (do not start it)
    const containerId = await runDockerCapture(['create', 'metagraph-base-image']);

    try {
      await runDocker(['cp', `${containerId}:/code/shared_jars/.`, jarsDestination]);
      const elapsed = formatElapsed(Date.now() - stepStart);
      spinner.succeed(`${stepLabel}  JARs copied   ${elapsed}`);
    } catch (err) {
      spinner.fail(`${stepLabel}  Failed to copy JARs from image`);
      logger.error(
        `${stepLabel} failed: Could not copy JARs from metagraph-base-image container\n` +
          `   Error: ${(err as Error).message}\n` +
          `   Ensure the build succeeded and the container exists`
      );
    } finally {
      // Always clean up the temp container
      await execa('docker', ['rm', containerId], { reject: false, env: process.env });
    }
  }
}
