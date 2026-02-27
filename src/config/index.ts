/**
 * Configuration barrel re-export.
 *
 * Consumers should import from this file rather than directly from
 * schema.ts or loader.ts, to ensure a stable public API.
 *
 * Example:
 *   import { EuclidConfig, loadAndValidateConfig, findConfigFile } from '../../config/index.js'
 */

// Schema types and validation helpers
export type {
  EuclidConfig,
  Framework,
  Node,
  P12FileEntry,
  MonitoringConfig,
  TessellationConfig,
  GL0NodeConfig,
  SnapshotFees,
  JvmConfig,
  AnsibleConfig,
  AnsiblePlaybooks,
  AnsibleTopPlaybooks,
  DeployConfig,
  KeyFile,
  P12File,
  Layer,
} from './schema.js'

export {
  EuclidConfigSchema,
  KeyFileSchema,
  P12FileSchema,
  P12FileEntrySchema,
  NodeSchema,
  LayerEnum,
  FrameworkSchema,
  TessellationSchema,
  MonitoringSchema,
  SnapshotFeesSchema,
  GL0NodeSchema,
  DeployNetworkName,
  JvmSchema,
  AnsibleSchema,
  DeploySchema,
  coercePublicPort,
  validateOwnerStakingDiff,
  validateNetworkName,
  findPlaceholders,
  loadAndValidateConfig,
} from './schema.js'

// Config loading
export { loadConfig, loadConfigAsync, findConfigFile, ConfigValidationError } from './loader.js'
