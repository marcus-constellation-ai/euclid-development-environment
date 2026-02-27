/**
 * Local Docker operations for the hydra CLI.
 *
 * Replaces infra/ansible/local/playbooks/ operations with direct Docker SDK calls.
 * All container interactions use `docker exec` / `docker cp` shell commands via execa.
 *
 * Port formula (matches vars.ansible.yml):
 *   host_port  = base_port + nodeIndex * PORT_OFFSET
 *   container_port = same as host_port (1:1 mapping)
 *   node_ip    = "172.50.0." + (nodeIndex + 1) * PORT_OFFSET
 *
 * Container names come from node.name (config.nodes[i].name).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';
import { dockerCompose } from './docker.js';

// ---------------------------------------------------------------------------
// Constants (from infra/ansible/local/playbooks/vars.ansible.yml)
// ---------------------------------------------------------------------------

const IP_PREFIX = '172.50.0.';
const IP_OFFSET = 10;
const DOCKER_NETWORK = 'custom-network';
const DOCKER_SUBNET = '172.50.0.0/24';

const LAYER_BASE_PORTS: Record<string, { public: number; p2p: number; cli: number }> = {
  'global-l0': { public: 9000, p2p: 9001, cli: 9002 },
  'dag-l1':    { public: 9100, p2p: 9101, cli: 9102 },
  'metagraph-l0': { public: 9200, p2p: 9201, cli: 9202 },
  'currency-l1':  { public: 9300, p2p: 9301, cli: 9302 },
  'data-l1':      { public: 9400, p2p: 9401, cli: 9402 },
};

// ---------------------------------------------------------------------------
// Node config type (matches EuclidConfig nodes array entries)
// ---------------------------------------------------------------------------

export interface LocalNode {
  name: string;
  key_file: { name: string; alias: string; password: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute container IP for node at given index (0-based). */
function containerIp(nodeIndex: number): string {
  return `${IP_PREFIX}${(nodeIndex + 1) * IP_OFFSET}`;
}

/** Compute per-node port (host and container port are identical). */
function nodePort(basePort: number, nodeIndex: number): number {
  return basePort + nodeIndex * IP_OFFSET;
}

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a command inside a Docker container (captured output).
 * Throws if exit code is non-zero.
 */
async function execCapture(
  container: string,
  cmd: string,
  envVars: Record<string, string> = {}
): Promise<string> {
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(envVars)) {
    envArgs.push('-e', `${k}=${v}`);
  }
  const result = await execa('docker', ['exec', ...envArgs, container, 'bash', '-c', cmd], {
    env: process.env,
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `docker exec in ${container} failed (exit ${result.exitCode}):\n` +
        `  Command: ${cmd}\n` +
        `  Stderr: ${result.stderr || '(empty)'}`
    );
  }
  return result.stdout.trim();
}

/**
 * Run a command inside a Docker container (inherits stdio — output shown to user).
 * Used for visible operations like jar startup.
 */
async function execVisible(
  container: string,
  cmd: string,
  envVars: Record<string, string> = {}
): Promise<void> {
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(envVars)) {
    envArgs.push('-e', `${k}=${v}`);
  }
  await execa('docker', ['exec', ...envArgs, container, 'bash', '-c', cmd], {
    stdio: 'inherit',
    env: process.env,
  });
}

/**
 * Copy a file from the host into a running container.
 * Matches: docker cp {src} {container}:code/{layer}/{file}
 */
async function copyToContainer(
  localFile: string,
  container: string,
  containerPath: string
): Promise<void> {
  await execa('docker', ['cp', localFile, `${container}:${containerPath}`], {
    env: process.env,
  });
}

/**
 * Poll a node's /node/info endpoint until it reports the expected state.
 * Polls inside the container via localhost:{cliPort}.
 *
 * @param container  - Container name
 * @param publicPort - Public HTTP port for node/info
 * @param expected   - State string to wait for ("Ready" or "ReadyToJoin")
 * @param maxRetries - Max poll attempts (each waits 1s)
 */
async function pollNodeState(
  container: string,
  publicPort: number,
  expected: 'Ready' | 'ReadyToJoin',
  maxRetries = 120
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await execCapture(
        container,
        `curl -sf http://localhost:${publicPort}/node/info`
      );
      if (response.includes(expected)) return;
    } catch {
      // not yet ready
    }
    await sleep(1000);
  }
  throw new Error(
    `Node in ${container} did not reach "${expected}" state within ${maxRetries}s on port ${publicPort}`
  );
}

