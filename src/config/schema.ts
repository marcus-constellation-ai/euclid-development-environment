/**
 * Zod schemas for euclid.json configuration.
 *
 * Key renames from v0.19.0 → current:
 *  - project_name              → projectName
 *  - docker.start_grafana_container → monitoring.grafana.enabled (new monitoring block)
 *  - deploy.network (object)   → deploy.network (string) + deploy.gl0Node (object)
 *  - deploy.network.gl0_node.public_port → deploy.gl0Node.publicPort
 *
 * New fields added:
 *  - githubToken, tessellation.version, p12Files[], monitoring.prometheus.enabled
 *  - deploy.ansible.playbooks (flat alternative to nested nodes/monitoring)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

/**
 * P12 key file reference used in the `nodes` array.
 * Fields: name (filename), alias (key alias), password.
 */
export const KeyFileSchema = z.object({
  name: z.string().min(1, 'Key file name must not be empty').describe('p12 filename'),
  alias: z.string().min(1, 'Key alias must not be empty').describe('key alias'),
  password: z.string().describe('key password'),
});

export type KeyFile = z.infer<typeof KeyFileSchema>;

/** Alias kept for backward compatibility */
export const P12FileSchema = KeyFileSchema;
export type P12File = KeyFile;

// ---------------------------------------------------------------------------

/**
 * Standalone p12Files entry (camelCase keys, separate from nodes[].key_file).
 * Added in euclid.json v0.20.0 under the top-level `p12Files` array.
 */
export const P12FileEntrySchema = z.object({
  fileName: z.string().min(1).describe('p12 filename'),
  keyAlias: z.string().min(1).describe('key alias'),
  password: z.string().describe('key password'),
});

export type P12FileEntry = z.infer<typeof P12FileEntrySchema>;

// ---------------------------------------------------------------------------

/** Valid layer identifiers */
export const LayerEnum = z.enum([
  'global-l0',
  'dag-l1',
  'metagraph-l0',
  'currency-l1',
  'data-l1',
  'metagraph-l1-currency',
  'metagraph-l1-data',
]);

export type Layer = z.infer<typeof LayerEnum>;

// ---------------------------------------------------------------------------

/** Framework module identifiers */
export const FrameworkModuleEnum = z.enum(['data', 'currency']);

/**
 * Framework section — describes the metagraph framework template being used.
 */
export const FrameworkSchema = z.object({
  name: z.string().min(1).describe('framework name, e.g. "currency"'),
  modules: z.array(z.string()).describe('enabled modules, e.g. ["data"]'),
  version: z.string().min(1).describe('framework version, e.g. "v3.6.0"'),
  ref_type: z.enum(['tag', 'branch']).describe('whether version is a git tag or branch'),
});

export type Framework = z.infer<typeof FrameworkSchema>;

// ---------------------------------------------------------------------------

/**
 * Single node definition.
 * Each node has a container name and a P12 key file used for identity.
 */
export const NodeSchema = z.object({
  name: z.string().min(1).describe('Docker container name, e.g. "metagraph-node-1"'),
  key_file: KeyFileSchema,
});

export type Node = z.infer<typeof NodeSchema>;

// ---------------------------------------------------------------------------

/**
 * Tessellation version configuration.
 * version: "latest" or a semver string like "4.0.0-rc.0".
 */
export const TessellationSchema = z.object({
  version: z.string().min(1).describe('tessellation version, e.g. "latest" or "4.0.0-rc.0"'),
});

export type TessellationConfig = z.infer<typeof TessellationSchema>;

// ---------------------------------------------------------------------------

/**
 * Monitoring configuration block.
 * Replaces the old `docker.start_grafana_container` boolean.
 */
export const MonitoringServiceSchema = z.object({
  enabled: z.boolean().describe('whether to start this monitoring service'),
});

export const MonitoringSchema = z.object({
  grafana: MonitoringServiceSchema.describe('Grafana dashboard settings'),
  prometheus: MonitoringServiceSchema.describe('Prometheus metrics settings'),
});

export type MonitoringConfig = z.infer<typeof MonitoringSchema>;

// ---------------------------------------------------------------------------

/**
 * Snapshot fees — owner and staking parties each supply a key file.
 * The bash validation enforces owner !== staking filenames.
 */
