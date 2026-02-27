/**
 * hydra remote logs — Tail log files on a remote host via SSH.
 *
 * Bash equivalent: remote-logs() in scripts/hydra
 *                  → remote_logs() in scripts/hydra-operations/remote-logs.sh
 *
 * SSHes into the specified remote host and runs `tail -f -n {n}` on the
 * layer's log file. Host IPs, users, and SSH key paths are read from
 * the Ansible hosts file.
 *
 * SSH command for node hosts (metagraph-l0, currency-l1, data-l1):
 *   ssh -i <keyFile> <user>@<host>
 *     "cd code/<layer> && if [ -f logs/app.log ]; then tail -f logs/app.log -n <n>; ..."
 *
 * SSH command for monitoring host:
 *   ssh -i <keyFile> <user>@<host>
 *     "cd code/dor-metagraph-integrationnet-monitoring-service/logs;
 *      latest_file=$(ls -t application-* 2>/dev/null | head -n 1); ..."
 *
 * Press Ctrl+C to stop streaming.
 */
import * as path from 'node:path';
import { Args, Command, Flags } from '@oclif/core';
import { execa } from 'execa';
import { loadConfig, findConfigFile } from '../../config/loader.js';
import { header, info } from '../../utils/logger.js';
import { parseHosts } from '../../utils/ansible.js';

const VALID_HOSTS = ['node-1', 'node-2', 'node-3', 'monitoring'] as const;
const VALID_LAYERS = ['metagraph-l0', 'currency-l1', 'data-l1', 'monitoring'] as const;

type ValidHost = (typeof VALID_HOSTS)[number];
type ValidLayer = (typeof VALID_LAYERS)[number];

export default class RemoteLogs extends Command {
  static override id = 'remote:logs';

  static override description =
    'Tail log files on a remote cloud host via SSH (Ctrl+C to stop)';

  static override examples = [
    '<%= config.bin %> remote logs node-1 metagraph-l0',
    '<%= config.bin %> remote logs node-2 currency-l1 -n 50',
    '<%= config.bin %> remote logs monitoring monitoring',
    '<%= config.bin %> remote-logs node-1 metagraph-l0',
  ];

  static override aliases = ['remote-logs', 'remote:remote-logs'];

  static override args = {
    hostName: Args.string({
      description: 'Remote host name: node-1 | node-2 | node-3 | monitoring',
      required: true,
      options: [...VALID_HOSTS],
    }),
    layer: Args.string({
      description: 'Layer name: metagraph-l0 | currency-l1 | data-l1 | monitoring',
      required: true,
      options: [...VALID_LAYERS],
    }),
  };

  static override flags = {
    n: Flags.integer({
      char: 'n',
      description: 'Number of log lines to show initially (tail -n)',
      default: 10,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RemoteLogs);

    const hostName = args.hostName as ValidHost;
    const layer = args.layer as ValidLayer;
    const lineCount = flags.n;

    header('REMOTE LOGS');

    const configPath = findConfigFile(process.cwd());
    if (!configPath) {
      this.error(
        'Could not find euclid.json. Run this command from inside an Euclid project directory.'
      );
    }
    const rootPath = path.dirname(configPath);
    const config = loadConfig(configPath);

    const hostsFile = path.resolve(rootPath, config.deploy.ansible.hosts);
    const hosts = await parseHosts(hostsFile);

    info('NOTE: TO STOP LOGGING PRESS CTRL + C');
    this.log('');

    if (hostName === 'monitoring') {
      // SSH to monitoring host
      const monitoringHosts = hosts.monitoring?.hosts;
      const monitoringInfo = monitoringHosts?.['monitoring-1'];

      if (!monitoringInfo) {
        this.error('No monitoring-1 host found in Ansible hosts file.');
      }

      const host = String(monitoringInfo.ansible_host);
      const user = String(monitoringInfo.ansible_user);
      const privateKey = String(monitoringInfo.ansible_ssh_private_key_file);

      this.log('SSH to the node...');

      // Matches remote-logs.sh monitoring SSH command exactly
      const remoteCmd =
        `echo 'Node connected'; ` +
        `cd code/dor-metagraph-integrationnet-monitoring-service/logs; ` +
        `latest_file=$(ls -t application-* 2>/dev/null | head -n 1); ` +
        `if [[ -n $latest_file ]]; then ` +
        `tail -f "$latest_file" -n ${lineCount}; ` +
        `else echo 'No application log file found'; fi`;

      await execa('ssh', ['-i', privateKey, `${user}@${host}`, remoteCmd], {
        stdio: 'inherit',
      });
    } else {
      // SSH to a node host (node-1, node-2, node-3)
      const nodeHosts = hosts.nodes?.hosts;
      const nodeInfo = nodeHosts?.[hostName];

      if (!nodeInfo) {
        this.error(`No host "${hostName}" found in Ansible hosts file.`);
      }

      const host = String(nodeInfo.ansible_host);
      const user = String(nodeInfo.ansible_user);
      const privateKey = String(nodeInfo.ansible_ssh_private_key_file);

      this.log('SSH to the node...');

      // Matches remote-logs.sh node SSH command exactly
      const remoteCmd =
        `echo 'Node connected'; ` +
        `cd code/${layer} && ` +
        `if [ -f logs/app.log ]; then ` +
        `tail -f logs/app.log -n ${lineCount}; ` +
        `else echo 'Log file not found'; fi`;

      await execa('ssh', ['-i', privateKey, `${user}@${host}`, remoteCmd], {
        stdio: 'inherit',
      });
    }
  }
}