/**
 * Get the node ID from a running container by calling cl-wallet.jar show-id.
 * Matches the get-lead-node-info.ansible.yml pattern.
 */
async function getLeadNodeId(
  container: string,
  p12Name: string,
  alias: string,
  password: string
): Promise<string> {
  return execCapture(
    container,
    `cd global-l0 && java -jar cl-wallet.jar show-id`,
    { CL_KEYSTORE: p12Name, CL_KEYALIAS: alias, CL_PASSWORD: password }
  );
}

/**
 * Kill a process listening on a port inside a container.
 * Matches stop/shared/kill.ansible.yml.
 */
async function killByPort(container: string, port: number): Promise<void> {
  try {
    const pid = await execCapture(container, `/bin/bash -c 'lsof -t -i:${port}'`);
    if (pid) {
      await execCapture(container, `/bin/bash -c 'kill -9 ${pid}'`);
    }
  } catch {
    // Process may not be running — ignore
  }
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

/**
 * Create the custom-network and start all node containers.
 * Matches infra/ansible/local/playbooks/start/containers/nodes.ansible.yml.
 *
 * @param nodes      - Node definitions from euclid.json (name + key_file)
 * @param infraPath  - Absolute path to the infra/ directory
 */
export async function startNodeContainers(
  nodes: LocalNode[],
  infraPath: string
): Promise<void> {
  // Create network (ignore error if already exists)
  await execa(
    'docker',
    ['network', 'create', DOCKER_NETWORK, '--subnet', DOCKER_SUBNET, '--driver', 'bridge'],
    { reject: false, env: process.env }
  );

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const ip = containerIp(i);

    const portArgs: string[] = [];
    for (const layer of Object.values(LAYER_BASE_PORTS)) {
      const pub = nodePort(layer.public, i);
      const p2p = nodePort(layer.p2p, i);
      const cli = nodePort(layer.cli, i);
      portArgs.push('-p', `${pub}:${pub}`, '-p', `${p2p}:${p2p}`, '-p', `${cli}:${cli}`);
    }

    const sharedGenesis = path.join(infraPath, 'shared', 'genesis');
    const sharedJars = path.join(infraPath, 'shared', 'jars');

    // Ensure shared directories exist
    fs.mkdirSync(sharedGenesis, { recursive: true });
    fs.mkdirSync(sharedJars, { recursive: true });

    await execa(
      'docker',
      [
        'run', '-d',
        '--name', node.name,
        '--network', DOCKER_NETWORK,
        `--ip=${ip}`,
        ...portArgs,
        '-v', `${sharedGenesis}:/code/shared_genesis`,
        '-v', `${sharedJars}:/code/shared_jars`,
        'metagraph-base-image:latest',
        'tail', '-f', '/dev/null',
      ],
      { stdio: 'inherit', env: process.env }
    );
  }
}

/**
 * Stop all node containers (and grafana/prometheus if running).
 * Matches infra/ansible/local/playbooks/stop/containers/nodes.ansible.yml.
 *
 * @param nodes - Node definitions from euclid.json
 */
export async function stopNodeContainers(nodes: LocalNode[]): Promise<void> {
  for (const node of nodes) {
    await execa('docker', ['stop', node.name], { reject: false, env: process.env });
  }
  // Stop monitoring containers (ignore if not running)
  await execa('docker', ['stop', 'grafana'], { reject: false, env: process.env });
  await execa('docker', ['stop', 'prometheus'], { reject: false, env: process.env });
}

/**
 * Destroy all containers, genesis files, and the custom-network.
 * Matches infra/ansible/local/playbooks/destroy/containers/nodes.ansible.yml.
 *
 * @param nodes     - Node definitions from euclid.json
 * @param infraPath - Absolute path to infra/ directory
 */
export async function destroyContainers(nodes: LocalNode[], infraPath: string): Promise<void> {
  for (const node of nodes) {
    await execa('docker', ['rm', '-f', node.name], { reject: false, env: process.env });
  }
  await execa('docker', ['rm', '-f', 'grafana'], { reject: false, env: process.env });
  await execa('docker', ['rm', '-f', 'prometheus'], { reject: false, env: process.env });

  // Remove genesis files
  const sharedGenesis = path.join(infraPath, 'shared', 'genesis');
  for (const f of ['genesis.address', 'genesis.snapshot']) {
    const filePath = path.join(sharedGenesis, f);
    if (fs.existsSync(filePath)) fs.rmSync(filePath);
  }

  // Remove network
  await execa('docker', ['network', 'rm', DOCKER_NETWORK], { reject: false, env: process.env });
}

