/**
 * hydra remote snapshot-fee-config — Retrieve the current snapshot fee configuration.
 *
 * Bash equivalent: remote-snapshot-fee-config() in scripts/hydra
 *                  → remote_snapshot_fee_config() in scripts/hydra-operations/remote-snapshot-fee-config.sh
 *
 * Operation:
 *   1. SSH to node-1 → read metagraph_id from code/metagraph-l0/genesis.address
 *   2. HTTP GET http://{gl0_node_ip}:{gl0_node_port}/global-snapshots/latest/combined
 *   3. Extract .[1].lastCurrencySnapshots."<metagraphId>".Right[1].lastMessages
 *   4. Display Owner and Staking addresses + parent ordinals
 */
import * as path from 'node:path';
import { Command } from '@oclif/core';
import { execa } from 'execa';
import { loadConfig, findConfigFile } from '../../config/loader.js';
import { header, success, info, detail, urlLine } from '../../utils/logger.js';
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
    header('REMOTE SNAPSHOT FEE CONFIG');
    this.log('');

    const configPath = findConfigFile(process.cwd());
    if (!configPath) {
      this.error(
        'Could not find euclid.json. Run this command from inside an Euclid project directory.'
      );
    }
    const rootPath = path.dirname(configPath);
    const config = loadConfig(configPath);

    const hostsFile = path.resolve(rootPath, config.deploy.ansible.hosts);
    await checkNodesHostFile(hostsFile);

    const hosts = await parseHosts(hostsFile);
    const node1 = hosts.nodes.hosts['node-1'];
    if (!node1) {
      this.error('No node-1 found in Ansible hosts file.');
    }

    const host = String(node1.ansible_host);
    const user = String(node1.ansible_user);
    const privateKey = String(node1.ansible_ssh_private_key_file);

    // SSH to node-1 to read genesis.address (metagraph_id)
    // Matches: ssh -i "$private_key" $user@$host "cd code/metagraph-l0; cat genesis.address"
    header(`Fetching the metagraph-id in node ${host}`);
    info('SSH to the node...');

    let metagraphId: string;
    try {
      const sshResult = await execa(
        'ssh',
        ['-i', privateKey, `${user}@${host}`, 'cd code/metagraph-l0; cat genesis.address'],
        { reject: true }
      );
      metagraphId = sshResult.stdout.trim();
    } catch (err) {
      this.error(
        `SSH command failed. Please check the connection and try again.\n${(err as Error).message}`
      );
    }

    if (!metagraphId) {
      this.error('Metagraph ID is empty. Has genesis been run on the remote nodes?');
    }

    success(`Metagraph ID: ${metagraphId}`);
    this.log('');

    // Fetch latest global snapshot
    const gl0Ip = String(config.deploy.network.gl0_node.ip);
    const gl0Port = String(config.deploy.network.gl0_node.public_port);
    const url = `http://${gl0Ip}:${gl0Port}/global-snapshots/latest/combined`;

    header(`Fetching latest global snapshot from ${url}`);

    let responseData: GlobalSnapshotResponse;
    let httpStatus: number;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' },
      });
      httpStatus = response.status;
      if (!response.ok) {
        this.error(`Failed to fetch data. HTTP Status Code: ${httpStatus}`);
      }
      responseData = (await response.json()) as GlobalSnapshotResponse;
    } catch (err) {
      this.error(`Failed to fetch global snapshot: ${(err as Error).message}`);
    }

    // Extract lastMessages for the metagraph
    // Matches: .[1].lastCurrencySnapshots."<metagraphId>".Right[1].lastMessages
    const snapshotEntry = responseData[1]?.lastCurrencySnapshots?.[metagraphId];
    const lastMessages = snapshotEntry?.Right?.[1]?.lastMessages;

    if (!lastMessages) {
      this.error(
        'Failed when extracting the fee configuration from global snapshot. ' +
          'Be sure your metagraph has the fees messages configured.'
      );
    }

    success('Last messages extracted successfully:');

    // Extract and display Owner info
    const ownerAddress = lastMessages.Owner?.value?.address ?? 'N/A';
    const ownerParentOrdinal = lastMessages.Owner?.value?.parentOrdinal ?? 'N/A';
    const stakingAddress = lastMessages.Staking?.value?.address ?? 'N/A';
    const stakingParentOrdinal = lastMessages.Staking?.value?.parentOrdinal ?? 'N/A';

    detail('OWNER');
    urlLine('Owner Address', ownerAddress);
    urlLine('Owner Parent Ordinal', ownerParentOrdinal);
    this.log('');
    detail('STAKING');
    urlLine('Staking Address', stakingAddress);
    urlLine('Staking Parent Ordinal', stakingParentOrdinal);
  }
}
