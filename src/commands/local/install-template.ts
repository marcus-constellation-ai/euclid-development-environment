/**
 * hydra local install-template — Clone and install a metagraph project template.
 *
 * Bash equivalent: install-template() in scripts/hydra
 *                  → install_template() in scripts/hydra-operations/install-template.sh
 *
 * Clones a template from the metagraph-examples repository (or a custom repo)
 * and copies it into source/project/{PROJECT_NAME}.
 *
 * Supports listing available templates via --list flag.
 *
 * External dependencies: git
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command, Flags } from '@oclif/core';
import { execa } from 'execa';

import { findConfigFile } from '../../config/loader.js';
import { loadAndValidateConfig } from '../../config/schema.js';
import { requireDependencies, INSTALL_DEPS } from '../../utils/dependencies.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_REPO = 'https://github.com/Constellation-Labs/metagraph-examples.git';
const DEFAULT_TEMPLATE_PATH = 'examples';

/** The .gitignore written after install-template — matches install-template.sh heredoc exactly. */
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

export default class InstallTemplate extends Command {
  static override id = 'local:install-template'

  static override description =
    'Install a project template from the metagraph-examples repository (or a custom repo)'

  static override examples = [
    '<%= config.bin %> local install-template --name my-project',
    '<%= config.bin %> local install-template --list',
    '<%= config.bin %> local install-template --name my-project --repo https://github.com/Constellation-Labs/metagraph-examples.git --branch main --path examples',
    '<%= config.bin %> install-template --name my-project',
  ]

  static override aliases = ['install-template']

