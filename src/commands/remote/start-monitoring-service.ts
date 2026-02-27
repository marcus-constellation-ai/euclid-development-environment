/**
 * hydra remote start-monitoring-service — Start the monitoring service on the remote host.
 *
 * Bash equivalent: remote-start-monitoring-service() / remote_start_monitoring_service() alias
 *                  → remote_start_monitoring_service() in
 *                    scripts/hydra-operations/remote-start-monitoring-service.sh
 */
import * as path from 'node:path';
import { Command, Flags } from '@oclif/core';
import { findConfigFile } from '../../config/loader.js';
import { loadAndValidateConfig } from '../../config/schema.js';
import { logger } from '../../utils/logger.js';
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

    logger.section('REMOTE START MONITORING SERVICE');

    const configPath = findConfigFile(process.cwd());
    if (!configPath) {
      logger.error(
        '✖  Command failed: remote start-monitoring-service\n   Reason: euclid.json not found\n   Fix:    Run this command from inside an Euclid project directory'
      );
    }
    const rootPath = path.dirname(configPath!);
    const config = loadAndValidateConfig(configPath!);

    const hostsFile = path.resolve(rootPath, config.deploy.ansible.hosts);
    const startPlaybook = path.resolve(
      rootPath,
      config.deploy.ansible.monitoring.playbooks.start
    );

    // Validate monitoring host (IP, SSH key in agent)
    await checkMonitoringHostFile(hostsFile);

    const spinner = logger.spin('Starting monitoring service on remote host...');
    const extraVars: Record<string, string> = {
      force_restart: String(flags['force-restart']),
    };

    try {
      await runPlaybook(startPlaybook, extraVars, hostsFile);
      spinner.succeed('Monitoring service started');
    } catch (err) {
      spinner.fail('Failed to start monitoring service');
      logger.error(
        `✖  Command failed: remote start-monitoring-service\n   Reason: Ansible playbook failed — ${(err as Error).message}\n   Fix:    Check Ansible output above and verify SSH keys are loaded`
      );
    }

    logger.success('Monitoring service started successfully.');
  }
}
