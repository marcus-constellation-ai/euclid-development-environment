/**
 * hydra remote start — Start the metagraph on remote cloud hosts via Ansible.
 *
 * Bash equivalent: remote-start() / remote_start() alias
 *                  → remote_start_metagraph() in scripts/hydra-operations/remote-start.sh
 */
import * as path from 'node:path';
import { Command, Flags } from '@oclif/core';
import { findConfigFile } from '../../config/loader.js';
import { loadAndValidateConfig } from '../../config/schema.js';
import { requireDependencies, REMOTE_DEPS } from '../../utils/dependencies.js';
import { logger } from '../../utils/logger.js';
import {
  runPlaybook,
  checkNodesHostFile,
  getSecondSignerInfo,
} from '../../utils/ansible.js';
import { confirmForceGenesis } from '../../utils/prompt.js';

export default class Start extends Command {
  static override id = 'remote:start';

  static override description =
    'Start the metagraph on remote cloud hosts via Ansible';

  static override examples = [
    '<%= config.bin %> remote start',
    '<%= config.bin %> remote start --force-genesis',
    '<%= config.bin %> remote start --force-owner-message --force-staking-message',
    '<%= config.bin %> remote-start',
    '<%= config.bin %> remote_start',
  ];

  static override aliases = [
    'remote-start',
    'remote_start',
    'remote:remote-start',
    'remote:remote_start',
  ];

  static override flags = {
    'force-genesis': Flags.boolean({
      description:
        'Force metagraph to run as genesis (wipes remote state — prompts for confirmation)',
      default: false,
    }),
    'force-owner-message': Flags.boolean({
      description: 'Force re-sending the owner signing message on startup',
      default: false,
    }),
    'force-staking-message': Flags.boolean({
      description: 'Force re-sending the staking signing message on startup',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Start);

    logger.section('REMOTE START');

    // Load config and derive paths
    const configPath = findConfigFile(process.cwd());
    if (!configPath) {
      logger.error(
        '✖  Command failed: remote start\n   Reason: euclid.json not found\n   Fix:    Run this command from inside an Euclid project directory'
      );
    }
    const rootPath = path.dirname(configPath!);
    const config = loadAndValidateConfig(configPath!);

    // Check required tools
    requireDependencies(REMOTE_DEPS);

    // Validate owner ≠ staking
    const ownerFile = config.snapshot_fees.owner.key_file.name;
    const stakingFile = config.snapshot_fees.staking.key_file.name;
    if (ownerFile === stakingFile) {
      logger.error(
        `✖  Command failed: remote start\n   Reason: Owner and staking p12 files must be different. Both are currently "${ownerFile}"\n   Fix:    Update snapshot_fees in euclid.json`
      );
    }

    // Confirm force-genesis
    if (flags['force-genesis']) {
      if (!(await confirmForceGenesis())) return;
    }

    // Validate owner params when force_owner_message set (matches bash check)
    const ownerAlias = config.snapshot_fees.owner.key_file.alias;
    const ownerPassword = config.snapshot_fees.owner.key_file.password;
    if (flags['force-owner-message']) {
      if (!ownerFile || !ownerAlias || !ownerPassword) {
        logger.error(
          '✖  Command failed: remote start\n   Reason: --force-owner-message requires key_file.name, alias, and password set in snapshot_fees.owner\n   Fix:    Update snapshot_fees.owner in euclid.json'
        );
      }
    }

    // Validate staking params when force_staking_message set (matches bash check)
    const stakingAlias = config.snapshot_fees.staking.key_file.alias;
    const stakingPassword = config.snapshot_fees.staking.key_file.password;
    if (flags['force-staking-message']) {
      if (!stakingFile || !stakingAlias || !stakingPassword) {
        logger.error(
          '✖  Command failed: remote start\n   Reason: --force-staking-message requires key_file.name, alias, and password set in snapshot_fees.staking\n   Fix:    Update snapshot_fees.staking in euclid.json'
        );
      }
    }

    // Resolve paths
    const hostsFile = path.resolve(rootPath, config.deploy.ansible.hosts);
    const startPlaybook = path.resolve(rootPath, config.deploy.ansible.nodes.playbooks.start);

    // Validate remote hosts
    await checkNodesHostFile(hostsFile);

    logger.step('Starting on remote hosts...');

    // Compute second signer info
    const ownerSecondSigner = getSecondSignerInfo(config.nodes, ownerFile);
    const stakingSecondSigner = getSecondSignerInfo(config.nodes, stakingFile);

    // Extra vars — exact match of bash -e flags in remote-start.sh
    const extraVars: Record<string, string> = {
      force_genesis: String(flags['force-genesis']),
      force_owner_message: String(flags['force-owner-message']),
      force_staking_message: String(flags['force-staking-message']),
      owner_p12_file_name: ownerFile,
      owner_p12_alias: ownerAlias,
      owner_p12_password: ownerPassword,
      second_signer_p12_file_name_owner: ownerSecondSigner.name,
      second_signer_p12_alias_owner: ownerSecondSigner.alias,
      second_signer_p12_password_owner: ownerSecondSigner.password,
      staking_p12_file_name: stakingFile,
      staking_p12_alias: stakingAlias,
      staking_p12_password: stakingPassword,
      second_signer_p12_file_name_staking: stakingSecondSigner.name,
      second_signer_p12_alias_staking: stakingSecondSigner.alias,
      second_signer_p12_password_staking: stakingSecondSigner.password,
      jvm_min_heap: config.deploy.jvm.min_heap ?? '1g',
      jvm_max_heap: config.deploy.jvm.max_heap ?? '2g',
      jvm_metaspace_size: config.deploy.jvm.metaspace_size ?? '256m',
      jvm_max_metaspace_size: config.deploy.jvm.max_metaspace_size ?? '512m',
      jvm_additional_opts: config.deploy.jvm.additional_opts ?? '',
    };

    // Env vars for ansible lookup('env', ...) in playbook
    const ansibleEnv: NodeJS.ProcessEnv = {
      NODES: JSON.stringify(config.nodes),
      DEPLOY_NETWORK_NAME: config.deploy.network,
      DEPLOY_NETWORK_HOST_IP: String(config.deploy.gl0Node.ip),
      DEPLOY_NETWORK_HOST_PUBLIC_PORT: String(config.deploy.gl0Node.publicPort),
      DEPLOY_NETWORK_HOST_ID: String(config.deploy.gl0Node.id),
    };

    const spinner = logger.spin('Running Ansible start playbook...');
    try {
      await runPlaybook(startPlaybook, extraVars, hostsFile, ansibleEnv);
      spinner.succeed('Remote start completed');
    } catch (err) {
      spinner.fail('Remote start failed');
      logger.error(
        `✖  Command failed: remote start\n   Reason: Ansible playbook failed — ${(err as Error).message}\n   Fix:    Check Ansible output above and verify SSH keys are loaded`
      );
    }

    logger.success('Remote start completed successfully.');
  }
}