// ---------------------------------------------------------------------------
// Start Grafana (docker-compose up)
// ---------------------------------------------------------------------------

/**
 * Start Grafana and Prometheus via docker-compose.
 * Matches start/containers/grafana.ansible.yml.
 */
export async function startGrafana(infraPath: string): Promise<void> {
  await dockerCompose(['up', '-d', '--no-recreate'], path.join(infraPath, 'grafana'));
}

/**
 * Stop Grafana and Prometheus via docker-compose.
 * Matches stop/containers/grafana.ansible.yml.
 */
export async function stopGrafana(infraPath: string): Promise<void> {
  await dockerCompose(['down'], path.join(infraPath, 'grafana'));
}

// ---------------------------------------------------------------------------
// Stop layer operations (kill processes by port)
// ---------------------------------------------------------------------------

/**
 * Stop global-l0 (node[0] only).
 * Matches stop/global-l0/cluster.ansible.yml.
 */
export async function stopGlobalL0(nodes: LocalNode[]): Promise<void> {
  if (nodes.length === 0) return;
  await killByPort(nodes[0]!.name, LAYER_BASE_PORTS['global-l0']!.public);
}

/**
 * Stop dag-l1 on all nodes.
 * Matches stop/dag-l1/cluster.ansible.yml.
 */
export async function stopDagL1(nodes: LocalNode[]): Promise<void> {
  for (let i = 0; i < nodes.length; i++) {
    await killByPort(nodes[i]!.name, nodePort(LAYER_BASE_PORTS['dag-l1']!.public, i));
  }
}

/**
 * Stop metagraph-l0 on all nodes.
 * Matches stop/metagraph-l0/cluster.ansible.yml.
 */
export async function stopMetagraphL0(nodes: LocalNode[]): Promise<void> {
  for (let i = 0; i < nodes.length; i++) {
    await killByPort(nodes[i]!.name, nodePort(LAYER_BASE_PORTS['metagraph-l0']!.public, i));
  }
}

/**
 * Stop currency-l1 on all nodes.
 * Matches stop/currency-l1/cluster.ansible.yml.
 */
export async function stopCurrencyL1(nodes: LocalNode[]): Promise<void> {
  for (let i = 0; i < nodes.length; i++) {
    await killByPort(nodes[i]!.name, nodePort(LAYER_BASE_PORTS['currency-l1']!.public, i));
  }
}

/**
 * Stop data-l1 on all nodes.
 * Matches stop/data-l1/cluster.ansible.yml.
 */
export async function stopDataL1(nodes: LocalNode[]): Promise<void> {
  for (let i = 0; i < nodes.length; i++) {
    await killByPort(nodes[i]!.name, nodePort(LAYER_BASE_PORTS['data-l1']!.public, i));
  }
}

// ---------------------------------------------------------------------------
// Start global-l0
// ---------------------------------------------------------------------------

/**
 * Start global-l0 (genesis or rollback) on node[0].
 * Matches start/global-l0/cluster.ansible.yml → genesis.ansible.yml / rollback.ansible.yml.
 *
 * @param nodes        - All nodes (only nodes[0] is used)
 * @param sourcePath   - Path to source/ directory (for p12 files)
 * @param forceGenesis - If true: run-genesis genesis.csv; if false: run-validator
 */
export async function startGlobalL0(
  nodes: LocalNode[],
  sourcePath: string,
  forceGenesis: boolean
): Promise<void> {
  const node = nodes[0]!;
  const container = node.name;
  const p12Name = node.key_file.name;
  const alias = node.key_file.alias;
  const password = node.key_file.password;
  const ip = containerIp(0);
  const ports = LAYER_BASE_PORTS['global-l0']!;

  // Copy p12 file into container
  await copyToContainer(
    path.join(sourcePath, 'p12-files', p12Name),
    container,
    `code/global-l0/${p12Name}`
  );

  const envVars: Record<string, string> = {
    CL_PUBLIC_HTTP_PORT: String(ports.public),
    CL_P2P_HTTP_PORT: String(ports.p2p),
    CL_CLI_HTTP_PORT: String(ports.cli),
    CL_KEYSTORE: p12Name,
    CL_KEYALIAS: alias,
    CL_PASSWORD: password,
    CL_APP_ENV: 'dev',
    CL_COLLATERAL: '0',
  };

  if (forceGenesis) {
    // Clean old data and logs
    await execVisible(
      container,
      `cd global-l0 && if [ -d "data" ]; then rm -r data; fi && if [ -d "logs" ]; then rm -r logs; fi`
    );
    // Start genesis
    await execCapture(
      container,
      `cd global-l0 && nohup java -jar global-l0.jar run-genesis genesis.csv --ip ${ip} > global-l0.log 2>&1 &`,
      envVars
    );
  } else {
    // Rollback: run-validator
    await execCapture(
      container,
      `cd global-l0 && nohup java -jar global-l0.jar run-validator --ip ${ip} > global-l0.log 2>&1 &`,
      envVars
    );
  }

  await pollNodeState(container, ports.public, 'Ready');
}