export const SnapshotFeePartySchema = z.object({
  key_file: KeyFileSchema,
});

export const SnapshotFeesSchema = z.object({
  owner: SnapshotFeePartySchema,
  staking: SnapshotFeePartySchema,
});

export type SnapshotFees = z.infer<typeof SnapshotFeesSchema>;

// ---------------------------------------------------------------------------

/**
 * Global L0 (GL0) peer node used during remote/deploy operations.
 *
 * publicPort accepts string | number for backward compatibility with the
 * template value ":gl0_node_public_port". Use coercePublicPort() to get number.
 */
export const GL0NodeSchema = z.object({
  ip: z.string().describe('GL0 node IP address, e.g. "1.2.3.4"'),
  id: z.string().describe('GL0 node 128-char hex peer ID'),
  publicPort: z
    .union([z.number().int().positive(), z.string()])
    .describe('GL0 node public port, e.g. 9000'),
  // ^ accepts template placeholder strings; callers must cast for actual use
});

export type GL0NodeConfig = z.infer<typeof GL0NodeSchema>;

/** Coerce publicPort to number — throws if not parseable */
export function coercePublicPort(port: number | string): number {
  if (typeof port === 'number') return port;
  const n = parseInt(port, 10);
  if (isNaN(n)) throw new Error(`Invalid publicPort value: "${port}"`);
  return n;
}

// ---------------------------------------------------------------------------

/** Narrowed union for actual deployment network names */
export const DeployNetworkName = z.enum(['integrationnet', 'mainnet', 'testnet']);
export type DeployNetworkName = z.infer<typeof DeployNetworkName>;

// ---------------------------------------------------------------------------

/** JVM heap/metaspace configuration passed to Ansible playbooks */
export const JvmSchema = z.object({
  min_heap: z.string().default('1g').describe('JVM minimum heap, e.g. "1g"'),
  max_heap: z.string().default('2g').describe('JVM maximum heap, e.g. "2g"'),
  metaspace_size: z.string().default('256m').describe('JVM metaspace size'),
  max_metaspace_size: z.string().default('512m').describe('JVM max metaspace size'),
  additional_opts: z.string().default('').describe('additional JVM options'),
});

export type JvmConfig = z.infer<typeof JvmSchema>;

// ---------------------------------------------------------------------------

/**
 * Ansible playbook paths for a specific component (nodes or monitoring).
 */
export const AnsiblePlaybooksSchema = z.object({
  deploy: z.string().describe('path to deploy playbook'),
  start: z.string().describe('path to start playbook'),
});

export type AnsiblePlaybooks = z.infer<typeof AnsiblePlaybooksSchema>;

export const AnsibleComponentSchema = z.object({
  playbooks: AnsiblePlaybooksSchema,
});

/**
 * Flat top-level playbooks added in the 3.2 merge — single-level alternative
 * to the nested nodes/monitoring structure.
 */
export const AnsibleTopPlaybooksSchema = z.object({
  deploy: z.string().describe('path to nodes deploy playbook'),
  start: z.string().describe('path to nodes start playbook'),
  monitoring: z.string().describe('path to monitoring playbook'),
});

export type AnsibleTopPlaybooks = z.infer<typeof AnsibleTopPlaybooksSchema>;

/**
 * Full Ansible configuration section.
 * hosts: path to the Ansible hosts inventory file.
 * nodes: playbook paths for metagraph node operations.
 * monitoring: playbook paths for monitoring service operations.
 * playbooks: (optional) flat alternative structure added in v0.20.0.
 */
export const AnsibleSchema = z.object({
  hosts: z.string().describe('path to Ansible hosts inventory YAML'),
  nodes: AnsibleComponentSchema.describe('node-specific playbook paths'),
  monitoring: AnsibleComponentSchema.describe('monitoring service playbook paths'),
  playbooks: AnsibleTopPlaybooksSchema.optional().describe(
    'simplified flat playbook paths (v0.20.0+)'
  ),
});

export type AnsibleConfig = z.infer<typeof AnsibleSchema>;

// ---------------------------------------------------------------------------

/**
 * Full deploy block: network target, GL0 node, JVM settings, Ansible paths.
 *
 * network: plain string (was deploy.network.name in v0.19.0)
 * gl0Node: GL0 peer node info (was deploy.network.gl0_node in v0.19.0)
 */
