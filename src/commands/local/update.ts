/**
 * hydra local update — Pull the latest Euclid CLI source and show release notes.
 *
 * Steps:
 *   1. Detect the CLI root directory (the euclid-development-environment git repo)
 *   2. Read current version from package.json
 *   3. Run `git pull` to update the CLI source
 *   4. Read new version from package.json
 *   5. Query GitHub releases API for the latest release notes
 *   6. Print version change and up to 5 bullet points from changelog
 *
 * API failures (network unavailable, rate limit) are handled gracefully —
 * the version line is still printed, changelog is skipped.
 *
 * External dependencies: git
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Command } from '@oclif/core';
import { execa } from 'execa';

import { logger } from '../../utils/logger.js';

const _require = createRequire(import.meta.url);

/** GitHub releases API response shape (minimal) */
interface GitHubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
}

/**
 * Resolve the CLI root directory from the compiled/source file path.
 * Works for both `dist/commands/local/update.js` and `src/commands/local/update.ts`.
 */
function getCliRoot(): string {
  const __dir = path.dirname(fileURLToPath(import.meta.url));
  // src/commands/local  →  ../../..  →  project root
  // dist/commands/local →  ../../..  →  project root
  return path.resolve(__dir, '..', '..', '..');
}

/** Read the `version` field from a package.json file */
function readVersion(pkgPath: string): string {
  try {
    const pkg = _require(pkgPath) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Extract up to maxBullets bullet-point lines from a markdown release body.
 * Looks for lines starting with `- `, `* `, or `• `.
 */
function extractBullets(body: string, maxBullets = 5): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') || l.startsWith('* ') || l.startsWith('• '))
    .slice(0, maxBullets);
}

/**
 * Fetch the latest GitHub release from the Constellation Labs euclid repo.
 * Returns null on any error (network, rate limit, etc.).
 */
async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  try {
    const response = await fetch(
      'https://api.github.com/repos/Constellation-Labs/euclid-development-environment/releases/latest',
      {
        headers: { 'User-Agent': 'hydra-cli' },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!response.ok) return null;
    return (await response.json()) as GitHubRelease;
  } catch {
    return null;
  }
}

export default class Update extends Command {
  static override id = 'local:update'

  static override description =
    'Update the Euclid CLI to the latest version and show release notes'

  static override examples = [
    '<%= config.bin %> local update',
    '<%= config.bin %> update',
  ]

  static override aliases = ['update']

  async run(): Promise<void> {
    logger.section('UPDATE');

    const cliRoot = getCliRoot();
    const pkgPath = path.join(cliRoot, 'package.json');

    // ----------------------------------------------------------------
    // 1. Read current version before pulling
    // ----------------------------------------------------------------
    const oldVersion = readVersion(pkgPath);

    // ----------------------------------------------------------------
    // 2. Check this is a git repo
    // ----------------------------------------------------------------
    const gitDir = path.join(cliRoot, '.git');
    if (!fs.existsSync(gitDir)) {
      logger.error(
        'Cannot update: CLI directory is not a git repository.\n' +
          `   CLI root: ${cliRoot}\n` +
          `   Install from: https://github.com/Constellation-Labs/euclid-development-environment`
      );
    }

    // ----------------------------------------------------------------
    // 3. git pull
    // ----------------------------------------------------------------
    const spinner = logger.spin('Pulling latest CLI changes from git...');
    try {
      await execa('git', ['pull'], { cwd: cliRoot, reject: true, env: process.env });
      spinner.succeed('Git pull completed');
    } catch (err) {
      spinner.fail('git pull failed');
      logger.error(
        `Update failed: git pull error\n   ${(err as Error).message}`
      );
    }

    // ----------------------------------------------------------------
    // 4. Read new version after pulling
    // ----------------------------------------------------------------
    // Invalidate require cache so we re-read the (possibly updated) package.json
    delete (_require as NodeJS.Require & { cache: Record<string, unknown> }).cache[pkgPath];
    const newVersion = readVersion(pkgPath);

    // ----------------------------------------------------------------
    // 5. Print version change
    // ----------------------------------------------------------------
    if (oldVersion !== newVersion) {
      logger.success(`Hydra updated  v${oldVersion} → v${newVersion}`);
    } else {
      logger.success(`Hydra is up to date  v${newVersion}`);
    }
    logger.info("Run 'hydra build' to rebuild containers with the new version");

    // ----------------------------------------------------------------
    // 6. Fetch and display GitHub release notes (best-effort)
    // ----------------------------------------------------------------
    const releaseSpinner = logger.spin('Fetching release notes...');
    const release = await fetchLatestRelease();
    releaseSpinner.stop();

    if (release) {
      const tag = release.tag_name ?? release.name ?? `v${newVersion}`;
      logger.info(`Release: ${tag}`);

      if (release.body) {
        const bullets = extractBullets(release.body);
        if (bullets.length > 0) {
          logger.section('Changelog highlights');
          for (const bullet of bullets) {
            logger.info(bullet);
          }
        }
      }
    }
    // If release is null (network error, rate limit), silently skip — already printed version line
  }
}
