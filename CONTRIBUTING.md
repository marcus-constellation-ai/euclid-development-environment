# Contributing to Euclid Development Environment

Thank you for contributing to the Euclid Development Environment. This guide covers the TypeScript CLI (`src/`) introduced to replace the legacy bash scripts.

---

## Project Structure

```
euclid-development-environment/
├── bin/
│   └── hydra              # Shebang wrapper — runs dist/index.js
├── src/
│   ├── index.ts           # oclif entry point
│   ├── commands/
│   │   ├── local/         # Local Docker commands (build, start-genesis, stop, …)
│   │   └── remote/        # Remote Ansible commands (deploy, start, status, …)
│   ├── config/
│   │   ├── schema.ts      # Zod schemas for euclid.json
│   │   └── loader.ts      # loadConfig(), findConfigFile(), ConfigValidationError
│   └── utils/
│       ├── dependencies.ts # Tool presence/version checks
│       ├── docker.ts       # Docker & Ansible helpers
│       └── logger.ts       # Styled terminal output
├── tests/
│   ├── unit/              # Unit tests (run with pnpm test)
│   │   ├── config/
│   │   ├── utils/
│   │   └── commands/
│   └── integration/
│       └── README.md      # How to run integration tests against real Docker
├── infra/                 # Ansible playbooks and Docker Compose files
├── scripts/
│   └── hydra              # Legacy bash CLI (deprecated — do not modify logic)
├── euclid.json            # Main configuration file
├── vitest.config.ts       # Test configuration
├── tsconfig.json          # TypeScript compiler options
├── .eslintrc.json         # ESLint rules
└── .prettierrc            # Prettier formatting options
```

---

## Setting Up a Development Environment

**Requirements:** Node.js ≥ 20, pnpm ≥ 9

```bash
# Clone the repository
git clone https://github.com/Constellation-Labs/euclid-development-environment
cd euclid-development-environment

# Install dependencies
pnpm install

# Compile TypeScript
pnpm build

# Run the compiled CLI
node dist/index.js --help
# Or via the wrapper:
./bin/hydra --help
```

For iterative development without recompiling:

```bash
pnpm dev -- local build --help
```

---

## How to Add a New Command

Commands live under `src/commands/local/` (Docker operations) or `src/commands/remote/` (Ansible operations).

### Step-by-step: adding `hydra local my-command`

1. **Create the command file** `src/commands/local/my-command.ts`:

```typescript
import { Command, Flags } from '@oclif/core';
import { loadConfig, findConfigFile } from '../../config/loader.js';
import { requireDependencies, LOCAL_DEPS } from '../../utils/dependencies.js';
import * as logger from '../../utils/logger.js';

export default class MyCommand extends Command {
  static override id = 'local:my-command';
  static override description = 'Short description of what this command does';
  static override aliases = ['my-command'];

  static override flags = {
    my_flag: Flags.boolean({
      description: 'What this flag does',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MyCommand);

    // 1. Verify required tools are installed
    requireDependencies(LOCAL_DEPS);

    // 2. Load and validate euclid.json
    const configPath = findConfigFile();
    if (!configPath) {
      this.error('Could not find euclid.json. Run from inside an Euclid project directory.');
    }
    const config = loadConfig(configPath);

    // 3. Implement your command logic here
    logger.header('MY COMMAND');
    logger.info(`Running with flag: ${flags.my_flag}`);
    logger.success('Done!');
  }
}
```

2. **Add a test file** `tests/unit/commands/local/my-command.test.ts`. See existing tests for patterns.

3. **Rebuild**: `pnpm build`

4. **Test manually**: `./bin/hydra local my-command --help`

### Adding a remote command

Same pattern but:
- Place it in `src/commands/remote/`
- Use `REMOTE_DEPS` instead of `LOCAL_DEPS`
- Use `runAnsible()` from `src/utils/docker.ts` to invoke Ansible playbooks
- Call `validateOwnerStakingDiff(config)` and `findPlaceholders(config)` before running Ansible

---

## Running Tests

```bash
# Run all unit tests once
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run a specific test file
pnpm test -- tests/unit/config/loader.test.ts

# Type-check without emitting
pnpm typecheck
```

Tests use [Vitest](https://vitest.dev/). Mock `execa` and external utilities using `vi.mock()` — see `tests/unit/commands/local/build.test.ts` for examples.

### Integration tests

Integration tests require a running Docker environment. See `tests/integration/README.md` for instructions.

---

## Code Style

The project uses ESLint and Prettier for consistent code style.

### Formatting

```bash
# Format all TypeScript source files
pnpm format

# Check formatting without modifying files
pnpm format:check
```

### Linting

```bash
# Run the linter
pnpm lint

# Auto-fix fixable issues
pnpm lint:fix
```

### Key style rules (see `.eslintrc.json` and `.prettierrc`)

| Rule | Setting |
|------|---------|
| Quotes | Single quotes |
| Semicolons | Required |
| Print width | 100 characters |
| Trailing commas | ES5 style |
| Explicit return types | Required on all functions |
| `no-explicit-any` | Error — use proper types |
| `eqeqeq` | Use `===` / `!==` |
| `no-console` | Warning — use `logger.*` instead |

### Import conventions

- Use `.js` extension in all imports (ESM NodeNext module resolution)
- Example: `import { loadConfig } from '../../config/loader.js'`
- Barrel exports via `index.ts` are available in `config/` and `utils/`

---

## Testing Against a Real Docker Environment

To test the CLI against a real Docker environment:

1. Ensure Docker ≥ 26.0.0 is running
2. Ensure Ansible ≥ 2.16 is installed
3. Build the TypeScript CLI: `pnpm build`
4. Run the build command: `./bin/hydra local build`
5. Start from genesis: `./bin/hydra local start-genesis`
6. Check status: `./bin/hydra local status`
7. Stop: `./bin/hydra local stop`
8. Destroy: `./bin/hydra local destroy`

Note that `pnpm test` runs only unit tests. Integration tests must be run manually.

---

## Pull Request Checklist

- [ ] `pnpm typecheck` passes with 0 errors
- [ ] `pnpm lint` passes (or all warnings are intentional)
- [ ] `pnpm test` passes
- [ ] New commands have at least 3 unit tests covering happy path, missing config, and dependency failure
- [ ] No new `any` types introduced
- [ ] All functions have explicit return types
- [ ] Imports use `.js` extension

---

## Release Process

Releases are managed via GitHub. The CI pipeline (`.github/workflows/ci.yml`) runs lint, typecheck, test, and build on every push and PR to `main`/`develop`.
