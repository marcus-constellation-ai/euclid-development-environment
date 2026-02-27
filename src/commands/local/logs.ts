/**
 * hydra local logs — Tail logs from a running local container for a specific layer.
 *
 * Bash equivalent: logs() in scripts/hydra → logs_containers() in scripts/hydra-operations/logs.sh
 *
 * Runs `docker exec {containerName} bash -c "cd {layer} && tail -f {layer}.log -n {n}"`
 * inside the specified container.
 *
 * Log files live at /{layer}/{layer}.log inside the container.
 * Valid layers: global-l0, dag-l1, metagraph-l0, currency-l1, data-l1
 *
 * External dependencies: docker (≥26.0.0)
 */
import * as readline from 'node:readline';
import { Args, Command, Flags } from '@oclif/core';
import { execa } from 'execa';
import chalk from 'chalk';

import { findConfigFile } from '../../config/loader.js';
import { requireDependencies, LOCAL_DEPS } from '../../utils/dependencies.js';
import { logger } from '../../utils/logger.js';

const VALID_LAYERS = ['global-l0', 'dag-l1', 'metagraph-l0', 'currency-l1', 'data-l1'] as const;
type ValidLayer = (typeof VALID_LAYERS)[number];

/** Color-code a single log line based on its content */
function colorize(line: string): string {
  if (line.includes('ERROR')) return chalk.red(line);
  if (line.includes('WARN')) return chalk.yellow(line);
  if (line.includes('DEBUG')) return chalk.gray(line);
  return chalk.white(line); // INFO or default
}

export default class Logs extends Command {
  static override id = 'local:logs'

  static override description = 'Tail logs from a running local container for a specific layer'

  static override examples = [
    '<%= config.bin %> local logs metagraph-node-1 global-l0',
    '<%= config.bin %> local logs metagraph-node-1 metagraph-l0 -n 50',
    '<%= config.bin %> logs metagraph-node-1 currency-l1',
  ]

  static override aliases = ['logs']

  static override args = {
    container_name: Args.string({
      description: 'Docker container name (e.g. metagraph-node-1)',
      required: true,
    }),
    layer: Args.string({
      description: `Layer name: ${VALID_LAYERS.join(' | ')}`,
      required: true,
    }),
  }

  static override flags = {
    n: Flags.integer({
      char: 'n',
      description: 'Number of log lines to show from the end of the file',
      default: 10,
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Logs);

    // ----------------------------------------------------------------
    // 1. Load config and check dependencies
    // ----------------------------------------------------------------
    const configFilePath = findConfigFile();
    if (!configFilePath) {
      logger.error('Could not find euclid.json. Run from inside an Euclid project directory.');
    }

    requireDependencies(LOCAL_DEPS);

    // ----------------------------------------------------------------
    // 2. Validate layer name
    // ----------------------------------------------------------------
    logger.section('LOGS');

    if (!VALID_LAYERS.includes(args.layer as ValidLayer)) {
      logger.error(
        `Invalid layer "${args.layer}"\n` +
          `   Valid layers are: ${VALID_LAYERS.join(', ')}`
      );
    }
    const layer = args.layer as ValidLayer;

    // ----------------------------------------------------------------
    // 3. Check the container is running
    // ----------------------------------------------------------------
    const containerCheck = await execa(
      'docker', ['ps', '--format', '{{.Names}}'],
      { reject: false, env: process.env }
    );

    const runningContainers = (containerCheck.stdout ?? '').split('\n').map((s) => s.trim());
    if (!runningContainers.includes(args.container_name)) {
      logger.error(
        `Container "${args.container_name}" is not running\n` +
          `   Start containers with: hydra local start-genesis`
      );
    }

    // ----------------------------------------------------------------
    // 4. Check the layer directory exists inside the container
    // ----------------------------------------------------------------
    const dirCheck = await execa(
      'docker', ['exec', args.container_name, 'bash', '-c', `[ -d '${layer}' ]`],
      { reject: false, env: process.env }
    );
    if (dirCheck.exitCode !== 0) {
      logger.error(
        `Layer "${layer}" directory does not exist in container ${args.container_name}\n` +
          `   Ensure the layer was started successfully`
      );
    }

    // ----------------------------------------------------------------
    // 5. Check the log file exists inside the container
    // ----------------------------------------------------------------
    const logFile = `${layer}/${layer}.log`;
    const fileCheck = await execa(
      'docker', ['exec', args.container_name, 'bash', '-c', `[ -f '${logFile}' ]`],
      { reject: false, env: process.env }
    );
    if (fileCheck.exitCode !== 0) {
      logger.error(
        `Log file "${logFile}" not found in container ${args.container_name}\n` +
          `   Wait for the layer to fully start before tailing logs`
      );
    }

    // ----------------------------------------------------------------
    // 6. Show streaming header
    // ----------------------------------------------------------------
    logger.step(
      `Streaming logs from ${chalk.bold(args.container_name)} / ${chalk.bold(layer)} (Ctrl+C to stop)`
    );

    // ----------------------------------------------------------------
    // 7. Stream with color-coded output and SIGINT handler
    // ----------------------------------------------------------------
    const proc = execa(
      'docker',
      [
        'exec',
        args.container_name,
        'bash',
        '-c',
        `cd ${layer} && tail -f ${layer}.log -n ${flags.n}`,
      ],
      {
        stdout: 'pipe',
        stderr: 'inherit',
        env: process.env,
        reject: false,
      }
    );

    // Handle Ctrl+C gracefully
    process.on('SIGINT', () => {
      process.stdout.write('\n');
      logger.info('Log stream stopped.');
      proc.kill('SIGTERM');
      process.exit(0);
    });

    // Color-code lines as they stream
    if (proc.stdout) {
      const rl = readline.createInterface({ input: proc.stdout, terminal: false });
      for await (const line of rl) {
        process.stdout.write(colorize(line) + '\n');
      }
    }

    await proc;
  }
}
