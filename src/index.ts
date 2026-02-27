/**
 * Hydra CLI — Euclid Development Environment
 *
 * TypeScript rewrite of the original bash-based hydra CLI.
 * Uses oclif for plugin-extensible command dispatch.
 *
 * Entry point: delegates to oclif's execute() which reads oclif config
 * from package.json and dispatches to the appropriate command class.
 */
import { execute, flush, handle } from '@oclif/core'

await execute({ development: false, dir: import.meta.url })
  .then(() => flush())
  .catch(handle)