// ---------------------------------------------------------------------------
// Start dag-l1
// ---------------------------------------------------------------------------

/**
 * Start dag-l1 cluster (initial-validator on node[0], validators on nodes[1+]).
 * Matches start/dag-l1/cluster.ansible.yml.
 *
 * @param nodes      - All nodes
 * @param sourcePath - Path to source/ directory
 */
export async function startDagL1(nodes: LocalNode[], sourcePath: string): Promise<void> {
  const node0 = nodes[0]!;
  const leadId = await getLeadNodeId(
    node0.name,
    node0.key_file.name,
    node0.key_file.alias,
    node0.key_file.password
  );
  const leadIp = containerIp(0);
  const gl0PublicPort = LAYER_BASE_PORTS['global-l0']!.public;

  // Initial validator on node[0]
  await startDagL1InitialValidator(nodes, sourcePath, leadId, leadIp, gl0PublicPort);

  // Validators on nodes[1+]
  const dagPorts = LAYER_BASE_PORTS['dag-l1']!;
  const leadP2pPort = dagPorts.p2p; // node[0]'s p2p port

  for (let idx = 1; idx < nodes.length; idx++) {
    await startDagL1Validator(nodes, idx, sourcePath, leadId, leadIp, gl0PublicPort, leadP2pPort);
  }
}

async function startDagL1InitialValidator(
  nodes: LocalNode[],
  sourcePath: string,
  leadId: string,
  leadIp: string,
  gl0PublicPort: number
): Promise<void> {
  const node = nodes[0]!;
  const container = node.name;
  const p12Name = node.key_file.name;
  const ports = LAYER_BASE_PORTS['dag-l1']!;
  const ip = containerIp(0);

  await copyToContainer(
    path.join(sourcePath, 'p12-files', p12Name),
    container,
    `code/dag-l1/${p12Name}`
  );

  const envVars: Record<string, string> = {
    CL_PUBLIC_HTTP_PORT: String(ports.public),
    CL_P2P_HTTP_PORT: String(ports.p2p),
    CL_CLI_HTTP_PORT: String(ports.cli),
    CL_L0_PEER_HTTP_HOST: leadIp,
    CL_L0_PEER_HTTP_PORT: String(gl0PublicPort),
    CL_L0_PEER_ID: leadId,
    CL_KEYSTORE: p12Name,
    CL_KEYALIAS: node.key_file.alias,
    CL_PASSWORD: node.key_file.password,
    CL_APP_ENV: 'dev',
    CL_COLLATERAL: '0',
  };

  await execCapture(
    container,
    `cd dag-l1 && nohup java -jar dag-l1.jar run-initial-validator --ip ${ip} > dag-l1.log 2>&1 &`,
    envVars
  );

  await pollNodeState(container, ports.public, 'Ready');
}

