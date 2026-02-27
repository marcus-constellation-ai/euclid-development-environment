/**
 * hydra local install — Scaffold a new Euclid project and detach from the template git history.
 *
 * Bash equivalent: install() in scripts/hydra → install_project() in scripts/hydra-operations/install.sh
 *
 * Steps:
 *   1. Run g8 to scaffold the project template into source/project/
 *   2. Remove the existing .git directory (detach from Euclid template history)
 *   3. Write a fresh .gitignore
 *   4. Initialize a new git repository
 *   5. Create initial commit
 *
 * External dependencies: g8 (Giter8 Scala template tool), git
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from '@oclif/core';
import { execa } from 'execa';

import { loadConfig, findConfigFile } from '../../config/loader.js';
import { requireDependencies, INSTALL_DEPS } from '../../utils/dependencies.js';
import * as logger from '../../utils/logger.js';

/** The .gitignore written after install — matches install.sh heredoc exactly. */
const GITIGNORE_CONTENT = `# IDE and editor files
.idea/
.vscode/
*.swp
*.swo
*~

# OS files
.DS_Store

# Scala build artifacts
.metals/
.bloop/
.bsp/
.scala-build/
target/
metals.sbt
**/metals.sbt
project/metals.sbt
project/project/metals.sbt
.scalafmt-cache
.scalafix-cache

# Node
node_modules/

# Jars (downloaded during build)
infra/shared/jars/*.jar

# Genesis files (generated)
source/metagraph-l0/genesis/genesis.address
source/metagraph-l0/genesis/genesis.snapshot
infra/shared/genesis/*

# Grafana data
infra/grafana/grafana/config/
infra/grafana/prometheus/data/
infra/grafana/prometheus/monitoring/

# Monitoring service
source/*-monitoring-service/node_modules
source/*-monitoring-service/config/config.json
source/*-monitoring-service/config/id_monitoring

# Shared data (generated at runtime)
infra/shared/data/*
!infra/shared/data/.gitkeep

# Project config (contains p12 passwords)
euclid.json

# Private key files
source/p12-files/*
!source/p12-files/.gitkeep
`;

export default class Install extends Command {
  static override id = 'local:install'

  static override description =
    'Install a local metagraph framework and detach the project from the Euclid template'

  static override examples = [
    '<%= config.bin %> local install',
    '<%= config.bin %> install',
  ]

  static override aliases = ['install']

  async run(): Promise<void> {
    // ----------------------------------------------------------------
    // 1. Load config and resolve paths
    // ----------------------------------------------------------------
    const configFilePath = findConfigFile();
    if (!configFilePath) {
      this.error('Could not find euclid.json. Run from inside an Euclid project directory.');
    }
    const config = loadConfig(configFilePath);
    const rootPath = path.dirname(configFilePath);

    // ----------------------------------------------------------------
    // 2. Check dependencies (git, g8)
    // ----------------------------------------------------------------
    requireDependencies(INSTALL_DEPS);

    // ----------------------------------------------------------------
    // 3. Run g8 scaffold (matches create_template project in bash)
    // ----------------------------------------------------------------
    logger.header('################################## INSTALL ##################################');
    logger.detail('Installing hydra ...');
    logger.detail('Installing Framework...');

    // g8 creates the project template into the current directory.
    // The bash calls: g8 <framework-repo> --name=<project_name>
    // The actual g8 command reads from euclid.json config for the framework version.
    await execa(
      'g8',
      [
        `Constellation-Labs/${config.framework.name}.g8`,
        `--name=${config.project_name}`,
      ],
      {
        stdio: 'inherit',
        cwd: path.join(rootPath, 'source', 'project'),
        env: process.env,
      }
    );

    // ----------------------------------------------------------------
    // 4. Remove the existing .git directory (detach from Euclid history)
    // ----------------------------------------------------------------
    const gitDir = path.join(rootPath, '.git');
    if (fs.existsSync(gitDir)) {
      // Make writable before removing (matches: chmod -R +w .git && rm -r .git)
      fs.chmodSync(gitDir, 0o755);
      fs.rmSync(gitDir, { recursive: true, force: true });
    }

    // ----------------------------------------------------------------
    // 5. Write .gitignore
    // ----------------------------------------------------------------
    fs.writeFileSync(path.join(rootPath, '.gitignore'), GITIGNORE_CONTENT, 'utf-8');

    // ----------------------------------------------------------------
    // 6. Initialize new git repository and create initial commit
    // ----------------------------------------------------------------
    await execa('git', ['init'], { stdio: 'inherit', cwd: rootPath, env: process.env });
    await execa('git', ['add', '-A'], { stdio: 'inherit', cwd: rootPath, env: process.env });
    await execa(
      'git',
      ['commit', '-m', 'Initial commit after hydra install'],
      { stdio: 'inherit', cwd: rootPath, env: process.env }
    );

    logger.success('Installed');
  }
}