export const DeploySchema = z.object({
  network: z.string().describe('target network name, e.g. "integrationnet" or "mainnet"'),
  gl0Node: GL0NodeSchema.describe('Global L0 peer node for metagraph connection'),
  jvm: JvmSchema,
  ansible: AnsibleSchema,
});

export type DeployConfig = z.infer<typeof DeploySchema>;

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

/**
 * Complete euclid.json configuration schema.
 *
 * Changelog from v0.19.0:
 *  - project_name renamed to projectName
 *  - github_token renamed to githubToken (new field)
 *  - tessellation.version added (new nested field)
 *  - docker block removed; monitoring block added (grafana.enabled, prometheus.enabled)
 *  - p12Files[] added (camelCase standalone array)
 *  - deploy.network is now a string (was object with .name and .gl0_node)
 *  - deploy.gl0Node added (was deploy.network.gl0_node)
 *  - deploy.ansible.playbooks added (flat alternative to nodes/monitoring)
 */
export const EuclidConfigSchema = z.object({
  /** Euclid version string managed by the migration system (e.g. "0.19.0") */
  version: z.string().min(1).describe('euclid version string'),

  /** Tessellation release version — semver tag (e.g. "4.0.0-rc.0") or branch name */
  tessellation_version: z.string().min(1).describe('tessellation version tag or branch'),

  /** Whether tessellation_version refers to a git tag or branch */
  ref_type: z.enum(['tag', 'branch']).describe('git ref type for tessellation version'),

  /** Scala project directory name under source/project/ */
  projectName: z.string().min(1).describe('project directory name under source/project/'),

  /** GitHub personal access token for private repo access (may be empty string) */
  githubToken: z.string().describe('GitHub personal access token').optional().default(''),

  /** Tessellation version configuration */
  tessellation: TessellationSchema.optional(),

  /** Metagraph identifier — filled by genesis run */
  metagraph_id: z.string().optional(),

  /** Framework template configuration */
  framework: FrameworkSchema,

  /** Which layers to start (order matters for dependency resolution) */
  layers: z.array(LayerEnum).min(1, 'At least one layer must be specified'),

  /** Exactly 3 nodes required by the Ansible playbooks */
  nodes: z.array(NodeSchema).min(3, 'At least 3 nodes are required'),

  /** Standalone p12 file entries (camelCase, separate from nodes[].key_file) */
  p12Files: z
    .array(P12FileEntrySchema)
    .min(3, 'At least 3 p12Files entries are required')
    .optional(),

  /** Monitoring services configuration (replaces old docker.start_grafana_container) */
  monitoring: MonitoringSchema.optional(),

  /** Snapshot fee key files for owner and staking roles */
  snapshot_fees: SnapshotFeesSchema,

  /** Remote deployment configuration */
  deploy: DeploySchema,
});

export type EuclidConfig = z.infer<typeof EuclidConfigSchema>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate that owner and staking key files differ (matches bash check).
 * Returns an error message or null.
 */
export function validateOwnerStakingDiff(config: EuclidConfig): string | null {
  const ownerFile = config.snapshot_fees.owner.key_file.name;
  const stakingFile = config.snapshot_fees.staking.key_file.name;
  if (ownerFile === stakingFile) {
    return `Owner and staking key files must differ. Both are "${ownerFile}".`;
  }
  return null;
}

/**
 * Validate that deploy.network is a known network.
 * Returns an error message or null.
 */
export function validateNetworkName(config: EuclidConfig): string | null {
  const result = DeployNetworkName.safeParse(config.deploy.network);
  if (!result.success) {
    return (
      `deploy.network "${config.deploy.network}" is not a valid network. ` +
      `Expected one of: integrationnet, mainnet, testnet.`
    );
  }
  return null;
}

/**
 * Check whether the config contains unresolved template placeholder values.
 * Returns array of field paths that still hold placeholders.
 */
export function findPlaceholders(config: EuclidConfig): string[] {
  const placeholders: string[] = [];
  const gl0 = config.deploy.gl0Node;
  if (typeof gl0.ip === 'string' && gl0.ip.startsWith(':')) {
    placeholders.push('deploy.gl0Node.ip');
  }
  if (typeof gl0.id === 'string' && gl0.id.startsWith(':')) {
    placeholders.push('deploy.gl0Node.id');
  }
  if (typeof gl0.publicPort === 'string' && String(gl0.publicPort).startsWith(':')) {
    placeholders.push('deploy.gl0Node.publicPort');
  }
  if (config.deploy.network.includes('|')) {
    placeholders.push('deploy.network');
  }
  return placeholders;
}