async function startDagL1Validator(
  nodes: LocalNode[],
  nodeIndex: number,
  sourcePath: string,
  leadId: string,
  leadIp: string,
  gl0PublicPort: number,
  leadP2pPort: number
): Promise<void> {
  const node = nodes[nodeIndex]!;
  const container = node.name;
  const p12Name = node.key_file.name;
  const basePorts = LAYER_BASE_PORTS['dag-l1']!;
  const pubPort = nodePort(basePorts.public, nodeIndex);
  const p2pPort = nodePort(basePorts.p2p, nodeIndex);
  const cliPort = nodePort(basePorts.cli, nodeIndex);
  const ip = containerIp(nodeIndex);

  await copyToContainer(
    path.join(sourcePath, 'p12-files', p12Name),
    container,
    `code/dag-l1/${p12Name}`
  );

  const envVars: Record<string, string> = {
    CL_PUBLIC_HTTP_PORT: String(pubPort),
    CL_P2P_HTTP_PORT: String(p2pPort),
    CL_CLI_HTTP_PORT: String(cliPort),
    CL_L0_PEER_HTTP_HOST: leadIp,
    CL_L0_PEER_HTTP_PORT: String(gl0PublicPort),
    CL_L0_PEER_ID: leadId,
    CL_KEYSTORE: p12Name,
    CL_KEYALIAS: node.key_file.alias,
    CL_PASSWORD: node.key_file.password,
    CL_APP_ENV: 'dev',
    CL_COLLATERAL: '0',
  };

  await execCapture(
    container,
    `cd dag-l1 && nohup java -jar dag-l1.jar run-validator --ip ${ip} > dag-l1.log 2>&1 &`,
    envVars
  );

  await pollNodeState(container, pubPort, 'ReadyToJoin');

  // Join cluster
  await execCapture(
    container,
    `curl -X POST -H "Content-Type: application/json" -d '{"id":"${leadId}","ip":"${leadIp}","p2pPort":${leadP2pPort}}' "http://localhost:${cliPort}/cluster/join"`
  );
}

// ---------------------------------------------------------------------------
// Start metagraph-l0
// ---------------------------------------------------------------------------

export interface MetagraphL0StartParams {
  forceGenesis: boolean;
  networkHostIp: string;
  networkHostId: string;
  networkHostPublicPort: string;
}

/**
 * Start metagraph-l0 cluster (genesis or rollback on node[0], validators on nodes[1+]).
 * Matches start/metagraph-l0/cluster.ansible.yml.
 *
 * @param nodes      - All nodes
 * @param params     - Genesis/rollback parameters
 * @param sourcePath - Path to source/ directory
 * @param infraPath  - Path to infra/ directory
 */
export async function startMetagraphL0(
  nodes: LocalNode[],
  params: MetagraphL0StartParams,
  sourcePath: string,
  infraPath: string
): Promise<void> {
  const node0 = nodes[0]!;

  // Get lead node ID from global-l0 wallet
  const leadId = await getLeadNodeId(
    node0.name,
    node0.key_file.name,
    node0.key_file.alias,
    node0.key_file.password
  );
  const leadIp = containerIp(0);
  const gl0PublicPort = LAYER_BASE_PORTS['global-l0']!.public;

  // Genesis or rollback on node[0]
  if (params.forceGenesis) {
    await startMetagraphL0Genesis(
      nodes[0]!,
      sourcePath,
      leadId,
      leadIp,
      gl0PublicPort,
      params.networkHostIp,
      params.networkHostId,
      params.networkHostPublicPort
    );
  } else {
    await startMetagraphL0Rollback(
      nodes[0]!,
      sourcePath,
      infraPath,
      leadId,
      leadIp,
      gl0PublicPort,
      params.networkHostIp,
      params.networkHostId,
      params.networkHostPublicPort
    );
  }

  // Validators on nodes[1+]
  const ml0Ports = LAYER_BASE_PORTS['metagraph-l0']!;
  const leadP2pPort = ml0Ports.p2p; // node[0]'s p2p port

  for (let idx = 1; idx < nodes.length; idx++) {
    await startMetagraphL0Validator(
      nodes[idx]!,
      idx,
      sourcePath,
      infraPath,
      leadId,
      leadIp,
      gl0PublicPort,
      leadP2pPort,
      params.networkHostIp,
      params.networkHostId,
      params.networkHostPublicPort
    );
  }
}

