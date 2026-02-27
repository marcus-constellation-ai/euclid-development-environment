# Euclid Development Environment

A TypeScript CLI (`hydra`) for building, running, and deploying Constellation Network metagraph projects locally and to cloud infrastructure.

---

## Quick Start

```bash
git clone https://github.com/Constellation-Labs/euclid-development-environment
cd euclid-development-environment
npm install && npm run build
./bin/hydra --help
```

---

## Global Installation

Install `hydra` globally so it's available from any directory:

```bash
# Clone and install dependencies
git clone https://github.com/marcus-constellation-ai/euclid-development-environment
cd euclid-development-environment
npm install

# Build and link globally (one-time setup)
npm run link

# Now call hydra from anywhere
hydra build
hydra start-genesis
hydra status
```

To uninstall:
```bash
npm run unlink
```

---

## Prerequisites

| Dependency | Minimum Version | Required For |
|---|---|---|
| [Node.js](https://nodejs.org) | ≥ 20.0.0 | Running the CLI |
| [Docker](https://docs.docker.com/engine/install/) + Docker Compose | ≥ 26.0.0 | All local commands |
| [Ansible](https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html) | ≥ 2.16 | Remote commands |
| [jq](https://jqlang.github.io/jq/download/) | any | Some Ansible playbooks |

> Docker must have at least **8 GB RAM** allocated (Docker Desktop → Settings → Resources).

---

## Configuration

All CLI commands read `euclid.json` from the current directory (or the nearest parent directory). Create and edit this file to match your project before running any commands.

### Full `euclid.json` Reference

```jsonc
{
  // ── Versioning ────────────────────────────────────────────────────────────
  "version": "0.19.0",          // Euclid config schema version
  "tessellation_version": "4.0.0-rc.0", // Tessellation runtime to build against
  "ref_type": "tag",            // Git ref type for tessellation: "tag" | "branch"

  // ── Project ───────────────────────────────────────────────────────────────
  "projectName": "my-metagraph", // Project directory name; used by install / destroy / purge
  "githubToken": "",             // GitHub PAT for private template repos (leave empty for public)

  "tessellation": {
    "version": "latest"          // Override tessellation build version ("latest" uses tessellation_version)
  },

  // ── Scala Framework ───────────────────────────────────────────────────────
  "framework": {
    "name": "currency",          // Framework type: "currency"
    "modules": ["data"],         // Optional modules: "data"
    "version": "v3.6.0",         // Framework git tag or branch
    "ref_type": "tag"            // "tag" | "branch"
  },

  // ── Layers ────────────────────────────────────────────────────────────────
  "layers": [                    // Enabled network layers (determines what gets built/started/stopped)
    "global-l0",
    "metagraph-l0",
    "currency-l1",
    "data-l1"
  ],

  // ── Local Docker Nodes ────────────────────────────────────────────────────
  "nodes": [                     // One entry per local Docker container
    {
      "name": "metagraph-node-1",            // Docker container name
      "key_file": {
        "name": "token-key.p12",             // p12 filename in source/p12-files/
        "alias": "token-key",                // p12 key alias
        "password": "password"               // p12 key password
      }
    },
    {
      "name": "metagraph-node-2",
      "key_file": { "name": "token-key-1.p12", "alias": "token-key-1", "password": "password" }
    },
    {
      "name": "metagraph-node-3",
      "key_file": { "name": "token-key-2.p12", "alias": "token-key-2", "password": "password" }
    }
  ],

  // ── p12 Files (Remote Deploy) ─────────────────────────────────────────────
  "p12Files": [                  // Standalone p12 references used by remote deploy
    { "fileName": "token-key.p12",   "keyAlias": "token-key",   "password": "password" },
    { "fileName": "token-key-1.p12", "keyAlias": "token-key-1", "password": "password" },
    { "fileName": "token-key-2.p12", "keyAlias": "token-key-2", "password": "password" }
  ],

  // ── Snapshot Fees ─────────────────────────────────────────────────────────
  "snapshot_fees": {
    "owner": {                   // p12 credentials for the snapshot owner address
      "key_file": { "name": "token-key.p12", "alias": "token-key", "password": "password" }
    },
    "staking": {                 // p12 credentials for the staking address (must differ from owner)
      "key_file": { "name": "token-key-1.p12", "alias": "token-key-1", "password": "password" }
    }
  },

  // ── Monitoring ────────────────────────────────────────────────────────────
  "monitoring": {
    "grafana":    { "enabled": false }, // Start a Grafana container alongside nodes
    "prometheus": { "enabled": false }  // Start a Prometheus container
  },

  // ── Remote Deployment ─────────────────────────────────────────────────────
  "deploy": {
    "network": "integrationnet",  // Target network: "integrationnet" | "mainnet"

    "gl0Node": {                  // The Global L0 node your metagraph will connect to
      "ip": "1.2.3.4",            // GL0 host IP
      "id": "abc123...",          // GL0 peer ID
      "publicPort": 9000          // GL0 public HTTP port
    },

    "jvm": {                      // JVM memory settings for remote nodes (all optional — shown are defaults)
      "min_heap": "1g",
      "max_heap": "2g",
      "metaspace_size": "256m",
      "max_metaspace_size": "512m",
      "additional_opts": ""
    },

    "ansible": {
      "hosts": "infra/ansible/remote/hosts.ansible.yml", // Ansible inventory file

      "nodes": {                  // Playbooks for node deploy/start
        "playbooks": {
          "deploy": "infra/ansible/remote/nodes/playbooks/deploy/deploy.ansible.yml",
          "start":  "infra/ansible/remote/nodes/playbooks/start/start.ansible.yml"
        }
      },

      "monitoring": {             // Playbooks for monitoring service deploy/start
        "playbooks": {
          "deploy": "infra/ansible/remote/monitoring/playbooks/deploy/deploy.ansible.yml",
          "start":  "infra/ansible/remote/monitoring/playbooks/start/start.ansible.yml"
        }
      }
    }
  }
}
```

### p12 Key Files

Place `.p12` files in `source/p12-files/`. The default files (`token-key.p12`, `token-key-1.p12`, `token-key-2.p12`) are provided for local development only. **Replace them with your own before deploying to IntegrationNet or MainNet.**

---

## Commands Reference

All commands accept `-h` / `--help` for inline usage.

Top-level aliases are available for all commands (e.g., `hydra build` = `hydra local build`, `hydra remote-deploy` = `hydra remote deploy`).

### Local Commands

Manage the local Docker-based development environment.

| Command | Description | Notable Flags |
|---|---|---|
| `local build` | Build Docker images (metagraph-ubuntu + metagraph-base-image). Compiles Scala via sbt and copies JARs to `infra/shared/jars/`. | `--no_cache` — skip Docker layer cache<br>`--run` — start genesis automatically after build |
| `local start-genesis` | Start all configured layers from genesis (wipes previous state). Polls for metagraph ID and prints node URLs. | — |
| `local start-rollback` | Start all configured layers from the last snapshot (preserves history). | — |
| `local stop` | Stop all running layers and containers in the correct teardown order. | — |
| `local destroy` | Stop and remove all containers, Docker network, and genesis files. | `--delete_project` — also remove project source directory |
| `local purge` | All of `destroy`, plus removes all Docker images (`metagraph-base-image`, `metagraph-ubuntu-*`, Grafana, Prometheus) and prunes dangling images. | — |
| `local status` | Check Docker health, print metagraph ID, show per-container status with live health checks, print cluster URLs. | — |
| `local logs` | Stream logs from a running container layer with line-level colorization (ERROR/WARN/DEBUG). Press Ctrl+C to stop. | `<container>` — Docker container name<br>`<layer>` — layer name (e.g. metagraph-l0)<br>`-n` — number of tail lines |
| `local install` | Scaffold a new Scala metagraph project via g8 and initialize a git repo. | — |
| `local install-template` | Clone a template from metagraph-examples and copy it to `source/project/`. Updates `projectName` in `euclid.json`. | `--name` — template name<br>`--list` — list available templates |
| `local update` | Pull the latest CLI version via `git pull` and report what changed. | — |

### Remote Commands

Deploy and operate metagraph nodes on cloud infrastructure via Ansible and SSH.

| Command | Description | Notable Flags |
|---|---|---|
| `remote create-remote-genesis` | Run local Docker containers in genesis mode to generate `genesis.snapshot` and `genesis.address` in `infra/shared/genesis/`. Must be run before `remote deploy`. | — |
| `remote deploy` | Copy JARs, genesis files, and p12 keys to remote nodes via Ansible. | `--force-genesis` — wipe remote state (prompts for confirmation) |
| `remote start` | Start the metagraph on remote nodes. Handles genesis vs rollback mode. | `--force-genesis`<br>`--force-owner-message`<br>`--force-staking-message` |
| `remote status` | Fetch `/node/info` from each remote node and print a status table (state, host, ports, peer ID). | — |
| `remote logs` | SSH into a remote node or monitoring host and tail the application log. | — |
| `remote snapshot-fee-config` | Read the remote metagraph ID and fetch the latest global snapshot to show current Owner and Staking fee message configuration. | — |

### Monitoring Service Commands

| Command | Description |
|---|---|
| `remote install-monitoring-service` | Clone `metagraph-monitoring-service` into `source/` and populate `config/config.json` from `euclid.json`. |
| `remote deploy-monitoring-service` | Deploy the monitoring service to the remote monitoring host via Ansible. |
| `remote start-monitoring-service` | Start (or restart) the monitoring service on the remote host. Use `--force-restart` to force a full metagraph restart. |

---

## Terminal Output Examples

### HYDRA Banner

Displayed when `hydra` is invoked with no arguments or `--help`:

```
  _   _  _  _  ____   ____    _
 | | | || \/ ||  _ \ |  _ \  / \
 | |_| || || || | | || |_) |/ _ \
 |  _  || || || |_| ||  _ </ ___ \
 |_| |_||_||_||____/ |_| \_/_/   \_\

 Euclid Development Environment  v0.19.0
 Constellation Network metagraph tooling
```

### Metagraph Running Panel

Displayed after `hydra local start-genesis` completes:

```
╭──────────────────────────────────────────────────────────────────────╮
│                                                                      │
│  Metagraph Running                                                   │
│                                                                      │
│  Metagraph ID  DAG4o6vTFTuPJdRUBTBu1pFEqJbHnoZQBj6s                │
│                                                                      │
│  metagraph-node-1                                                    │
│    Global L0    http://localhost:9000/node/info                      │
│    Metagraph L0 http://localhost:9200/node/info                      │
│    Currency L1  http://localhost:9300/node/info                      │
│    Data L1      http://localhost:9400/node/info                      │
│                                                                      │
│  metagraph-node-2                                                    │
│    Metagraph L0 http://localhost:9210/node/info                      │
│    Currency L1  http://localhost:9310/node/info                      │
│    Data L1      http://localhost:9410/node/info                      │
│                                                                      │
│  metagraph-node-3                                                    │
│    Metagraph L0 http://localhost:9220/node/info                      │
│    Currency L1  http://localhost:9320/node/info                      │
│    Data L1      http://localhost:9420/node/info                      │
│                                                                      │
│  Clusters                                                            │
│    Global L0    http://localhost:9000/cluster/info                   │
│    Metagraph L0 http://localhost:9200/cluster/info                   │
│    Currency L1  http://localhost:9300/cluster/info                   │
│    Data L1      http://localhost:9400/cluster/info                   │
│                                                                      │
╰──────────────────────────────────────────────────────────────────────╯

✔  local start-genesis complete  (4m 12s)
```

### Status Table

Displayed by `hydra local status`:

```
ℹ  Metagraph ID: DAG4o6vTFTuPJdRUBTBu1pFEqJbHnoZQBj6s

─── Containers ─────────────────────────────────────────

┌───────────────────────┬───────────┬──────────────┬───────┬──────────────┐
│ Container             │ Status    │ Layer        │ Port  │ Health       │
├───────────────────────┼───────────┼──────────────┼───────┼──────────────┤
│ metagraph-node-1      │ ✔ Up      │ metagraph-l0 │ 9200  │ ✔ Healthy    │
│ metagraph-node-2      │ ✔ Up      │ metagraph-l0 │ 9210  │ ✔ Healthy    │
│ metagraph-node-3      │ ✔ Up      │ metagraph-l0 │ 9220  │ ✔ Healthy    │
│ grafana               │ ✔ Up      │ monitoring   │ 3000  │ N/A          │
└───────────────────────┴───────────┴──────────────┴───────┴──────────────┘

✔  local status complete  (8s)
```

### Build Progress

```
→ Step 1/3  Building metagraph-ubuntu base image...
✔ Step 1/3  metagraph-ubuntu ready   (52s)
→ Step 2/3  Building metagraph-base-image...
✔ Step 2/3  metagraph-base-image ready   (2m 38s)
→ Step 3/3  Copying JARs to infra/shared/jars...
✔ Step 3/3  JARs copied   (4s)

✔  local build complete  (3m 34s)
```

---

## Development

### Run from Source (No Build Required)

```bash
npm install
npm run dev -- --help
npm run dev -- local status
```

`npm run dev` uses [tsx](https://github.com/privatenumber/tsx) to execute TypeScript directly.

### Build

```bash
npm run build          # compile src/ → dist/
npm run build:watch    # watch mode
```

### Type-check Without Building

```bash
npm run typecheck
```

### Lint and Format

```bash
npm run lint           # ESLint
npm run lint:fix       # auto-fix
npm run format         # Prettier (write)
npm run format:check   # Prettier (check only)
```

### Tests

```bash
npm test               # run all tests once (vitest)
npm run test:watch     # watch mode
```

### Project Structure

```
euclid-development-environment/
├── bin/hydra              # Production CLI entry point
├── euclid.json            # Project configuration
├── src/
│   ├── index.ts           # oclif entry point + startup banner
│   ├── config/            # Zod schemas + config loader
│   ├── commands/
│   │   ├── local/         # Local Docker commands
│   │   └── remote/        # Remote Ansible commands
│   └── utils/
│       ├── logger.ts      # Spinners, boxen panels, tables, colors
│       ├── docker.ts      # Docker / Ansible helpers
│       ├── ansible.ts     # Ansible runner + SSH helpers
│       ├── dependencies.ts# Startup dependency checks
│       └── time.ts        # Elapsed-time helpers
├── tests/
│   ├── unit/              # Vitest unit tests
│   └── integration/
├── infra/
│   ├── ansible/           # Ansible playbooks (local + remote)
│   ├── grafana/           # Grafana + Prometheus docker-compose
│   ├── metagraph-base-image/  # Scala build Dockerfile
│   └── metagraph-ubuntu/  # Tessellation JARs Dockerfile
└── source/
    ├── global-l0/genesis/ # Optional custom genesis.csv for Global L0
    ├── metagraph-l0/genesis/ # Optional custom genesis.csv for Metagraph L0
    ├── p12-files/         # p12 key files
    └── project/           # Metagraph Scala source code
```

---

## Grafana Monitoring

Enable the Grafana dashboard by setting `monitoring.grafana.enabled` to `true` in `euclid.json`:

```json
"monitoring": {
  "grafana": { "enabled": true },
  "prometheus": { "enabled": true }
}
```

After `hydra local start-genesis`, Grafana is available at **http://localhost:3000** (default credentials: `admin` / `admin`). Two dashboards are pre-configured under the Dashboards section.

---

## Remote Deployment Workflow

### 1. Configure Hosts

Edit `infra/ansible/remote/hosts.ansible.yml` with your server details (IP, user, SSH key path). Minimum recommended specs per node: 16 GB RAM, 8 vCPU, 160 GB storage, Ubuntu 20.04 or 22.04.

### 2. Configure `euclid.json`

Set `deploy.network`, `deploy.gl0Node.ip/id/publicPort`, and your p12 credentials.

### 3. Genesis Deploy (First Time)

```bash
# Generate genesis files locally
./bin/hydra remote create-remote-genesis

# Copy everything to remote hosts (wipes existing state)
./bin/hydra remote deploy --force-genesis

# Start the metagraph from genesis
./bin/hydra remote start --force-genesis
```

### 4. Subsequent Starts (Rollback Mode)

```bash
./bin/hydra remote deploy
./bin/hydra remote start
```

### 5. Verify

After startup, check snapshot generation on the block explorer:

- IntegrationNet: `https://be-integrationnet.constellationnetwork.io/currency/<metagraph_id>/snapshots/latest`
- MainNet: `https://be-mainnet.constellationnetwork.io/currency/<metagraph_id>/snapshots/latest`

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot find module '../dist/index.js'` | Run `npm run build` first |
| `Could not find euclid.json` | Run `hydra` from the project root where `euclid.json` lives |
| `Docker version X.Y.Z detected. Minimum required: 26.0.0` | Upgrade Docker to ≥ 26.0.0 |
| `ansible-playbook: command not found` | Install Ansible: `pip install ansible` (≥ 2.16) |
| `docker: command not found` | Install Docker from [docs.docker.com/engine/install](https://docs.docker.com/engine/install/) |
| TypeScript build errors | Run `npm run typecheck` to see all type errors |
| ESLint errors | Run `npm run lint:fix` for auto-fixable issues |
| `git: command not found` | Install Git from [git-scm.com](https://git-scm.com) |
| SSH key not loaded for remote commands | Run `ssh-add ~/.ssh/your_key` before remote commands |
| Remote deploy fails — p12 placeholder | Replace `:gl0_node_ip`, `:gl0_node_id`, `:gl0_node_public_port` in `euclid.json` with real values |
| Metagraph rejects snapshots on MainNet | Ensure your peer IDs are on the metagraph seedlist |
| Build runs out of Docker memory | Increase Docker RAM allocation to ≥ 8 GB |