  static override flags = {
    name: Flags.string({
      description: 'Template/project name to install (directory name under source/project/)',
      required: false,
    }),
    repo: Flags.string({
      description: 'Git repository URL for the templates',
      default: DEFAULT_REPO,
    }),
    branch: Flags.string({
      description: 'Repository branch to use (defaults to the default branch)',
    }),
    path: Flags.string({
      description: 'Path within the repository where templates are located',
      default: DEFAULT_TEMPLATE_PATH,
    }),
    list: Flags.boolean({
      description: 'List available templates instead of installing',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(InstallTemplate);

    // ----------------------------------------------------------------
    // 1. Load config and resolve paths
    // ----------------------------------------------------------------
    const configFilePath = findConfigFile();
    if (!configFilePath) {
      logger.error('Could not find euclid.json. Run from inside an Euclid project directory.');
    }
    loadAndValidateConfig(configFilePath!);
    const rootPath = path.dirname(configFilePath!);
    const infraPath = path.join(rootPath, 'infra');
    const sourcePath = path.join(rootPath, 'source');

    // ----------------------------------------------------------------
    // 2. Check dependencies
    // ----------------------------------------------------------------
    requireDependencies(INSTALL_DEPS);

    // ----------------------------------------------------------------
    // 3. Compute repo name from URL (strip .git suffix)
    // ----------------------------------------------------------------
    logger.section('INSTALL TEMPLATE');

    const repoBasename = path.basename(flags.repo);
    const repoName = repoBasename.endsWith('.git')
      ? repoBasename.slice(0, -4)
      : repoBasename;

    // Temp clone directory inside infra/
    const cloneDir = path.join(infraPath, repoName);

    // ----------------------------------------------------------------
    // 4. --list mode: clone repo, list templates, print and exit
    // ----------------------------------------------------------------
    if (flags.list) {
      const cloneSpinner = logger.spin('Fetching available templates...');

      // Clean up any previous clone
      if (fs.existsSync(cloneDir)) {
        fs.rmSync(cloneDir, { recursive: true, force: true });
      }

      try {
        await execa('git', ['clone', '--quiet', flags.repo], {
          stdio: 'inherit',
          cwd: infraPath,
          env: process.env,
        });
        cloneSpinner.succeed('Repository cloned');
      } catch (err) {
        cloneSpinner.fail('Failed to clone repository');
        logger.error(
          `✖  Command failed: local install-template --list\n   Reason: git clone failed — ${(err as Error).message}\n   Fix:    Check network connectivity and the repository URL`
        );
      }

      if (flags.branch) {
        logger.info(`Using branch ${flags.branch}`);
        await execa('git', ['checkout', '--quiet', flags.branch], {
          stdio: 'inherit',
          cwd: cloneDir,
          env: process.env,
        });
      }

      logger.success('Available Templates:');

      const templatesDir = path.join(cloneDir, flags.path);
      if (fs.existsSync(templatesDir)) {
        const templates = fs.readdirSync(templatesDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
        for (const t of templates) {
          process.stdout.write(t + '\n');
        }
      } else {
        logger.warn(`Templates path "${flags.path}" not found in the repository.`);
      }

      // Cleanup clone
      fs.rmSync(cloneDir, { recursive: true, force: true });
      return;
    }

    // ----------------------------------------------------------------
    // 5. Install mode: require --name
    // ----------------------------------------------------------------
    if (!flags.name) {
      logger.error(
        '✖  Command failed: local install-template\n   Reason: No template name provided\n   Fix:    Pass --name <template-name> or use --list to see available templates'
      );
    }
    const templateName = flags.name!;

    logger.panel('Template Details', [
      `Project name:    ${templateName}`,
      `Repository URL:  ${flags.repo}`,
      `Repository Name: ${repoName}`,
      `Path:            ${flags.path}`,
    ]);

    // ----------------------------------------------------------------
    // 6. Clone the repo
    // ----------------------------------------------------------------
    const cloneSpinner = logger.spin('Cloning template repository...');

    if (fs.existsSync(cloneDir)) {
      fs.rmSync(cloneDir, { recursive: true, force: true });
    }

    try {
      await execa('git', ['clone', '--quiet', flags.repo], {
        stdio: 'inherit',
        cwd: infraPath,
        env: process.env,
      });
      cloneSpinner.succeed('Repository cloned');
    } catch (err) {
      cloneSpinner.fail('Failed to clone repository');
      logger.error(
        `✖  Command failed: local install-template\n   Reason: git clone failed — ${(err as Error).message}\n   Fix:    Check network connectivity and repository URL`
      );
    }

    if (flags.branch) {
      logger.info(`Using branch: ${flags.branch}`);
      await execa('git', ['checkout', '--quiet', flags.branch], {
        stdio: 'inherit',
        cwd: cloneDir,
        env: process.env,
      });
    }

    // ----------------------------------------------------------------
    // 7. Verify the template exists in the cloned repo
    // ----------------------------------------------------------------
    logger.step('Checking if the template exists on repository...');

    const projectInRepo = path.join(cloneDir, flags.path!, templateName);
    if (!fs.existsSync(projectInRepo)) {
      fs.rmSync(cloneDir, { recursive: true, force: true });
      logger.error(
        `✖  Command failed: local install-template\n   Reason: Template "${flags.path}/${templateName}" not found in repository\n   Fix:    Run with --list to see available templates`
      );
    }
    logger.success('Template found');

    // ----------------------------------------------------------------
    // 8. Move template to source/project/
    // ----------------------------------------------------------------
    const targetDir = path.join(sourcePath, 'project', templateName);

    logger.step(`Cleaning old directories: ${templateName} from projects`);
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }

    logger.step('Moving template to the projects directory');
    fs.renameSync(projectInRepo, targetDir);

    // ----------------------------------------------------------------
    // 9. Update euclid.json: projectName and tessellation_version
    // ----------------------------------------------------------------
    logger.step('Updating euclid.json projectName');
    const euclidJsonPath = path.join(rootPath, 'euclid.json');
    const euclidJson = JSON.parse(fs.readFileSync(euclidJsonPath, 'utf-8')) as Record<string, unknown>;
    euclidJson['projectName'] = templateName;

    // Extract tessellation version from Dependencies.scala
    const dependenciesScala = path.join(targetDir, 'project', 'Dependencies.scala');
    if (fs.existsSync(dependenciesScala)) {
      logger.step('Updating euclid.json tessellation_version');
      const dependenciesContent = fs.readFileSync(dependenciesScala, 'utf-8');
      const tessMatch = dependenciesContent.match(/val tessellation\s*=\s*"([^"]+)"/);
      if (tessMatch) {
        euclidJson['tessellation_version'] = tessMatch[1];
      }
    }

    fs.writeFileSync(euclidJsonPath, JSON.stringify(euclidJson, null, 2), 'utf-8');

    // ----------------------------------------------------------------
    // 10. Cleanup the clone
    // ----------------------------------------------------------------
    fs.rmSync(cloneDir, { recursive: true, force: true });

    // ----------------------------------------------------------------
    // 11. Remove old .git and reinitialize (matches bash behavior)
    // ----------------------------------------------------------------
    const gitDir = path.join(rootPath, '.git');
    if (fs.existsSync(gitDir)) {
      fs.chmodSync(gitDir, 0o755);
      fs.rmSync(gitDir, { recursive: true, force: true });
    }

    // Write .gitignore
    fs.writeFileSync(path.join(rootPath, '.gitignore'), GITIGNORE_CONTENT, 'utf-8');

    // Initialize new git repo and commit
    const gitSpinner = logger.spin('Initializing git repository...');
    try {
      await execa('git', ['init'], { stdio: 'inherit', cwd: rootPath, env: process.env });
      await execa('git', ['add', '-A'], { stdio: 'inherit', cwd: rootPath, env: process.env });
      await execa(
        'git',
        ['commit', '-m', `Initial commit after hydra install-template (${templateName})`],
        { stdio: 'inherit', cwd: rootPath, env: process.env }
      );
      gitSpinner.succeed('Git repository initialized');
    } catch (err) {
      gitSpinner.fail('Failed to initialize git repository');
      logger.error(
        `✖  Command failed: local install-template\n   Reason: git init/commit failed — ${(err as Error).message}\n   Fix:    Ensure git is installed and configured`
      );
    }

    logger.success(`Template installed: ${templateName}`);
  }
}
