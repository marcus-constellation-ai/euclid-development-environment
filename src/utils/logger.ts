/**
 * Centralized logger for the hydra CLI.
 *
 * Primary API: the `logger` object (info, success, warn, error, step, debug, spin, panel, section, table).
 * Backward-compat named exports kept for existing command code.
 */
/* eslint-disable no-console */

import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import boxen from 'boxen';
import Table from 'cli-table3';
import type { EuclidConfig } from '../config/schema.js';
import { elapsedSinceStart } from './time.js';

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
// Primary logger object
// ---------------------------------------------------------------------------

export const logger = {
  /** ℹ  dim cyan — general information */
  info(msg: string): void {
    console.log(`${chalk.dim(chalk.cyan('ℹ'))}  ${msg}`);
  },

  /** ✔  green — operation completed */
  success(msg: string): void {
    console.log(`${chalk.green('✔')}  ${msg}`);
  },

  /** ⚠  yellow — non-fatal warning */
  warn(msg: string): void {
    console.warn(`${chalk.yellow('⚠')}  ${msg}`);
  },

  /** ✖  red — fatal error; always calls process.exit(1) */
  error(msg: string): never {
    const elapsed = elapsedSinceStart();
    const suffix = elapsed ? `  ${chalk.dim(elapsed)}` : '';
    console.error(`${chalk.red('✖')}  ${msg}${suffix}`);
    process.exit(1);
  },

  /** →  blue bold — step in a multi-step process */
  step(msg: string): void {
    console.log(`${chalk.bold.blue('→')}  ${msg}`);
  },

  /** ·  gray — only shown when DEBUG=true */
  debug(msg: string): void {
    if (process.env['DEBUG'] === 'true') {
      console.log(`${chalk.gray('·')}  ${msg}`);
    }
  },

  /** Start an ora spinner and return the instance so caller can .succeed()/.fail() */
  spin(msg: string): Ora {
    return ora(msg).start();
  },

  /** Boxen info panel */
  panel(title: string, lines: string[]): void {
    const body = [chalk.bold(title), '', ...lines].join('\n');
    console.log(
      boxen(body, {
        borderStyle: 'round',
        padding: 1,
        borderColor: 'cyan',
      })
    );
  },

  /** Prints ─── TITLE ─────────────────────── */
  section(title: string): void {
    const pad = '─'.repeat(Math.max(0, 40 - title.length));
    console.log(chalk.dim(`─── ${title} ${pad}`));
  },

  /** cli-table3 table with cyan.bold headers */
  table(headers: string[], rows: string[][]): void {
    const t = new Table({
      head: headers.map((h) => chalk.cyan.bold(h)),
    });
    for (const row of rows) {
      t.push(row);
    }
    console.log(t.toString());
  },
};

// ---------------------------------------------------------------------------
// Node URL helper
// ---------------------------------------------------------------------------

/**
 * Compute the public port for a given layer and node index.
 * Formula: base_port + (node_index * PORT_OFFSET)
 */
export function nodePort(layer: keyof typeof BASE_PORTS, nodeIndex: number): number {
  return BASE_PORTS[layer] + nodeIndex * PORT_OFFSET;
}

// ---------------------------------------------------------------------------
// MetagraphInfo panel (section 2.4)
// ---------------------------------------------------------------------------

export interface MetagraphUrls {
  metagraphId: string;
  grafanaUrl?: string;
}

/**
 * Print the metagraph info boxen panel after start-genesis / start-rollback.
 *
 * Replaces the old #### block with a styled boxen panel.
 */
export function printMetagraphInfo(config: EuclidConfig, urls: MetagraphUrls): void {
  const layers = config.layers;
  const idShort =
    urls.metagraphId.length > 30
      ? `${urls.metagraphId.slice(0, 30)}...`
      : urls.metagraphId;

  const lines: string[] = [];
  lines.push(`  ${chalk.dim('ID')}  ${chalk.white(idShort)}`);

  config.nodes.forEach((_, index) => {
    lines.push('');
    lines.push(`  ${chalk.bold(`NODE ${index + 1}`)}`);

    if (index === 0 && layers.includes('global-l0')) {
      lines.push(
        `  ${chalk.dim('Global L0')}    → ${chalk.cyan(`http://localhost:${nodePort('global-l0', 0)}`)}`
      );
    }

    if (layers.includes('metagraph-l0')) {
      lines.push(
        `  ${chalk.dim('Metagraph L0')} → ${chalk.cyan(`http://localhost:${nodePort('metagraph-l0', index)}`)}`
      );
    }

    if (layers.includes('currency-l1') || layers.includes('metagraph-l1-currency')) {
      lines.push(
        `  ${chalk.dim('Currency L1')}  → ${chalk.cyan(`http://localhost:${nodePort('currency-l1', index)}`)}`
      );
    }

    if (layers.includes('data-l1') || layers.includes('metagraph-l1-data')) {
      lines.push(
        `  ${chalk.dim('Data L1')}      → ${chalk.cyan(`http://localhost:${nodePort('data-l1', index)}`)}`
      );
    }
  });

  if (config.monitoring?.grafana?.enabled || urls.grafanaUrl) {
    lines.push('');
    lines.push(
      `  ${chalk.dim('Grafana')}      → ${chalk.cyan(urls.grafanaUrl ?? 'http://localhost:3000')}`
    );
  }

  const title = chalk.bold.cyan('✦  METAGRAPH RUNNING  ✦');

  console.log(
    boxen([title, ...lines].join('\n'), {
      borderStyle: 'round',
      padding: 1,
      borderColor: 'cyan',
    })
  );
}

// ---------------------------------------------------------------------------
// Backward-compat named exports (used by remote commands + status command)
// ---------------------------------------------------------------------------

const SEPARATOR = '################################################################';

/** Cyan separator / header line (backward compat) */
export function header(msg: string = SEPARATOR): void {
  console.log(chalk.cyan(msg));
}

/** Green success line (backward compat) */
export function success(msg: string): void {
  console.log(`${chalk.green('✔')}  ${msg}`);
}

/** Cyan/yellow info line (backward compat) */
export function info(msg: string): void {
  console.log(`${chalk.dim(chalk.cyan('ℹ'))}  ${msg}`);
}

/** White detail / blank line (backward compat) */
export function detail(msg = ''): void {
  console.log(chalk.white(msg));
}

/** Red error line (backward compat — does NOT exit by default) */
export function error(msg: string): void {
  console.error(`${chalk.red('✖')}  ${msg}`);
}

/** Yellow+white url pair (backward compat) */
export function urlLine(label: string, url: string): void {
  console.log(`${chalk.yellow(label)} ${chalk.white(url)}`);
}

/** Bold yellow warning (backward compat) */
export function warn(msg: string): void {
  console.warn(`${chalk.yellow('⚠')}  ${msg}`);
}

// ---------------------------------------------------------------------------
// Banner helpers
// ---------------------------------------------------------------------------

export function startBanner(mode: 'genesis' | 'rollback' = 'genesis'): void {
  logger.section(`START (${mode.toUpperCase()})`);
}

export function stopBanner(): void {
  logger.section('STOP');
}

export function buildBanner(): void {
  logger.section('BUILD');
}
