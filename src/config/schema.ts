/**
 * Zod schemas for euclid.json configuration.
 *
 * All field names are derived directly from the actual euclid.json in the repo.
 * Backward compatibility: all fields present in euclid.json v0.19.0 are handled.
 *
 * Note on placeholder values:
 * - deploy.network.name uses "integrationnet|mainnet" as a template placeholder.
 *   The schema accepts any string but provides a branded helper for validation at runtime.
 * - deploy.network.gl0_node.public_port uses ":gl0_node_public_port" as a placeholder.
 *   The schema accepts string | number to pass template validation; callers should
 *   coerce to number before use.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

/**
 * P12 key file reference used throughout the config.
 * Fields: name (filename), alias (key alias), password.
 *
 * Note: The task spec named these file_name/key_alias but the actual euclid.json
 * uses "name" and "alias" — we follow the actual file.
 */
export const KeyFileSchema = z.object({
  name: z.string().min(1, 'Key file name must not be empty'),
  alias: z.string().min(1, 'Key alias must not be empty'),
  password: z.string(),
});

/** Alias matching the task spec name (P12FileSchema) */
export const P12FileSchema = KeyFileSchema;

export type KeyFile = z.infer<typeof KeyFileSchema>;
export type P12File = KeyFile;

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
  name: z.string().min(1), // e.g. "currency"
  modules: z.array(z.string()), // e.g. ["data"]
  version: z.string().min(1), // e.g. "v3.6.0"
  ref_type: z.enum(['tag', 'branch']),
});

export type Framework = z.infer<typeof FrameworkSchema>;

// ---------------------------------------------------------------------------

/**
 * Single node definition.
 * Each node has a container name and a P12 key file used for identity.
 */
export const NodeSchema = z.object({
  name: z.string().min(1), // Docker container name, e.g. "metagraph-node-1"
  key_file: KeyFileSchema,
});

export type Node = z.infer<typeof NodeSchema>;

// ---------------------------------------------------------------------------

/**
 * Docker-related config.
 */
export const DockerSchema = z.object({
  start_grafana_container: z.boolean(),
});

export type DockerConfig = z.infer<typeof DockerSchema>;

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
 * public_port accepts string | number for backward compatibility with the
 * template value ":gl0_node_public_port". Use coercePublicPort() to get number.
 */
export const GL0NodeSchema = z.object({
  ip: z.string(), // e.g. "1.2.3.4" or ":gl0_node_ip" placeholder
  id: z.string(), // 128-char hex peer ID or ":gl0_node_id" placeholder
  public_port: z.union([z.number().int().positive(), z.string()]),
  // ^ accepts template placeholder strings; callers must cast for actual use
});

export type GL0Node = z.infer<typeof GL0NodeSchema>;

/** Coerce public_port to number — throws if not parseable */
export function coercePublicPort(port: number | string): number {
  if (typeof port === 'number') return port;
  const n = parseInt(port, 10);
  if (isNaN(n)) throw new Error(`Invalid public_port value: "${port}"`);
  return n;
}

// ---------------------------------------------------------------------------

/**
 * Network configuration within the deploy block.
 *
 * name accepts any string for template compatibility ("integrationnet|mainnet").
 * At runtime, validate that name is 'integrationnet' | 'mainnet' before deploying.
 */
export const NetworkSchema = z.object({
  name: z.string(), // actual values: 'integrationnet' | 'mainnet'
  gl0_node: GL0NodeSchema,
});

/** Narrowed union for actual deployment */
export const DeployNetworkName = z.enum(['integrationnet', 'mainnet', 'testnet']);
export type DeployNetworkName = z.infer<typeof DeployNetworkName>;

export type Network = z.infer<typeof NetworkSchema>;

// ---------------------------------------------------------------------------

/** JVM heap/metaspace configuration passed to Ansible playbooks */
export const JvmSchema = z.object({
  min_heap: z.string().default('1g'),
  max_heap: z.string().default('2g'),
  metaspace_size: z.string().default('256m'),
  max_metaspace_size: z.string().default('512m'),
  additional_opts: z.string().default(''),
});

export type JvmConfig = z.infer<typeof JvmSchema>;

// ---------------------------------------------------------------------------

/**
 * Ansible playbook paths for a specific component (nodes or monitoring).
 */
export const AnsiblePlaybooksSchema = z.object({
  deploy: z.string(),
  start: z.string(),
});

export type AnsiblePlaybooks = z.infer<typeof AnsiblePlaybooksSchema>;

export const AnsibleComponentSchema = z.object({
  playbooks: AnsiblePlaybooksSchema,
});

/**
 * Full Ansible configuration section.
 * hosts: path to the Ansible hosts inventory file.
 * nodes: playbook paths for metagraph node operations.
 * monitoring: playbook paths for monitoring service operations.
 */
export const AnsibleSchema = z.object({
  hosts: z.string(),
  nodes: AnsibleComponentSchema,
  monitoring: AnsibleComponentSchema,
});

export type AnsibleConfig = z.infer<typeof AnsibleSchema>;

// ---------------------------------------------------------------------------

/**
 * Full deploy block: network target, JVM settings, Ansible paths.
 */
export const DeploySchema = z.object({
  network: NetworkSchema,
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
 * All fields present in euclid.json v0.19.0 are covered.
 * metagraph_id is optional (filled in after genesis run).
 */
export const EuclidConfigSchema = z.object({
  /** Euclid version string managed by the migration system (e.g. "0.19.0") */
  version: z.string().min(1),

  /** Tessellation release version — semver tag (e.g. "4.0.0-rc.0") or branch name */
  tessellation_version: z.string().min(1),

  /** Whether tessellation_version refers to a git tag or branch */
  ref_type: z.enum(['tag', 'branch']),

  /** Scala project directory name under source/project/ */
  project_name: z.string().min(1),

  /** Metagraph identifier — filled by `get_metagraph_id_from_metagraph_l0_genesis()` after genesis */
  metagraph_id: z.string().optional(),

  /** Framework template configuration */
  framework: FrameworkSchema,

  /** Which layers to start (order matters for dependency resolution) */
  layers: z.array(LayerEnum).min(1, 'At least one layer must be specified'),

  /** Exactly 3 nodes required by the Ansible playbooks */
  nodes: z.array(NodeSchema).min(3, 'At least 3 nodes are required'),

  /** Docker-related settings */
  docker: DockerSchema,

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
 * Validate that deploy.network.name is a known network.
 * Returns an error message or null.
 */
export function validateNetworkName(config: EuclidConfig): string | null {
  const result = DeployNetworkName.safeParse(config.deploy.network.name);
  if (!result.success) {
    return (
      `deploy.network.name "${config.deploy.network.name}" is not a valid network. ` +
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
  const gl0 = config.deploy.network.gl0_node;
  if (typeof gl0.ip === 'string' && gl0.ip.startsWith(':')) {
    placeholders.push('deploy.network.gl0_node.ip');
  }
  if (typeof gl0.id === 'string' && gl0.id.startsWith(':')) {
    placeholders.push('deploy.network.gl0_node.id');
  }
  if (typeof gl0.public_port === 'string' && String(gl0.public_port).startsWith(':')) {
    placeholders.push('deploy.network.gl0_node.public_port');
  }
  if (config.deploy.network.name.includes('|')) {
    placeholders.push('deploy.network.name');
  }
  return placeholders;
}
