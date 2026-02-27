/**
 * hydra remote start — Start the metagraph on remote cloud hosts via Ansible.
 *
 * Bash equivalent: remote-start() / remote_start() alias
 *                  → remote_start_metagraph() in scripts/hydra-operations/remote-start.sh
 *
 * Ansible variable injection (exact match of bash -e flags):
 *   -e force_genesis=true|false
 *   -e force_owner_message=true|false
 *   -e force_staking_message=true|false
 *   -e owner_p12_file_name=<name>
 *   -e owner_p12_alias=<alias>
 *   -e owner_p12_password=<password>
 *   -e second_signer_p12_file_name_owner=<name>
 *   -e second_signer_p12_alias_owner=<alias>
 *   -e second_signer_p12_password_owner=<password>
 *   -e staking_p12_file_name=<name>
 *   -e staking_p12_alias=<alias>
 *   -e staking_p12_password=<password>
 *   -e second_signer_p12_file_name_staking=<name>
 *   -e second_signer_p12_alias_staking=<alias>
 *   -e second_signer_p12_password_staking=<password>
 *   -e jvm_min_heap=<value>
 *   -e jvm_max_heap=<value>
 *   -e jvm_metaspace_size=<value>
 *   -e jvm_max_metaspace_size=<value>
 *   -e jvm_additional_opts=<value>
 *
 * Environment variables passed to ansible (via lookup('env', ...)):
 *   NODES                       = JSON.stringify(config.nodes)
 *   DEPLOY_NETWORK_NAME         = config.deploy.network.name
 *   DEPLOY_NETWORK_HOST_IP      = config.deploy.network.gl0_node.ip
 *   DEPLOY_NETWORK_HOST_PUBLIC_PORT = config.deploy.network.gl0_node.public_port
 *   DEPLOY_NETWORK_HOST_ID      = config.deploy.network.gl0_node.id
 */
import * as path from 'node:path';
import { Command, Flags } from '@oclif/core';
import { loadConfig, findConfigFile } from '../../config/loader.js';
import { requireDependencies, REMOTE_DEPS } from '../../utils/dependencies.js';
import { header, info, success } from '../../utils/logger.js';
import {
  runPlaybook,
  checkNodesHostFile,
  getSecondSignerInfo,
} from '../../utils/ansible.js';
import { confirmDestructive } from '../../utils/prompt.js';

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

    header('REMOTE START');

    // Load config and derive paths
    const configPath = findConfigFile(process.cwd());
    if (!configPath) {
      this.error(
        'Could not find euclid.json. Run this command from inside an Euclid project directory.'
      );
    }
    const rootPath = path.dirname(configPath);
    const config = loadConfig(configPath);

    // Check required tools
    requireDependencies(REMOTE_DEPS);

    // Validate owner ≠ staking
    const ownerFile = config.snapshot_fees.owner.key_file.name;
    const stakingFile = config.snapshot_fees.staking.key_file.name;
    if (ownerFile === stakingFile) {
      this.error(
        'Owner and staking p12 files must be different. ' +
          `Both are currently set to "${ownerFile}". ` +
          'Update snapshot_fees in euclid.json.'
      );
    }

    // Confirm force-genesis
    if (flags['force-genesis']) {
      const confirmed = await confirmDestructive(
        'WARNING: --force-genesis will wipe all remote node state and data. ' +
          'All existing snapshots will be lost. Are you sure you want to proceed?'
      );
      if (!confirmed) {
        this.log('Aborted.');
        return;
      }
    }

    // Validate owner params when force_owner_message set (matches bash check)
    const ownerAlias = config.snapshot_fees.owner.key_file.alias;
    const ownerPassword = config.snapshot_fees.owner.key_file.password;
    if (flags['force-owner-message']) {
      if (!ownerFile || !ownerAlias || !ownerPassword) {
        this.error(
          'When --force-owner-message is set, snapshot_fees.owner must have ' +
            'key_file.name, key_file.alias, and key_file.password set in euclid.json.'
        );
      }
    }

    // Validate staking params when force_staking_message set (matches bash check)
    const stakingAlias = config.snapshot_fees.staking.key_file.alias;
    const stakingPassword = config.snapshot_fees.staking.key_file.password;
    if (flags['force-staking-message']) {
      if (!stakingFile || !stakingAlias || !stakingPassword) {
        this.error(
          'When --force-staking-message is set, snapshot_fees.staking must have ' +
            'key_file.name, key_file.alias, and key_file.password set in euclid.json.'
        );
      }
    }

    // Resolve paths
    const hostsFile = path.resolve(rootPath, config.deploy.ansible.hosts);
    const startPlaybook = path.resolve(rootPath, config.deploy.ansible.nodes.playbooks.start);

    // Validate remote hosts
    await checkNodesHostFile(hostsFile);

    info('Starting on remote hosts');
    this.log('');

    // Compute second signer info (matches get_additonal_file_info_to_sign_message())
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
    // The start playbook uses these to connect to the GL0 network peer
    const ansibleEnv: NodeJS.ProcessEnv = {
      NODES: JSON.stringify(config.nodes),
      DEPLOY_NETWORK_NAME: config.deploy.network.name,
      DEPLOY_NETWORK_HOST_IP: String(config.deploy.network.gl0_node.ip),
      DEPLOY_NETWORK_HOST_PUBLIC_PORT: String(config.deploy.network.gl0_node.public_port),
      DEPLOY_NETWORK_HOST_ID: String(config.deploy.network.gl0_node.id),
    };

    await runPlaybook(startPlaybook, extraVars, hostsFile, ansibleEnv);

    success('Remote start completed successfully.');
  }
}
