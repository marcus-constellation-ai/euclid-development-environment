/**
 * Configuration loader for euclid.json.
 *
 * Provides:
 *  - findConfigFile()  — searches upward from cwd for euclid.json
 *  - loadConfig()      — reads, parses, and validates euclid.json with Zod
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ZodError } from 'zod';
import { EuclidConfigSchema, type EuclidConfig } from './schema.js';

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Searches upward from `startDir` for a file named `euclid.json`.
 *
 * Stops at the filesystem root. Returns the absolute path if found, or null.
 *
 * @example
 * const configPath = findConfigFile(process.cwd());
 * // -> '/home/user/my-project/euclid.json' or null
 */
export function findConfigFile(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(dir, 'euclid.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      // Reached filesystem root
      return null;
    }
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Loads and validates euclid.json.
 *
 * Resolution order for `configPath`:
 *  1. If `configPath` is provided and is a file path → read that file.
 *  2. If `configPath` is provided and is a directory → look for `euclid.json` inside it.
 *  3. Otherwise, call `findConfigFile(process.cwd())` to search upward.
 *
 * @param configPath - Optional path to `euclid.json` or its parent directory.
 * @returns Fully validated EuclidConfig.
 *
 * @throws Error if the file cannot be found or read.
 * @throws Error with descriptive Zod validation messages if the file is invalid.
 *
 * @example
 * const config = loadConfig();                         // searches from cwd
 * const config = loadConfig('/path/to/euclid.json');  // explicit path
 * const config = loadConfig('/path/to/project');      // directory
 */
export function loadConfig(configPath?: string): EuclidConfig {
  const resolvedPath = resolveConfigPath(configPath);

  // Read raw JSON
  let rawText: string;
  try {
    rawText = fs.readFileSync(resolvedPath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read config file at "${resolvedPath}": ${(err as Error).message}`);
  }

  // Parse JSON
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Invalid JSON in "${resolvedPath}": ${(err as Error).message}`
    );
  }

  // Validate with Zod
  const result = EuclidConfigSchema.safeParse(rawJson);
  if (!result.success) {
    throw new ConfigValidationError(resolvedPath, result.error);
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Async variant
// ---------------------------------------------------------------------------

/**
 * Async version of loadConfig().
 *
 * @param configPath - Optional path to `euclid.json` or its parent directory.
 * @returns Promise resolving to a fully validated EuclidConfig.
 */
export async function loadConfigAsync(configPath?: string): Promise<EuclidConfig> {
  const resolvedPath = resolveConfigPath(configPath);

  let rawText: string;
  try {
    const { readFile } = await import('node:fs/promises');
    rawText = await readFile(resolvedPath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read config file at "${resolvedPath}": ${(err as Error).message}`);
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Invalid JSON in "${resolvedPath}": ${(err as Error).message}`);
  }

  const result = EuclidConfigSchema.safeParse(rawJson);
  if (!result.success) {
    throw new ConfigValidationError(resolvedPath, result.error);
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown when euclid.json fails Zod schema validation.
 * Provides human-readable field-level error messages.
 */
export class ConfigValidationError extends Error {
  public readonly filePath: string;
  public readonly zodError: ZodError;

  constructor(filePath: string, zodError: ZodError) {
    const issues = zodError.issues
      .map((issue) => {
        const fieldPath = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `  • ${fieldPath}: ${issue.message}`;
      })
      .join('\n');

    super(
      `euclid.json validation failed at "${filePath}":\n${issues}\n\n` +
        'Please check your euclid.json against the schema. ' +
        'Run `hydra update` if your config may be outdated.'
    );

    this.name = 'ConfigValidationError';
    this.filePath = filePath;
    this.zodError = zodError;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, ConfigValidationError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveConfigPath(configPath?: string): string {
  if (configPath) {
    const abs = path.resolve(configPath);

    // If it's a directory, look for euclid.json inside
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const candidate = path.join(abs, 'euclid.json');
      if (!fs.existsSync(candidate)) {
        throw new Error(`No euclid.json found in directory "${abs}"`);
      }
      return candidate;
    }

    // Otherwise treat as a file path (may not exist yet — let readFileSync give the error)
    return abs;
  }

  // Search upward from cwd
  const found = findConfigFile(process.cwd());
  if (!found) {
    throw new Error(
      'Could not find euclid.json. ' +
        'Run this command from inside an Euclid project directory, ' +
        'or pass the path explicitly.'
    );
  }
  return found;
}
