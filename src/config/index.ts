/**
 * Configuration barrel re-export.
 *
 * Consumers should import from this file rather than directly from
 * schema.ts or loader.ts, to ensure a stable public API.
 *
 * Example:
 *   import { EuclidConfig, loadConfig, findConfigFile } from '../../config/index.js'
 */

// Schema types and validation helpers
export type {
  EuclidConfig,
  Framework,
  Node,
  DockerConfig,
  SnapshotFees,
  GL0Node,
  Network,
  JvmConfig,
  AnsibleConfig,
  AnsiblePlaybooks,
  DeployConfig,
  KeyFile,
  P12File,
  Layer,
} from './schema.js'

export {
  EuclidConfigSchema,
  KeyFileSchema,
  P12FileSchema,
  NodeSchema,
  LayerEnum,
  FrameworkSchema,
  DockerSchema,
  SnapshotFeesSchema,
  GL0NodeSchema,
  NetworkSchema,
  DeployNetworkName,
  JvmSchema,
  AnsibleSchema,
  DeploySchema,
  coercePublicPort,
  validateOwnerStakingDiff,
  validateNetworkName,
  findPlaceholders,
} from './schema.js'

// Config loading
export { loadConfig, loadConfigAsync, findConfigFile, ConfigValidationError } from './loader.js'
