# Integration Tests

Integration tests require a running Docker environment and test the CLI against real containers.

## Prerequisites

- Docker ≥ 26.0.0 running
- `docker compose` (v2) or `docker-compose` (v1)
- Ansible ≥ 2.16
- A valid `euclid.json` in the project root

## Running Integration Tests

Integration tests are **not** run by `pnpm test` (that runs only unit tests). They must be triggered manually:

```bash
# From the project root
pnpm build
./bin/hydra local build
./bin/hydra local start-genesis
./bin/hydra local status
./bin/hydra local stop
./bin/hydra local destroy
```

## What to Test

1. **Build lifecycle** — `build`, `start-genesis`, `status`, `stop`, `destroy`
2. **Genesis flow** — verify `source/metagraph-l0/genesis/genesis.address` is populated
3. **Rollback flow** — `start-rollback` re-uses existing genesis files
4. **Port availability** — curl each node info endpoint after start

## Scope

Integration tests cover the full stack including:
- Docker image build (metagraph-ubuntu + metagraph-base-image)
- Ansible playbook execution (local)
- Container start and layer joining sequence
- HTTP endpoint availability at expected ports

They are intentionally kept outside the automated test suite because:
- They take 10–30 minutes to run
- They require Docker ≥ 26 and Ansible ≥ 2.16
- They make real network calls during the build phase

## Future Work

- Add a GitHub Actions workflow using `act` for local integration test runs
- Add smoke tests that verify node info endpoints return `{ state: "Ready" }`
- Add rollback test that validates metagraph-id matches between genesis and rollback runs
