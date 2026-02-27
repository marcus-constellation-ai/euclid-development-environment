/**
 * hydra remote start-monitoring-service — Start the monitoring service on the remote host.
 *
 * Bash equivalent: remote-start-monitoring-service() / remote_start_monitoring_service() alias
 *                  → remote_start_monitoring_service() in
 *                    scripts/hydra-operations/remote-start-monitoring-service.sh
 *
 * Ansible invocation (exact match of bash):
 *   ANSIBLE_DEPRECATION_WARNINGS=False
 *   ansible-playbook -e "force_restart=true|false"
 *                    -i <hostsFile>
 *                    <monitoringStartPlaybook>
 *
 * The start playbook runs either:
 *   - yarn start         (force_restart=false)
 *   - yarn force-restart (force_restart=true)
 */
import * as path from 'node:path';
import { Command, Flags } from '@oclif/core';
import { loadConfig, findConfigFile } from '../../config/loader.js';
import { header, info, success } from '../../utils/logger.js';
import { runPlaybook, checkMonitoringHostFile } from '../../utils/ansible.js';

export default class StartMonitoringService extends Command {
  static override id = 'remote:start-monitoring-service';

  static override description =
    'Start the metagraph monitoring service on the remote monitoring host via Ansible';

  static override examples = [
    '<%= config.bin %> remote start-monitoring-service',
    '<%= config.bin %> remote start-monitoring-service --force-restart',
    '<%= config.bin %> remote-start-monitoring-service',
    '<%= config.bin %> remote_start_monitoring_service',
  ];

  static override aliases = [
    'remote-start-monitoring-service',
    'remote_start_monitoring_service',
    'remote:remote-start-monitoring-service',
    'remote:remote_start_monitoring_service',
  ];

  static override flags = {
    'force-restart': Flags.boolean({
      description:
        'Force restart the monitoring service (runs yarn force-restart instead of yarn start)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StartMonitoringService);

    header('REMOTE START MONITORING SERVICE');

    const configPath = findConfigFile(process.cwd());
    if (!configPath) {
      this.error(
        'Could not find euclid.json. Run this command from inside an Euclid project directory.'
      );
    }
    const rootPath = path.dirname(configPath);
    const config = loadConfig(configPath);

    const hostsFile = path.resolve(rootPath, config.deploy.ansible.hosts);
    const startPlaybook = path.resolve(
      rootPath,
      config.deploy.ansible.monitoring.playbooks.start
    );

    // Validate monitoring host (IP, SSH key in agent)
    await checkMonitoringHostFile(hostsFile);

    info('Starting monitoring service on remote host...');
    this.log('');

    // Extra vars — exact match of bash -e flag in remote-start-monitoring-service.sh
    const extraVars: Record<string, string> = {
      force_restart: String(flags['force-restart']),
    };

    // ANSIBLE_DEPRECATION_WARNINGS=False is included in ANSIBLE_QUIET_ENV inside runPlaybook
    await runPlaybook(startPlaybook, extraVars, hostsFile);

    success('Monitoring service started successfully.');
  }
}