async function startMetagraphL0Genesis(
  node: LocalNode,
  sourcePath: string,
  leadId: string,
  leadIp: string,
  gl0PublicPort: number,
  networkHostIp: string,
  networkHostId: string,
  networkHostPublicPort: string
): Promise<void> {
  const container = node.name;
  const p12Name = node.key_file.name;
  const alias = node.key_file.alias;
  const password = node.key_file.password;
  const ports = LAYER_BASE_PORTS['metagraph-l0']!;
  const ip = containerIp(0);

  // Determine GL0 peer (network host or local lead)
  const gl0PeerHost = networkHostIp || leadIp;
  const gl0PeerPort = networkHostPublicPort || String(gl0PublicPort);
  const gl0PeerId = networkHostId || leadId;

  // Copy p12
  await copyToContainer(
    path.join(sourcePath, 'p12-files', p12Name),
    container,
    `code/metagraph-l0/${p12Name}`
  );

  // Clean old data and logs
  await execVisible(
    container,
    `cd metagraph-l0 && if [ -d "data" ]; then rm -r data; fi && if [ -d "logs" ]; then rm -r logs; fi`
  );

  const baseEnv: Record<string, string> = {
    CL_PUBLIC_HTTP_PORT: String(ports.public),
    CL_P2P_HTTP_PORT: String(ports.p2p),
    CL_CLI_HTTP_PORT: String(ports.cli),
    CL_GLOBAL_L0_PEER_HTTP_HOST: gl0PeerHost,
    CL_GLOBAL_L0_PEER_HTTP_PORT: gl0PeerPort,
    CL_GLOBAL_L0_PEER_ID: gl0PeerId,
    CL_KEYSTORE: p12Name,
    CL_KEYALIAS: alias,
    CL_PASSWORD: password,
    CL_APP_ENV: 'dev',
    CL_COLLATERAL: '0',
  };

  // Create genesis
  await execVisible(container, `cd metagraph-l0 && java -jar metagraph-l0.jar create-genesis genesis.csv`, baseEnv);

  // Copy genesis files to shared_genesis
  await execCapture(
    container,
    `bash -c 'cp metagraph-l0/genesis.address shared_genesis && cp metagraph-l0/genesis.snapshot shared_genesis'`
  );

  // Copy jars to shared_jars
  await execCapture(
    container,
    `bash -c 'cp metagraph-l0/metagraph-l0.jar shared_jars && cp metagraph-l0/cl-keytool.jar shared_jars && cp metagraph-l0/cl-wallet.jar shared_jars'`
  );

  // Prepare owner message
  await execVisible(
    container,
    `/bin/bash -lc 'set -euo pipefail; cd metagraph-l0; ownerAddress="$(java -jar cl-wallet.jar show-address)"; metagraphId="$(tr -d "\\r\\n" < genesis.address)"; java -jar cl-wallet.jar create-owner-signing-message --address "\${ownerAddress}" --metagraphId "\${metagraphId}" --parentOrdinal 0 > owner-message'`,
    { CL_KEYSTORE: p12Name, CL_KEYALIAS: alias, CL_PASSWORD: password }
  );

  // Start as genesis
  await execCapture(
    container,
    `/bin/bash -lc 'set -euo pipefail; cd metagraph-l0; nohup java -jar metagraph-l0.jar run-genesis genesis.snapshot --metagraph-owner-message ./owner-message --ip ${ip} > metagraph-l0.log 2>&1 &'`,
    baseEnv
  );

  await pollNodeState(container, ports.public, 'Ready');
}

async function startMetagraphL0Rollback(
  node: LocalNode,
  sourcePath: string,
  infraPath: string,
  leadId: string,
  leadIp: string,
  gl0PublicPort: number,
  networkHostIp: string,
  networkHostId: string,
  networkHostPublicPort: string
): Promise<void> {
  const container = node.name;
  const p12Name = node.key_file.name;
  const alias = node.key_file.alias;
  const password = node.key_file.password;
  const ports = LAYER_BASE_PORTS['metagraph-l0']!;
  const ip = containerIp(0);

  const gl0PeerHost = networkHostIp || leadIp;
  const gl0PeerPort = networkHostPublicPort || String(gl0PublicPort);
  const gl0PeerId = networkHostId || leadId;

  // Read metagraph ID from shared genesis
  const genesisAddressFile = path.join(infraPath, 'shared', 'genesis', 'genesis.address');
  const metagraphId = fs.existsSync(genesisAddressFile)
    ? fs.readFileSync(genesisAddressFile, 'utf-8').trim()
    : '';

  // Copy p12
  await copyToContainer(
    path.join(sourcePath, 'p12-files', p12Name),
    container,
    `code/metagraph-l0/${p12Name}`
  );

  const envVars: Record<string, string> = {
    CL_PUBLIC_HTTP_PORT: String(ports.public),
    CL_P2P_HTTP_PORT: String(ports.p2p),
    CL_CLI_HTTP_PORT: String(ports.cli),
    CL_GLOBAL_L0_PEER_HTTP_HOST: gl0PeerHost,
    CL_GLOBAL_L0_PEER_HTTP_PORT: gl0PeerPort,
    CL_GLOBAL_L0_PEER_ID: gl0PeerId,
    CL_KEYSTORE: p12Name,
    CL_KEYALIAS: alias,
    CL_PASSWORD: password,
    CL_L0_TOKEN_IDENTIFIER: metagraphId,
    CL_APP_ENV: 'dev',
    CL_COLLATERAL: '0',
  };

  await execCapture(
    container,
    `cd metagraph-l0 && nohup java -jar metagraph-l0.jar run-rollback --ip ${ip} > metagraph-l0.log 2>&1 &`,
    envVars
  );

  await pollNodeState(container, ports.public, 'Ready');
}

