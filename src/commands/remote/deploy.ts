/**
 * hydra remote deploy — Deploy metagraph JARs, genesis, and p12 files to remote cloud nodes.
 *
 * Bash equivalent: remote-deploy() / remote_deploy() alias
 *                  → remote_deploy_metagraph() in scripts/hydra-operations/remote-deploy.sh
 *
 * Runs the Ansible deploy playbook at deploy.ansible.nodes.playbooks.deploy.
 * Remote hosts are defined in deploy.ansible.hosts (Ansible inventory YAML).
 *
 * Ansible variable injection (exact match of bash -e flags):
 *   -e force_genesis=true|false
 *   -e deploy_cl1=true|false         (currency-l1 or metagraph-l1-currency in layers)
 *   -e deploy_dl1=true|false         (data-l1 or metagraph-l1-data in layers)
 *   -e owner_p12_file_name=<name>    (snapshot_fees.owner.key_file.name)
 *   -e second_signer_p12_file_name_owner=<name>
 *   -e staking_p12_file_name=<name>  (snapshot_fees.staking.key_file.name)
 *   -e second_signer_p12_file_name_staking=<name>
 *
 * Environment variables passed to ansible (via lookup('env', ...)):
 *   NODES      = JSON.stringify(config.nodes)
 *   SOURCE_PATH = <rootPath>/source
 *   INFRA_PATH  = <rootPath>/infra
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

export default class Deploy extends Command {
  static override id = 'remote:deploy';

  static override description =
    'Deploy metagraph to remote cloud hosts via Ansible (copies JARs, genesis files, p12 keys)';

  static override examples = [
    '<%= config.bin %> remote deploy',
    '<%= config.bin %> remote deploy --force-genesis',
    '<%= config.bin %> remote-deploy',
    '<%= config.bin %> remote_deploy',
  ];

  static override aliases = [
    'remote-deploy',
    'remote_deploy',
    'remote:remote-deploy',
    'remote:remote_deploy',
  ];

  static override flags = {
    'force-genesis': Flags.boolean({
      description:
        'Force metagraph to deploy as genesis (wipes remote state — prompts for confirmation)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Deploy);

    logger.section('REMOTE DEPLOY');

    // Load config and derive paths
    const configPath = findConfigFile(process.cwd());
    if (!configPath) {
      logger.error(
        '✖  Command failed: remote deploy\n   Reason: euclid.json not found\n   Fix:    Run this command from inside an Euclid project directory'
      );
    }
    const rootPath = path.dirname(configPath!);
    const config = loadAndValidateConfig(configPath!);

    // Check required tools (ansible-playbook, ssh, scp, curl, jq, yq)
    requireDependencies(REMOTE_DEPS);

    // Validate owner ≠ staking (matches check_if_owner_and_staking_address_are_equal())
    const ownerFile = config.snapshot_fees.owner.key_file.name;
    const stakingFile = config.snapshot_fees.staking.key_file.name;
    if (ownerFile === stakingFile) {
      logger.error(
        `✖  Command failed: remote deploy\n   Reason: Owner and staking p12 files must be different. Both are currently "${ownerFile}"\n   Fix:    Update snapshot_fees in euclid.json`
      );
    }

    // Confirm force-genesis (matches confirm_force_genesis() in validations.sh)
    if (flags['force-genesis']) {
      if (!(await confirmForceGenesis())) return;
    }

    // Resolve paths
    const sourcePath = path.join(rootPath, 'source');
    const infraPath = path.join(rootPath, 'infra');
    const hostsFile = path.resolve(rootPath, config.deploy.ansible.hosts);
    const deployPlaybook = path.resolve(rootPath, config.deploy.ansible.nodes.playbooks.deploy);

    // Validate remote hosts (IPs, SSH keys in agent)
    await checkNodesHostFile(hostsFile);

    logger.step('Deploying on remote hosts...');

    // Determine layer deployment flags (matches remote-deploy.sh logic)
    const layers = config.layers;
    const deployCl1 = layers.includes('currency-l1') || layers.includes('metagraph-l1-currency');
    const deployDl1 = layers.includes('data-l1') || layers.includes('metagraph-l1-data');

    // Compute second signer info (matches get_additonal_file_info_to_sign_message())
    const ownerSecondSigner = getSecondSignerInfo(config.nodes, ownerFile);
    const stakingSecondSigner = getSecondSignerInfo(config.nodes, stakingFile);

    // Extra vars — exact match of bash -e flags in remote-deploy.sh
    const extraVars: Record<string, string> = {
      force_genesis: String(flags['force-genesis']),
      deploy_cl1: String(deployCl1),
      deploy_dl1: String(deployDl1),
      owner_p12_file_name: ownerFile,
      second_signer_p12_file_name_owner: ownerSecondSigner.name,
      staking_p12_file_name: stakingFile,
      second_signer_p12_file_name_staking: stakingSecondSigner.name,
    };

    // Env vars for ansible lookup('env', ...) in playbook
    const ansibleEnv: NodeJS.ProcessEnv = {
      NODES: JSON.stringify(config.nodes),
      SOURCE_PATH: sourcePath,
      INFRA_PATH: infraPath,
    };

    const spinner = logger.spin('Running Ansible deploy playbook...');
    try {
      await runPlaybook(deployPlaybook, extraVars, hostsFile, ansibleEnv);
      spinner.succeed('Remote deploy completed');
    } catch (err) {
      spinner.fail('Remote deploy failed');
      logger.error(
        `✖  Command failed: remote deploy\n   Reason: Ansible playbook failed — ${(err as Error).message}\n   Fix:    Check Ansible output above and verify SSH keys are loaded`
      );
    }

    logger.success('Remote deploy completed successfully.');
  }
}
