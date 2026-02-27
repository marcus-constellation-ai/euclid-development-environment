/**
 * hydra remote status — Check the health status of remote cloud nodes.
 *
 * Bash equivalent: remote-status() in scripts/hydra
 *                  → remote_status() in scripts/hydra-operations/remote-status.sh
 *
 * For each remote node (from Ansible hosts file):
 *   - HTTP GET http://{nodeIp}:{metagraphL0Port}/node/info
 *   - HTTP GET http://{nodeIp}:{currencyL1Port}/node/info
 *   - HTTP GET http://{nodeIp}:{dataL1Port}/node/info
 *   - Prints state, host, publicPort, p2pPort, peerId per layer
 *
 * Port numbers are read from hosts.ansible.yml vars:
 *   base_metagraph_l0_public_port, base_currency_l1_public_port, base_data_l1_public_port
 */
import * as path from 'node:path';
import { Command } from '@oclif/core';
import { loadConfig, findConfigFile } from '../../config/loader.js';
import { header, success as logSuccess, info, detail, urlLine } from '../../utils/logger.js';
import { parseHosts, checkNodesHostFile } from '../../utils/ansible.js';

/** Node info response from /node/info endpoint */
interface NodeInfo {
  state: string;
  host: string;
  publicPort: number;
  p2pPort: number;
  id: string;
}

/**
 * Fetch /node/info from a remote node endpoint.
 * Matches fetch_node_info() in remote-status.sh.
 */
async function fetchNodeInfo(url: string): Promise<NodeInfo | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as NodeInfo;
  } catch {
    return null;
  }
}

/**
 * Print node info, matching fetch_node_info() output in remote-status.sh.
 * Uses echo_url style: label in yellow, value in white.
 */
function printNodeInfo(nodeInfo: NodeInfo | null): void {
  if (!nodeInfo) {
    process.stdout.write('\x1b[31mCould not fetch node info\x1b[0m\n');
    return;
  }
  urlLine('State:', nodeInfo.state);
  urlLine('Host:', nodeInfo.host);
  urlLine('Public port:', String(nodeInfo.publicPort));
  urlLine('P2P port:', String(nodeInfo.p2pPort));
  urlLine('Peer id:', nodeInfo.id);
}

export default class RemoteStatus extends Command {
  static override id = 'remote:status';

  static override description =
    'Check the health status and peer IDs of remote cloud nodes';

  static override examples = [
    '<%= config.bin %> remote status',
    '<%= config.bin %> remote-status',
  ];

  static override aliases = ['remote-status', 'remote:remote-status'];

  async run(): Promise<void> {
    header('REMOTE STATUS');

    const configPath = findConfigFile(process.cwd());
    if (!configPath) {
      this.error(
        'Could not find euclid.json. Run this command from inside an Euclid project directory.'
      );
    }
    const rootPath = path.dirname(configPath);
    const config = loadConfig(configPath);

    const hostsFile = path.resolve(rootPath, config.deploy.ansible.hosts);

    // Validate hosts file (IPs only — skip SSH agent check for status since it's read-only)
    await checkNodesHostFile(hostsFile);

    const hosts = await parseHosts(hostsFile);
    const nodeHosts = hosts.nodes.hosts;
    const nodeVars = hosts.nodes.vars;

    const metagraphL0Port = nodeVars.base_metagraph_l0_public_port;
    const currencyL1Port = nodeVars.base_currency_l1_public_port;
    const dataL1Port = nodeVars.base_data_l1_public_port;

    let index = 1;
    this.log('');

    for (const [, nodeInfo] of Object.entries(nodeHosts)) {
      const ip = String(nodeInfo.ansible_host);

      header(`Node ${index}`);

      // Metagraph L0
      process.stdout.write('\x1b[32mMetagraph L0\x1b[0m\n');
      const ml0Url = `http://${ip}:${metagraphL0Port}/node/info`;
      urlLine('URL:', ml0Url);
      const ml0Info = await fetchNodeInfo(ml0Url);
      printNodeInfo(ml0Info);
      this.log('');

      // Currency L1
      process.stdout.write('\x1b[32mCurrency L1\x1b[0m\n');
      const cl1Url = `http://${ip}:${currencyL1Port}/node/info`;
      urlLine('URL:', cl1Url);
      const cl1Info = await fetchNodeInfo(cl1Url);
      printNodeInfo(cl1Info);
      this.log('');

      // Data L1
      process.stdout.write('\x1b[32mData L1\x1b[0m\n');
      const dl1Url = `http://${ip}:${dataL1Port}/node/info`;
      urlLine('URL:', dl1Url);
      const dl1Info = await fetchNodeInfo(dl1Url);
      printNodeInfo(dl1Info);
      this.log('');

      index++;
      this.log('');
    }

    // Suppress unused import warnings
    void info;
    void detail;
    void logSuccess;
  }
}