async function startMetagraphL0Validator(
  node: LocalNode,
  nodeIndex: number,
  sourcePath: string,
  infraPath: string,
  leadId: string,
  leadIp: string,
  gl0PublicPort: number,
  leadP2pPort: number,
  networkHostIp: string,
  networkHostId: string,
  networkHostPublicPort: string
): Promise<void> {
  const container = node.name;
  const p12Name = node.key_file.name;
  const alias = node.key_file.alias;
  const password = node.key_file.password;
  const basePorts = LAYER_BASE_PORTS['metagraph-l0']!;
  const pubPort = nodePort(basePorts.public, nodeIndex);
  const p2pPort = nodePort(basePorts.p2p, nodeIndex);
  const cliPort = nodePort(basePorts.cli, nodeIndex);
  const ip = containerIp(nodeIndex);

  const gl0PeerHost = networkHostIp || leadIp;
  const gl0PeerPort = networkHostPublicPort || String(gl0PublicPort);
  const gl0PeerId = networkHostId || leadId;

  // Read metagraph ID
  const genesisAddressFile = path.join(infraPath, 'shared', 'genesis', 'genesis.address');
  const metagraphId = fs.existsSync(genesisAddressFile)
    ? fs.readFileSync(genesisAddressFile, 'utf-8').trim()
    : '';

  // Copy p12
  await copyToContainer(
    path.join(sourcePath, 'p12-files', p12Name),
    container,
    `code/metagraph-l0/${p12Name}`
  );

  const envVars: Record<string, string> = {
    CL_PUBLIC_HTTP_PORT: String(pubPort),
    CL_P2P_HTTP_PORT: String(p2pPort),
    CL_CLI_HTTP_PORT: String(cliPort),
    CL_GLOBAL_L0_PEER_HTTP_HOST: gl0PeerHost,
    CL_GLOBAL_L0_PEER_HTTP_PORT: gl0PeerPort,
    CL_GLOBAL_L0_PEER_ID: gl0PeerId,
    CL_KEYSTORE: p12Name,
    CL_KEYALIAS: alias,
    CL_PASSWORD: password,
    CL_L0_TOKEN_IDENTIFIER: metagraphId,
    CL_APP_ENV: 'dev',
    CL_COLLATERAL: '0',
  };

  await execCapture(
    container,
    `cd metagraph-l0 && nohup java -jar metagraph-l0.jar run-validator --ip ${ip} > metagraph-l0.log 2>&1 &`,
    envVars
  );

  await pollNodeState(container, pubPort, 'ReadyToJoin');

  // Join cluster
  await execCapture(
    container,
    `curl -X POST -H "Content-Type: application/json" -d '{"id":"${leadId}","ip":"${leadIp}","p2pPort":${leadP2pPort}}' "http://localhost:${cliPort}/cluster/join"`
  );
}

// ---------------------------------------------------------------------------
// Start currency-l1
// ---------------------------------------------------------------------------

/**
 * Start currency-l1 cluster (initial-validator on node[0], validators on nodes[1+]).
 * Matches start/currency-l1/cluster.ansible.yml.
 */
export async function startCurrencyL1(nodes: LocalNode[], sourcePath: string): Promise<void> {
  await startL1Cluster(nodes, sourcePath, 'currency-l1', 'currency-l1.jar');
}

// ---------------------------------------------------------------------------
// Start data-l1
// ---------------------------------------------------------------------------

/**
 * Start data-l1 cluster (initial-validator on node[0], validators on nodes[1+]).
 * Matches start/data-l1/cluster.ansible.yml.
 */
export async function startDataL1(nodes: LocalNode[], sourcePath: string): Promise<void> {
  await startL1Cluster(nodes, sourcePath, 'data-l1', 'data-l1.jar');
}

// ---------------------------------------------------------------------------
// Generic L1 cluster start (currency-l1 and data-l1 follow the same pattern)
// ---------------------------------------------------------------------------

