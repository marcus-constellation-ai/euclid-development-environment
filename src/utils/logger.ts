/**
 * Styled output utilities for the hydra CLI.
 *
 * Replicates the color-coded output of the original bash scripts
 * (scripts/utils/echo-colors.sh and print_nodes_information in start.sh).
 *
 * Color mapping from bash original:
 *   echo_green  → chalk.green    (success messages)
 *   echo_yellow → chalk.yellow   (progress/info labels)
 *   echo_white  → chalk.white    (URLs, detail text)
 *   echo_red    → chalk.red      (errors)
 *   echo_title  → chalk.cyan     (section separators/headers)
 *   echo_url    → chalk.yellow(label) + chalk.white(url)
 */

import chalk from 'chalk';
import type { EuclidConfig } from '../config/schema.js';

// ---------------------------------------------------------------------------
// Port constants (from infra/ansible/local/playbooks/vars.ansible.yml)
// ---------------------------------------------------------------------------

export const BASE_PORTS = {
  'global-l0': 9000,
  'dag-l1': 9100,
  'metagraph-l0': 9200,
  'currency-l1': 9300,
  'metagraph-l1-currency': 9300,
  'data-l1': 9400,
  'metagraph-l1-data': 9400,
} as const;

export const PORT_OFFSET = 10; // per-node offset

// ---------------------------------------------------------------------------
// Separator line — matches the bash `################################################################`
// ---------------------------------------------------------------------------

const SEPARATOR = '################################################################';
const METAGRAPH_SEPARATOR = '######################### METAGRAPH INFO #########################';

// ---------------------------------------------------------------------------
// Core output functions
// ---------------------------------------------------------------------------

/** Cyan — section separators and headers (bash: echo_title) */
export function header(msg: string = SEPARATOR): void {
  console.log(chalk.cyan(msg));
}

/** Green — success messages (bash: echo_green) */
export function success(msg: string): void {
  console.log(chalk.green(msg));
}

/** Yellow — progress/status labels (bash: echo_yellow) */
export function info(msg: string): void {
  console.log(chalk.yellow(msg));
}

/** White — URLs and detail text (bash: echo_white) */
export function detail(msg: string = ''): void {
  console.log(chalk.white(msg));
}

/** Red — error messages (bash: echo_red) */
export function error(msg: string): void {
  console.error(chalk.red(msg));
}

/** Yellow + white label:url pair (bash: echo_url) */
export function urlLine(label: string, url: string): void {
  console.log(`${chalk.yellow(label)} ${chalk.white(url)}`);
}

/**
 * warn — orange/yellow warning (not in original bash but useful for TypeScript CLI).
 * Uses bold yellow to distinguish from info().
 */
export function warn(msg: string): void {
  console.warn(chalk.bold.yellow(`Warning: ${msg}`));
}

// ---------------------------------------------------------------------------
// Section boundary helpers
// ---------------------------------------------------------------------------

/** Print a cyan separator with optional label (matches the bash start.sh style) */
export function sectionStart(label?: string): void {
  header();
  if (label) {
    info(label);
    detail('');
  }
}

/** Print closing cyan separator */
export function sectionEnd(): void {
  header();
}

// ---------------------------------------------------------------------------
// Node URL block
// ---------------------------------------------------------------------------

/**
 * Compute the public port for a given layer and node index.
 *
 * Formula matches vars.ansible.yml: port = base_port + (node_index * offset)
 * Node indices are 0-based.
 *
 * @example
 * nodePort('global-l0', 0)  // 9000
 * nodePort('global-l0', 1)  // 9010
 * nodePort('dag-l1', 2)     // 9120
 */
export function nodePort(layer: keyof typeof BASE_PORTS, nodeIndex: number): number {
  return BASE_PORTS[layer] + nodeIndex * PORT_OFFSET;
}

// ---------------------------------------------------------------------------
// MetagraphInfo block
// ---------------------------------------------------------------------------

export interface MetagraphUrls {
  /** Metagraph ID from genesis.address file */
  metagraphId: string;
  /** Grafana URL if enabled */
  grafanaUrl?: string;
}

