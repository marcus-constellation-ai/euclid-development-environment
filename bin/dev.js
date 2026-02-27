#!/usr/bin/env node
/**
 * Hydra CLI — development entry point (no compilation required).
 *
 * Uses tsx to run TypeScript source directly.
 * Run: ./bin/dev.js <command> [args]
 *   or: pnpm dev -- <command> [args]
 */

import { execute, flush, handle } from '@oclif/core'

await execute({ development: true, dir: import.meta.url })
  .then(flush)
  .catch(handle)
