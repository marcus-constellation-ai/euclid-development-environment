#!/usr/bin/env node
/**
 * Hydra CLI — binary entry point.
 *
 * This file compiles to dist/cli.js and is registered as the `hydra` bin
 * in package.json. It delegates immediately to dist/index.js which contains
 * the full oclif dispatch logic and startup banner.
 *
 * For development (no build required):
 *   npm run dev -- <command> [args]
 *
 * To build and link globally:
 *   npm run link
 */
import './index.js'
