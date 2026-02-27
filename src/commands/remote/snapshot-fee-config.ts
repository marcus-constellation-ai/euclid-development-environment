/**
 * hydra remote snapshot-fee-config — Retrieve the current snapshot fee configuration.
 *
 * Bash equivalent: remote-snapshot-fee-config() in scripts/hydra
 *                  → remote_snapshot_fee_config() in scripts/hydra-operations/remote-snapshot-fee-config.sh
 */
import * as path from 'node:path';
import { Command } from '@oclif/core';
import { execa } from 'execa';
import { findConfigFile } from '../../config/loader.js';
import { loadAndValidateConfig } from '../../config/schema.js';
import { logger, urlLine } from '../../utils/logger.js';
import { parseHosts, checkNodesHostFile } from '../../utils/ansible.js';

/** Shape of lastMessages in the global snapshot response */
interface FeeMessages {
  Owner?: {
    value?: {
      address?: string;
      parentOrdinal?: string;
    };
  };
  Staking?: {
    value?: {
      address?: string;
      parentOrdinal?: string;
    };
  };
}

/** Shape of the global snapshot combined response */
type GlobalSnapshotResponse = [unknown, {
  lastCurrencySnapshots?: Record<string, {
    Right?: [unknown, {
      lastMessages?: FeeMessages;
    }];
  }>;
}];

export default class SnapshotFeeConfig extends Command {
  static override id = 'remote:snapshot-fee-config';

  static override description =
    'Retrieve snapshot fee configuration from the remote metagraph cluster';

  static override examples = [
    '<%= config.bin %> remote snapshot-fee-config',
    '<%= config.bin %> remote-snapshot-fee-config',
  ];

  static override aliases = [
    'remote-snapshot-fee-config',
    'remote:remote-snapshot-fee-config',
  ];

  async run(): Promise<void> {
    logger.section('REMOTE SNAPSHOT FEE CONFIG');

    const configPath = findConfigFile(process.cwd());
    if (!configPath) {
      logger.error(
        '✖  Command failed: remote snapshot-fee-config\n   Reason: euclid.json not found\n   Fix:    Run this command from inside an Euclid project directory'
      );
    }
    const rootPath = path.dirname(configPath!);
    const config = loadAndValidateConfig(configPath!);

    const hostsFile = path.resolve(rootPath, config.deploy.ansible.hosts);
    await checkNodesHostFile(hostsFile);

    const hosts = await parseHosts(hostsFile);
    const node1 = hosts.nodes.hosts['node-1'];
    if (!node1) {
      logger.error(
        '✖  Command failed: remote snapshot-fee-config\n   Reason: No node-1 found in Ansible hosts file\n   Fix:    Check infra/ansible/remote/hosts.ansible.yml'
      );
    }

    const host = String(node1.ansible_host);
    const user = String(node1.ansible_user);
    const privateKey = String(node1.ansible_ssh_private_key_file);

    // SSH to node-1 to read genesis.address (metagraph_id)
    logger.section(`Fetching metagraph-id from node ${host}`);
    logger.step('SSH to the node...');

    let metagraphId: string;
    const sshSpinner = logger.spin('Fetching metagraph ID via SSH...');
    try {
      const sshResult = await execa(
        'ssh',
        ['-i', privateKey, `${user}@${host}`, 'cd code/metagraph-l0; cat genesis.address'],
        { reject: true }
      );
      metagraphId = sshResult.stdout.trim();
      sshSpinner.succeed(`Metagraph ID: ${metagraphId}`);
    } catch (err) {
      sshSpinner.fail('SSH command failed');
      logger.error(
        `✖  Command failed: remote snapshot-fee-config\n   Reason: SSH failed to ${host} — ${(err as Error).message}\n   Fix:    Check the connection and ensure the private key is loaded`
      );
    }

    if (!metagraphId!) {
      logger.error(
        '✖  Command failed: remote snapshot-fee-config\n   Reason: Metagraph ID is empty\n   Fix:    Ensure genesis has been run on the remote nodes'
      );
    }

    // Fetch latest global snapshot
    const gl0Ip = String(config.deploy.gl0Node.ip);
    const gl0Port = String(config.deploy.gl0Node.publicPort);
    const url = `http://${gl0Ip}:${gl0Port}/global-snapshots/latest/combined`;

    logger.section(`Fetching latest global snapshot from ${url}`);

    const fetchSpinner = logger.spin('Fetching global snapshot...');
    let responseData: GlobalSnapshotResponse;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        fetchSpinner.fail(`HTTP ${response.status}`);
        logger.error(
          `✖  Command failed: remote snapshot-fee-config\n   Reason: HTTP ${response.status} from ${url}\n   Fix:    Check the GL0 node is running and accessible`
        );
      }
      responseData = (await response.json()) as GlobalSnapshotResponse;
      fetchSpinner.succeed('Global snapshot fetched');
    } catch (err) {
      fetchSpinner.fail('Failed to fetch global snapshot');
      logger.error(
        `✖  Command failed: remote snapshot-fee-config\n   Reason: ${(err as Error).message}\n   Fix:    Check GL0 node IP and port in euclid.json`
      );
    }

    // Extract lastMessages for the metagraph
    const snapshotEntry = responseData![1]?.lastCurrencySnapshots?.[metagraphId!];
    const lastMessages = snapshotEntry?.Right?.[1]?.lastMessages;

    if (!lastMessages) {
      logger.error(
        '✖  Command failed: remote snapshot-fee-config\n   Reason: Could not extract fee configuration from global snapshot\n   Fix:    Ensure your metagraph has fee messages configured'
      );
    }

    logger.success('Last messages extracted successfully:');

    const ownerAddress = lastMessages!.Owner?.value?.address ?? 'N/A';
    const ownerParentOrdinal = lastMessages!.Owner?.value?.parentOrdinal ?? 'N/A';
    const stakingAddress = lastMessages!.Staking?.value?.address ?? 'N/A';
    const stakingParentOrdinal = lastMessages!.Staking?.value?.parentOrdinal ?? 'N/A';

    logger.info('OWNER');
    urlLine('Owner Address', ownerAddress);
    urlLine('Owner Parent Ordinal', ownerParentOrdinal);
    logger.info('STAKING');
    urlLine('Staking Address', stakingAddress);
    urlLine('Staking Parent Ordinal', stakingParentOrdinal);
  }
}
