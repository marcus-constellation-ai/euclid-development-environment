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
import chalk from 'chalk';
import { findConfigFile } from '../../config/loader.js';
import { loadAndValidateConfig } from '../../config/schema.js';
import { logger } from '../../utils/logger.js';
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
    logger.section('REMOTE STATUS');

    const configPath = findConfigFile(process.cwd());
    if (!configPath) {
      logger.error(
        '✖  Command failed: remote status\n   Reason: euclid.json not found\n   Fix:    Run this command from inside an Euclid project directory'
      );
    }
    const rootPath = path.dirname(configPath!);
    const config = loadAndValidateConfig(configPath!);

    const hostsFile = path.resolve(rootPath, config.deploy.ansible.hosts);

    // Validate hosts file (IPs only — skip SSH agent check for status since it's read-only)
    await checkNodesHostFile(hostsFile);

    const hosts = await parseHosts(hostsFile);
    const nodeHosts = hosts.nodes.hosts;
    const nodeVars = hosts.nodes.vars;

    const metagraphL0Port = nodeVars.base_metagraph_l0_public_port;
    const currencyL1Port = nodeVars.base_currency_l1_public_port;
    const dataL1Port = nodeVars.base_data_l1_public_port;

    // Collect rows for the status table
    const tableRows: string[][] = [];

    let index = 1;
    for (const [nodeName, nodeInfo] of Object.entries(nodeHosts)) {
      const ip = String(nodeInfo.ansible_host);

      logger.section(`Node ${index} — ${ip}`);

      // Fetch all three layers in parallel
      const ml0Url = `http://${ip}:${metagraphL0Port}/node/info`;
      const cl1Url = `http://${ip}:${currencyL1Port}/node/info`;
      const dl1Url = `http://${ip}:${dataL1Port}/node/info`;

      const [ml0Info, cl1Info, dl1Info] = await Promise.all([
        fetchNodeInfo(ml0Url),
        fetchNodeInfo(cl1Url),
        fetchNodeInfo(dl1Url),
      ]);

      // Print individual layer info
      this.printLayerInfo('Metagraph L0', ml0Url, ml0Info);
      this.printLayerInfo('Currency L1', cl1Url, cl1Info);
      this.printLayerInfo('Data L1', dl1Url, dl1Info);

      // Add rows to table
      const layerStatus = (info: NodeInfo | null, layer: string, port: string | number): string[] => {
        const statusCell = info
          ? `${chalk.green('✔')} ${info.state}`
          : `${chalk.red('✖')} Down`;
        return [nodeName, statusCell, layer, String(port)];
      };

      tableRows.push(layerStatus(ml0Info, 'Metagraph L0', metagraphL0Port));
      tableRows.push(layerStatus(cl1Info, 'Currency L1', currencyL1Port));
      tableRows.push(layerStatus(dl1Info, 'Data L1', dataL1Port));

      index++;
    }

    // Print summary table (section 2.5)
    logger.section('Summary');
    logger.table(['Node', 'Status', 'Layer', 'Port'], tableRows);
  }

  private printLayerInfo(layerName: string, url: string, nodeInfo: NodeInfo | null): void {
    logger.info(layerName);
    logger.info(`URL: ${url}`);
    if (!nodeInfo) {
      logger.warn('Could not fetch node info');
    } else {
      logger.info(`State: ${nodeInfo.state}`);
      logger.info(`Host: ${nodeInfo.host}`);
      logger.info(`Public port: ${nodeInfo.publicPort}`);
      logger.info(`P2P port: ${nodeInfo.p2pPort}`);
      logger.info(`Peer ID: ${nodeInfo.id}`);
    }
  }
}
