/**
 * hydra local logs — Tail logs from a running local container for a specific layer.
 *
 * Bash equivalent: logs() in scripts/hydra → logs_containers() in scripts/hydra-operations/logs.sh
 *
 * Runs `docker exec -it {containerName} bash -c "cd {layer} && tail -f {layer}.log -n {n}"`
 * inside the specified container.
 *
 * Log files live at /{layer}/{layer}.log inside the container.
 * Valid layers: global-l0, dag-l1, metagraph-l0, currency-l1, data-l1
 *
 * External dependencies: docker (≥26.0.0)
 */
import { Args, Command, Flags } from '@oclif/core';
import { execa } from 'execa';

import { findConfigFile } from '../../config/loader.js';
import { requireDependencies, LOCAL_DEPS } from '../../utils/dependencies.js';
import * as logger from '../../utils/logger.js';

const VALID_LAYERS = ['global-l0', 'dag-l1', 'metagraph-l0', 'currency-l1', 'data-l1'] as const;
type ValidLayer = (typeof VALID_LAYERS)[number];

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
      this.error('Could not find euclid.json. Run from inside an Euclid project directory.');
    }

    requireDependencies(LOCAL_DEPS);

    // ----------------------------------------------------------------
    // 2. Validate layer name
    // ----------------------------------------------------------------
    logger.header('################################## LOGS ##################################');
    logger.info('NOTE: TO STOP LOGGING PRESS CTRL + C');
    logger.detail('');

    if (!VALID_LAYERS.includes(args.layer as ValidLayer)) {
      logger.error(`Invalid layer "${args.layer}". Valid layers: ${VALID_LAYERS.join(', ')}`);
      this.exit(1);
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
      logger.error(`Container ${args.container_name} is not running.`);
      this.exit(1);
    }

    // ----------------------------------------------------------------
    // 4. Check the layer directory exists inside the container
    // ----------------------------------------------------------------
    const dirCheck = await execa(
      'docker', ['exec', args.container_name, 'bash', '-c', `[ -d '${layer}' ]`],
      { reject: false, env: process.env }
    );
    if (dirCheck.exitCode !== 0) {
      logger.error(`Layer ${layer} does not exist in ${args.container_name}`);
      this.exit(1);
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
      logger.error(`Layer ${layer} does not exist in ${args.container_name}`);
      this.exit(1);
    }

    // ----------------------------------------------------------------
    // 6. Tail the log file (real-time streaming via -f)
    // Matches bash: docker exec -it $container_name bash -c "cd $layer && tail -f $layer.log -n $argc_n"
    // ----------------------------------------------------------------
    await execa(
      'docker',
      [
        'exec',
        '-it',
        args.container_name,
        'bash',
        '-c',
        `cd ${layer} && tail -f ${layer}.log -n ${flags.n}`,
      ],
      {
        stdio: 'inherit',
        env: process.env,
        // Reject on non-zero exit only if not SIGINT (Ctrl+C)
        reject: false,
      }
    );
  }
}