async function startL1Cluster(
  nodes: LocalNode[],
  sourcePath: string,
  layer: 'currency-l1' | 'data-l1',
  jarName: string
): Promise<void> {
  const node0 = nodes[0]!;

  // Get ML0 lead node ID (same p12 → same ID for all layers on node[0])
  const leadId = await getLeadNodeId(
    node0.name,
    node0.key_file.name,
    node0.key_file.alias,
    node0.key_file.password
  );
  const leadIp = containerIp(0);
  const ml0PublicPort = LAYER_BASE_PORTS['metagraph-l0']!.public;

  // Initial validator on node[0]
  await startL1InitialValidator(nodes[0]!, 0, sourcePath, layer, jarName, leadId, leadIp, ml0PublicPort);

  const basePorts = LAYER_BASE_PORTS[layer]!;
  const leadP2pPort = basePorts.p2p; // node[0]'s p2p port for this layer

  // Validators on nodes[1+]
  for (let idx = 1; idx < nodes.length; idx++) {
    await startL1Validator(
      nodes[idx]!,
      idx,
      sourcePath,
      layer,
      jarName,
      leadId,
      leadIp,
      ml0PublicPort,
      leadP2pPort
    );
  }
}

async function startL1InitialValidator(
  node: LocalNode,
  nodeIndex: number,
  sourcePath: string,
  layer: string,
  jarName: string,
  ml0LeadId: string,
  ml0LeadIp: string,
  ml0PublicPort: number
): Promise<void> {
  const container = node.name;
  const p12Name = node.key_file.name;
  const basePorts = LAYER_BASE_PORTS[layer]!;
  const ip = containerIp(nodeIndex);

  await copyToContainer(
    path.join(sourcePath, 'p12-files', p12Name),
    container,
    `code/${layer}/${p12Name}`
  );

  const envVars: Record<string, string> = {
    CL_PUBLIC_HTTP_PORT: String(basePorts.public),
    CL_P2P_HTTP_PORT: String(basePorts.p2p),
    CL_CLI_HTTP_PORT: String(basePorts.cli),
    CL_L0_PEER_HTTP_HOST: ml0LeadIp,
    CL_L0_PEER_HTTP_PORT: String(ml0PublicPort),
    CL_L0_PEER_ID: ml0LeadId,
    CL_KEYSTORE: p12Name,
    CL_KEYALIAS: node.key_file.alias,
    CL_PASSWORD: node.key_file.password,
    CL_APP_ENV: 'dev',
    CL_COLLATERAL: '0',
  };

  await execCapture(
    container,
    `cd ${layer} && nohup java -jar ${jarName} run-initial-validator --ip ${ip} > ${layer}.log 2>&1 &`,
    envVars
  );

  await pollNodeState(container, basePorts.public, 'Ready');
}

async function startL1Validator(
  node: LocalNode,
  nodeIndex: number,
  sourcePath: string,
  layer: string,
  jarName: string,
  leadId: string,
  leadIp: string,
  ml0PublicPort: number,
  leadP2pPort: number
): Promise<void> {
  const container = node.name;
  const p12Name = node.key_file.name;
  const basePorts = LAYER_BASE_PORTS[layer]!;
  const pubPort = nodePort(basePorts.public, nodeIndex);
  const p2pPort = nodePort(basePorts.p2p, nodeIndex);
  const cliPort = nodePort(basePorts.cli, nodeIndex);
  const ip = containerIp(nodeIndex);

  await copyToContainer(
    path.join(sourcePath, 'p12-files', p12Name),
    container,
    `code/${layer}/${p12Name}`
  );

  const envVars: Record<string, string> = {
    CL_PUBLIC_HTTP_PORT: String(pubPort),
    CL_P2P_HTTP_PORT: String(p2pPort),
    CL_CLI_HTTP_PORT: String(cliPort),
    CL_L0_PEER_HTTP_HOST: leadIp,
    CL_L0_PEER_HTTP_PORT: String(ml0PublicPort),
    CL_L0_PEER_ID: leadId,
    CL_KEYSTORE: p12Name,
    CL_KEYALIAS: node.key_file.alias,
    CL_PASSWORD: node.key_file.password,
    CL_APP_ENV: 'dev',
    CL_COLLATERAL: '0',
  };

  await execCapture(
    container,
    `cd ${layer} && nohup java -jar ${jarName} run-validator --ip ${ip} > ${layer}.log 2>&1 &`,
    envVars
  );

  await pollNodeState(container, pubPort, 'ReadyToJoin');

  // leadId is the same for all layers on node[0] (same p12 key)
  await execCapture(
    container,
    `curl -X POST -H "Content-Type: application/json" -d '{"id":"${leadId}","ip":"${leadIp}","p2pPort":${leadP2pPort}}' "http://localhost:${cliPort}/cluster/join"`
  );
}