/**
 * Print the full metagraph info block shown after `hydra start-genesis` completes.
 *
 * Replicates print_nodes_information() from scripts/hydra-operations/start.sh:
 *
 * ```
 * ######################### METAGRAPH INFO #########################
 *
 * Metagraph ID: <id>
 *
 *
 * Container metagraph-node-1 URLs
 * Global L0:    http://localhost:9000/node/info
 * DAG L1:       http://localhost:9100/node/info
 * Metagraph L0: http://localhost:9200/node/info
 * Currency L1:  http://localhost:9300/node/info
 * Data L1:      http://localhost:9400/node/info
 *
 *
 * Container metagraph-node-2 URLs
 * ...
 *
 * Clusters URLs
 * Global L0:    http://localhost:9000/cluster/info
 * ...
 * ```
 *
 * @param config  - Loaded EuclidConfig (for node names and layers).
 * @param urls    - Dynamic values (metagraphId, optional grafanaUrl).
 */
export function printMetagraphInfo(config: EuclidConfig, urls: MetagraphUrls): void {
  const layers = config.layers;

  console.log(chalk.white(METAGRAPH_SEPARATOR));
  console.log();
  urlLine('Metagraph ID:', urls.metagraphId);
  console.log();
  console.log();

  // Per-node URL blocks
  config.nodes.forEach((node, index) => {
    success(`Container ${node.name} URLs`);

    // Global L0 only shows on node 0 (genesis/lead node)
    if (index === 0 && layers.includes('global-l0')) {
      urlLine('Global L0:', `http://localhost:${nodePort('global-l0', 0)}/node/info`);
    }

    if (layers.includes('dag-l1')) {
      urlLine('DAG L1:', `http://localhost:${nodePort('dag-l1', index)}/node/info`);
    }

    if (layers.includes('metagraph-l0')) {
      urlLine('Metagraph L0:', `http://localhost:${nodePort('metagraph-l0', index)}/node/info`);
    }

    if (layers.includes('currency-l1') || layers.includes('metagraph-l1-currency')) {
      urlLine('Currency L1:', `http://localhost:${nodePort('currency-l1', index)}/node/info`);
    }

    if (layers.includes('data-l1') || layers.includes('metagraph-l1-data')) {
      urlLine('Data L1:', `http://localhost:${nodePort('data-l1', index)}/node/info`);
    }

    console.log();
    console.log();
  });

  // Grafana block (if enabled)
  if (config.docker.start_grafana_container || urls.grafanaUrl) {
    success('Telemetry');
    urlLine('Grafana:', urls.grafanaUrl ?? 'http://localhost:3000');
    console.log();
  }

  // Cluster URL block
  success('Clusters URLs');

  if (layers.includes('global-l0')) {
    urlLine('Global L0:', `http://localhost:${BASE_PORTS['global-l0']}/cluster/info`);
  }

  if (layers.includes('dag-l1')) {
    urlLine('DAG L1:', `http://localhost:${BASE_PORTS['dag-l1']}/cluster/info`);
  }

  if (layers.includes('metagraph-l0')) {
    urlLine('Metagraph L0:', `http://localhost:${BASE_PORTS['metagraph-l0']}/cluster/info`);
  }

  if (layers.includes('currency-l1') || layers.includes('metagraph-l1-currency')) {
    urlLine('Currency L1:', `http://localhost:${BASE_PORTS['currency-l1']}/cluster/info`);
  }

  if (layers.includes('data-l1') || layers.includes('metagraph-l1-data')) {
    urlLine('Data L1:', `http://localhost:${BASE_PORTS['data-l1']}/cluster/info`);
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Convenience: start/stop/build styled banners
// ---------------------------------------------------------------------------

/** Banner for start-genesis / start-rollback commands */
export function startBanner(mode: 'genesis' | 'rollback' = 'genesis'): void {
  header(
    `################################## START (${mode.toUpperCase()}) ##################################`
  );
}

/** Banner for stop command */
export function stopBanner(): void {
  header('################################## STOP ##################################');
}

/** Banner for build command */
export function buildBanner(): void {
  header('################################## BUILD ##################################');
}