// ---------------------------------------------------------------------------
// loadAndValidateConfig — reads, parses, validates, exits on failure
// ---------------------------------------------------------------------------

/**
 * Field-specific hints for config validation errors.
 * Maps dot-path to { problem, fix } strings shown to users.
 */
const FIELD_HINTS: Record<string, { problem: string; fix: string }> = {
  'deploy.gl0Node.ip': {
    problem: 'Required for remote commands — cannot be empty string',
    fix: 'Set your GL0 node IP address in euclid.json',
  },
  'deploy.gl0Node.id': {
    problem: 'Required for remote commands — cannot be empty string',
    fix: 'Set your GL0 node peer ID in euclid.json',
  },
  'deploy.gl0Node.publicPort': {
    problem: 'Required for remote commands — must be a valid port number',
    fix: 'Set your GL0 node public port (e.g. 9000) in euclid.json',
  },
  'deploy.network': {
    problem: 'Must be a valid network name (not a placeholder)',
    fix: 'Set deploy.network to "integrationnet", "mainnet", or "testnet" in euclid.json',
  },
  projectName: {
    problem: 'Project name is required and must not be empty',
    fix: 'Set projectName in euclid.json',
  },
  githubToken: {
    problem: 'GitHub token field is required (may be an empty string)',
    fix: 'Add githubToken to euclid.json (set to "" if not needed)',
  },
  tessellation_version: {
    problem: 'Tessellation version must not be empty',
    fix: 'Set tessellation_version in euclid.json (e.g. "4.0.0")',
  },
  nodes: {
    problem: 'At least 3 nodes are required',
    fix: 'Add at least 3 entries to the nodes array in euclid.json',
  },
  layers: {
    problem: 'At least one layer must be specified',
    fix: 'Add at least one layer to the layers array in euclid.json',
  },
};

function getFieldHint(fieldPath: string, zodMessage: string): { problem: string; fix: string } {
  const hint = FIELD_HINTS[fieldPath];
  if (hint) return hint;
  return {
    problem: zodMessage,
    fix: `Check the "${fieldPath}" field in euclid.json`,
  };
}

/**
 * Load and validate euclid.json from the given absolute path.
 *
 * On success: returns a fully typed EuclidConfig.
 * On failure: prints field-level error details to stderr and calls process.exit(1).
 *
 * Error format:
 * ```
 * ✖  Invalid configuration in euclid.json
 *    Field:   deploy.gl0Node.ip
 *    Problem: Required for remote commands — cannot be empty string
 *    Fix:     Set your GL0 node IP address in euclid.json
 * ```
 *
 * @param filePath - Absolute path to euclid.json
 */
export function loadAndValidateConfig(filePath: string): EuclidConfig {
  const fileName = path.basename(filePath);

  // Read file
  let rawText: string;
  try {
    rawText = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    process.stderr.write(
      `${chalk.red('✖')}  Cannot read config file at "${filePath}":\n` +
        `   ${(err as Error).message}\n`
    );
    process.exit(1);
  }

  // Parse JSON
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch (err) {
    process.stderr.write(
      `${chalk.red('✖')}  Invalid JSON in "${fileName}": ${(err as Error).message}\n`
    );
    process.exit(1);
  }

  // Validate with Zod
  const result = EuclidConfigSchema.safeParse(rawJson);
  if (!result.success) {
    process.stderr.write(`${chalk.red('✖')}  Invalid configuration in ${fileName}\n`);
    for (const issue of result.error.issues) {
      const fieldPath = issue.path.join('.');
      const { problem, fix } = getFieldHint(fieldPath, issue.message);
      process.stderr.write(`   ${chalk.dim('Field:')}   ${chalk.yellow(fieldPath || '(root)')}\n`);
      process.stderr.write(`   ${chalk.dim('Problem:')} ${problem}\n`);
      process.stderr.write(`   ${chalk.dim('Fix:')}     ${fix}\n`);
      process.stderr.write('\n');
    }
    process.exit(1);
  }

  return result.data;
}
