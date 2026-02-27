/**
 * Remote start operations — replaces infra/ansible/remote/nodes/playbooks/start/*.yml
 *
 * Uses node-ssh to:
 *   1. Clean (kill processes, archive logs) on each node
 *   2. Start metagraph-l0 on node-1 (genesis or rollback), then validators on node-2/3
 *   3. Start currency-l1 and data-l1 clusters
 *
 * Remote nodes use base ports without index offset (each node is a separate server).
 * Port constants match infra/ansible/remote/hosts.ansible.yml vars.
 */
import { type NodeSSH } from '../../utils/ssh.js';
import { run } from '../../utils/ssh.js';
import { logger } from '../../utils/logger.js';

// Remote node base ports (no per-node offset — each node is a separate server)
const REMOTE_PORTS = {
  'metagraph-l0': { public: 9200, p2p: 9201, cli: 9202 },
  'currency-l1':  { public: 9300, p2p: 9301, cli: 9302 },
  'data-l1':      { public: 9400, p2p: 9401, cli: 9402 },
};

const REMOTE_CODE_DIR = (user: string) => `/home/${user}/code`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JvmConfig {
  min_heap?: string;
  max_heap?: string;
  metaspace_size?: string;
  max_metaspace_size?: string;
  additional_opts?: string;
}

export interface RemoteNodeParams {
  user: string;
  /** Node's p12 key file name (in ~/code/metagraph-l0/) */
  keystore: string;
  keyalias: string;
  password: string;
  /** Target network name (e.g. "integrationnet") */
  network: string;
  /** GL0 peer host */
  gl0Ip: string;
  /** GL0 peer port */
  gl0Port: string;
  /** GL0 peer node ID */
  gl0Id: string;
  /** Metagraph ID (read from genesis.address) */
  metagraphId: string;
  /** JVM heap/metaspace settings */
  jvm: JvmConfig;
}

export interface RemoteML0GenesisParams extends RemoteNodeParams {
  forceGenesis: boolean;
  forceOwnerMessage: boolean;
  forceStakingMessage: boolean;
  /** Owner p12 file name */
  ownerP12Name: string;
  ownerP12Alias: string;
  ownerP12Password: string;
  /** Second signer for owner */
  secondSignerOwnerP12Name: string;
  secondSignerOwnerP12Alias: string;
  secondSignerOwnerP12Password: string;
  /** Staking p12 file name */
  stakingP12Name: string;
  stakingP12Alias: string;
  stakingP12Password: string;
  /** Second signer for staking */
  secondSignerStakingP12Name: string;
  secondSignerStakingP12Alias: string;
  secondSignerStakingP12Password: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jvmOpts(jvm: JvmConfig): string {
  return [
    `-Xms${jvm.min_heap ?? '1g'}`,
    `-Xmx${jvm.max_heap ?? '2g'}`,
    `-XX:MetaspaceSize=${jvm.metaspace_size ?? '256m'}`,
    `-XX:MaxMetaspaceSize=${jvm.max_metaspace_size ?? '512m'}`,
    jvm.additional_opts ?? '',
  ].filter(Boolean).join(' ');
}

function envPrefix(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => `export ${k}="${v.replace(/"/g, '\\"')}"`)
    .join('; ');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollRemoteNodeState(
  ssh: NodeSSH,
  port: number,
  expected: 'Ready' | 'ReadyToJoin',
  maxRetries = 120
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await run(ssh, `curl -sf http://localhost:${port}/node/info`);
      if (response.includes(expected)) return;
    } catch {
      // not ready yet
    }
    await sleep(2000);
  }
  throw new Error(`Remote node did not reach "${expected}" on port ${port} within ${maxRetries * 2}s`);
}

// ---------------------------------------------------------------------------
// Clean (kill processes and archive logs)
// ---------------------------------------------------------------------------

/**
 * Kill running metagraph-l0, currency-l1, and data-l1 processes and archive logs.
 * Matches infra/ansible/remote/nodes/playbooks/start/clean.ansible.yml.
 */
export async function cleanRemoteNode(ssh: NodeSSH, user: string): Promise<void> {
  const codeDir = REMOTE_CODE_DIR(user);
  const timestamp = await run(ssh, 'date +%Y-%m-%dT%H:%M:%S%z', 'get timestamp');

  for (const [layer, ports] of Object.entries(REMOTE_PORTS)) {
    // Kill process
    const killScript = `
      PID=$(lsof -t -i:${ports.public} 2>/dev/null || true)
      if [ -n "$PID" ]; then
        sudo kill -9 $PID 2>/dev/null || kill -9 $PID 2>/dev/null || true
      fi
    `.trim();
    await run(ssh, killScript, `kill ${layer}`).catch(() => {
      // ignore kill errors
    });

    // Archive logs
    await run(
      ssh,
      `mkdir -p ${codeDir}/${layer}/archived-logs && if [ -d "${codeDir}/${layer}/logs" ]; then mv "${codeDir}/${layer}/logs" "${codeDir}/${layer}/archived-logs/logs_${timestamp}" 2>/dev/null || true; fi`,
      `archive ${layer} logs`
    ).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Metagraph-L0 genesis / rollback on node-1
// ---------------------------------------------------------------------------

/**
 * Start metagraph-l0 on node-1 (genesis or rollback depending on state).
 * Matches start/metagraph-l0/genesis.ansible.yml.
 *
 * @returns node-1's public IP and node ID for use by validators
 */
export async function startRemoteML0Genesis(
  ssh: NodeSSH,
  params: RemoteML0GenesisParams,
  nodePublicIp: string
): Promise<{ nodeIp: string; nodeId: string }> {
  const { user, keystore, keyalias, password, network, gl0Ip, gl0Port, gl0Id, metagraphId, jvm } = params;
  const codeDir = REMOTE_CODE_DIR(user);
  const ml0Dir = `${codeDir}/metagraph-l0`;
  const ports = REMOTE_PORTS['metagraph-l0'];

  // Check for incremental snapshots
  const hasSnapshots = await run(
    ssh,
    `test -d ${ml0Dir}/data/incremental_snapshot && echo 1 || echo 0`
  ).then((s) => s.trim() === '1');

  const shouldRunGenesis = !hasSnapshots || params.forceGenesis;
  const shouldRunRollback = hasSnapshots && !params.forceGenesis;

  logger.info(`ML0 node-1: running ${shouldRunGenesis ? 'genesis' : 'rollback'}`);

  // Archive existing data if running genesis
  if (shouldRunGenesis) {
    const timestamp = await run(ssh, 'date +%Y%m%dT%H%M%S');
    await run(
      ssh,
      `mkdir -p ${ml0Dir}/archived-data && if [ -d "${ml0Dir}/data" ]; then mv "${ml0Dir}/data" "${ml0Dir}/archived-data/data_${timestamp.trim()}"; fi`,
      'archive old data'
    ).catch(() => {});
  }

  // Fetch GL0 snapshot and compute ordinals for signing messages
  let ownerParentOrdinal = 0;
  let stakingParentOrdinal = 0;

  if (shouldRunGenesis || params.forceOwnerMessage || params.forceStakingMessage) {
    try {
      const snapshotJson = await run(
        ssh,
        `curl -sf "http://${gl0Ip}:${gl0Port}/global-snapshots/latest/combined" -H "Accept: application/json"`
      );
      const snapshot = JSON.parse(snapshotJson);
      const lastMessages =
        snapshot?.[1]?.lastCurrencySnapshots?.[metagraphId]?.Right?.[1]?.lastMessages ?? {};
      ownerParentOrdinal = ((lastMessages?.Owner?.value?.parentOrdinal ?? -1) as number) + 1;
      stakingParentOrdinal = ((lastMessages?.Staking?.value?.parentOrdinal ?? -1) as number) + 1;
    } catch {
      logger.debug('Could not fetch GL0 snapshot ordinals, defaulting to 0');
    }
  }

  // Generate owner message (for genesis: write to file; for rollback+force: POST)
  if (params.ownerP12Name && (shouldRunGenesis || params.forceOwnerMessage)) {
    const ownerEnv = { CL_KEYSTORE: params.ownerP12Name, CL_KEYALIAS: params.ownerP12Alias, CL_PASSWORD: params.ownerP12Password };

    // Get owner address
    const ownerAddress = await run(
      ssh,
      `cd ${ml0Dir} && ${envPrefix(ownerEnv)} java -jar cl-wallet.jar show-address`
    );

    if (shouldRunGenesis) {
      // Write owner-message to file (used as --metagraph-owner-message arg)
      await run(
        ssh,
        `cd ${ml0Dir} && ${envPrefix(ownerEnv)} java -jar cl-wallet.jar create-owner-signing-message --address "${ownerAddress}" --metagraphId "${metagraphId}" --parentOrdinal ${ownerParentOrdinal} > owner-message`,
        'create owner-message file'
      );
    }
  }

  // Build JVM opts string
  const jvmOptsStr = jvmOpts(jvm);

  // Build environment
  const baseEnv: Record<string, string> = {
    CL_PUBLIC_HTTP_PORT: String(ports.public),
    CL_P2P_HTTP_PORT: String(ports.p2p),
    CL_CLI_HTTP_PORT: String(ports.cli),
    CL_GLOBAL_L0_PEER_HTTP_HOST: gl0Ip,
    CL_GLOBAL_L0_PEER_HTTP_PORT: gl0Port,
    CL_GLOBAL_L0_PEER_ID: gl0Id,
    CL_KEYSTORE: keystore,
    CL_KEYALIAS: keyalias,
    CL_PASSWORD: password,
    CL_APP_ENV: network,
    CL_COLLATERAL: '0',
  };

  if (shouldRunRollback) {
    baseEnv['CL_L0_TOKEN_IDENTIFIER'] = metagraphId;
  }

  const startCommand = shouldRunGenesis
    ? `run-genesis genesis.snapshot --metagraph-owner-message ./owner-message`
    : `run-rollback`;

  // Start the node
  await run(
    ssh,
    `cd ${ml0Dir} && ${envPrefix(baseEnv)} nohup java ${jvmOptsStr} -jar metagraph-l0.jar ${startCommand} --ip ${nodePublicIp} > metagraph-l0.log 2>&1 &`,
    'start metagraph-l0'
  );

  // Wait for Ready
  await pollRemoteNodeState(ssh, ports.public, 'Ready');

  // Wait 15s before sending messages (matches ansible pause)
  logger.info('Waiting 15s before sending currency messages...');
  await sleep(15_000);

  // Generate and send staking message
  if (params.stakingP12Name && (shouldRunGenesis || params.forceStakingMessage)) {
    await sendStakingMessage(ssh, ml0Dir, params, metagraphId, stakingParentOrdinal, ports.public);
  }

  // Get node ID and public IP for validators
  const nodeId = await run(
    ssh,
    `cd ${ml0Dir} && ${envPrefix({ CL_KEYSTORE: keystore, CL_KEYALIAS: keyalias, CL_PASSWORD: password })} java -jar cl-wallet.jar show-id`
  );

  // Fetch public IP
  let nodeIp = nodePublicIp;
  try {
    nodeIp = await run(ssh, 'curl -sf https://ifconfig.me/ip');
  } catch {
    // fall back to passed-in IP
  }

  return { nodeIp: nodeIp.trim(), nodeId: nodeId.trim() };
}

async function sendStakingMessage(
  ssh: NodeSSH,
  ml0Dir: string,
  params: RemoteML0GenesisParams,
  metagraphId: string,
  stakingParentOrdinal: number,
  ml0PublicPort: number
): Promise<void> {
  const stakingEnv = {
    CL_KEYSTORE: params.stakingP12Name,
    CL_KEYALIAS: params.stakingP12Alias,
    CL_PASSWORD: params.stakingP12Password,
  };

  const stakingAddress = await run(
    ssh,
    `cd ${ml0Dir} && ${envPrefix(stakingEnv)} java -jar cl-wallet.jar show-address`
  );

  const stakingMsgFirst = await run(
    ssh,
    `cd ${ml0Dir} && ${envPrefix(stakingEnv)} java -jar cl-wallet.jar create-staking-signing-message --address "${stakingAddress}" --parentOrdinal ${stakingParentOrdinal} --metagraphId "${metagraphId}"`
  );

  let stakingMessage = JSON.parse(stakingMsgFirst);

  if (params.secondSignerStakingP12Name) {
    const secondEnv = {
      CL_KEYSTORE: params.secondSignerStakingP12Name,
      CL_KEYALIAS: params.secondSignerStakingP12Alias,
      CL_PASSWORD: params.secondSignerStakingP12Password,
    };
    const stakingMsgSecond = await run(
      ssh,
      `cd ${ml0Dir} && ${envPrefix(secondEnv)} java -jar cl-wallet.jar create-staking-signing-message --address "${stakingAddress}" --parentOrdinal ${stakingParentOrdinal} --metagraphId "${metagraphId}"`
    );
    const secondParsed = JSON.parse(stakingMsgSecond);
    stakingMessage = {
      ...stakingMessage,
      proofs: [...stakingMessage.proofs, ...secondParsed.proofs],
    };
  }

  await run(
    ssh,
    `curl -sf -X POST http://localhost:${ml0PublicPort}/currency/message -H "Content-Type: application/json" -d '${JSON.stringify(stakingMessage)}'`,
    'POST staking message'
  ).catch((err) => logger.warn(`Could not send staking message: ${(err as Error).message}`));
}

// ---------------------------------------------------------------------------
// ML0 validator (node-2, node-3)
// ---------------------------------------------------------------------------

/**
 * Start metagraph-l0 as validator and join the genesis node cluster.
 * Matches start/metagraph-l0/validator.ansible.yml.
 */
export async function startRemoteML0Validator(
  ssh: NodeSSH,
  params: RemoteNodeParams,
  nodePublicIp: string,
  genesisNodeId: string,
  genesisNodeIp: string
): Promise<void> {
  const { user, keystore, keyalias, password, network, gl0Ip, gl0Port, gl0Id, metagraphId, jvm } = params;
  const codeDir = REMOTE_CODE_DIR(user);
  const ml0Dir = `${codeDir}/metagraph-l0`;
  const ports = REMOTE_PORTS['metagraph-l0'];

  const envVars: Record<string, string> = {
    CL_PUBLIC_HTTP_PORT: String(ports.public),
    CL_P2P_HTTP_PORT: String(ports.p2p),
    CL_CLI_HTTP_PORT: String(ports.cli),
    CL_GLOBAL_L0_PEER_HTTP_HOST: gl0Ip,
    CL_GLOBAL_L0_PEER_HTTP_PORT: gl0Port,
    CL_GLOBAL_L0_PEER_ID: gl0Id,
    CL_KEYSTORE: keystore,
    CL_KEYALIAS: keyalias,
    CL_PASSWORD: password,
    CL_APP_ENV: network,
    CL_COLLATERAL: '0',
    CL_L0_TOKEN_IDENTIFIER: metagraphId,
  };

  const jvmOptsStr = jvmOpts(jvm);

  await run(
    ssh,
    `cd ${ml0Dir} && ${envPrefix(envVars)} nohup java ${jvmOptsStr} -jar metagraph-l0.jar run-validator --ip ${nodePublicIp} > metagraph-l0.log 2>&1 &`,
    'start ml0 validator'
  );

  await pollRemoteNodeState(ssh, ports.public, 'ReadyToJoin');

  // Join cluster
  await run(
    ssh,
    `curl -sf -X POST http://localhost:${ports.cli}/cluster/join -H "Content-Type: application/json" -d '{"id":"${genesisNodeId}","ip":"${genesisNodeIp}","p2pPort":${ports.p2p}}'`,
    'join ml0 cluster'
  ).catch((err) => logger.warn(`ML0 cluster join warning: ${(err as Error).message}`));
}

// ---------------------------------------------------------------------------
// Currency-L1
// ---------------------------------------------------------------------------

/**
 * Start currency-l1 as initial-validator on node-1.
 * Matches start/currency-l1/initial_validator.ansible.yml.
 */
export async function startRemoteCL1InitialValidator(
  ssh: NodeSSH,
  params: RemoteNodeParams,
  nodePublicIp: string,
  ml0NodeId: string,
  ml0NodeIp: string
): Promise<void> {
  await startRemoteL1InitialValidator(ssh, params, nodePublicIp, ml0NodeId, ml0NodeIp, 'currency-l1', 'currency-l1.jar');
}

/**
 * Start currency-l1 as validator on node-2/3.
 * Matches start/currency-l1/validator.ansible.yml.
 */
export async function startRemoteCL1Validator(
  ssh: NodeSSH,
  params: RemoteNodeParams,
  nodePublicIp: string,
  ml0NodeId: string,
  ml0NodeIp: string,
  cl1GenesisNodeId: string,
  cl1GenesisNodeIp: string
): Promise<void> {
  await startRemoteL1Validator(
    ssh, params, nodePublicIp, ml0NodeId, ml0NodeIp,
    cl1GenesisNodeId, cl1GenesisNodeIp,
    'currency-l1', 'currency-l1.jar'
  );
}

// ---------------------------------------------------------------------------
// Data-L1
// ---------------------------------------------------------------------------

/**
 * Start data-l1 as initial-validator on node-1.
 */
export async function startRemoteDL1InitialValidator(
  ssh: NodeSSH,
  params: RemoteNodeParams,
  nodePublicIp: string,
  ml0NodeId: string,
  ml0NodeIp: string
): Promise<void> {
  await startRemoteL1InitialValidator(ssh, params, nodePublicIp, ml0NodeId, ml0NodeIp, 'data-l1', 'data-l1.jar');
}

/**
 * Start data-l1 as validator on node-2/3.
 */
export async function startRemoteDL1Validator(
  ssh: NodeSSH,
  params: RemoteNodeParams,
  nodePublicIp: string,
  ml0NodeId: string,
  ml0NodeIp: string,
  dl1GenesisNodeId: string,
  dl1GenesisNodeIp: string
): Promise<void> {
  await startRemoteL1Validator(
    ssh, params, nodePublicIp, ml0NodeId, ml0NodeIp,
    dl1GenesisNodeId, dl1GenesisNodeIp,
    'data-l1', 'data-l1.jar'
  );
}

// ---------------------------------------------------------------------------
// Generic L1 helpers
// ---------------------------------------------------------------------------

async function startRemoteL1InitialValidator(
  ssh: NodeSSH,
  params: RemoteNodeParams,
  nodePublicIp: string,
  ml0NodeId: string,
  ml0NodeIp: string,
  layer: string,
  jarName: string
): Promise<void> {
  const { user, keystore, keyalias, password, network, gl0Ip, gl0Port, gl0Id, metagraphId, jvm } = params;
  const codeDir = REMOTE_CODE_DIR(user);
  const layerDir = `${codeDir}/${layer}`;
  const ml0Ports = REMOTE_PORTS['metagraph-l0'];
  const l1Ports = REMOTE_PORTS[layer as keyof typeof REMOTE_PORTS];
  if (!l1Ports) return;

  // Skip if jar doesn't exist
  const jarExists = await run(ssh, `test -f ${layerDir}/${jarName} && echo 1 || echo 0`)
    .then((s) => s.trim() === '1');
  if (!jarExists) {
    logger.warn(`${jarName} not found on remote, skipping ${layer} initial-validator`);
    return;
  }

  const envVars: Record<string, string> = {
    CL_PUBLIC_HTTP_PORT: String(l1Ports.public),
    CL_P2P_HTTP_PORT: String(l1Ports.p2p),
    CL_CLI_HTTP_PORT: String(l1Ports.cli),
    CL_L0_PEER_ID: ml0NodeId,
    CL_L0_PEER_HTTP_HOST: ml0NodeIp,
    CL_L0_PEER_HTTP_PORT: String(ml0Ports.public),
    CL_GLOBAL_L0_PEER_HTTP_HOST: gl0Ip,
    CL_GLOBAL_L0_PEER_HTTP_PORT: gl0Port,
    CL_GLOBAL_L0_PEER_ID: gl0Id,
    CL_KEYSTORE: keystore,
    CL_KEYALIAS: keyalias,
    CL_PASSWORD: password,
    CL_APP_ENV: network,
    CL_COLLATERAL: '0',
    CL_L0_TOKEN_IDENTIFIER: metagraphId,
  };

  await run(
    ssh,
    `cd ${layerDir} && ${envPrefix(envVars)} nohup java ${jvmOpts(jvm)} -jar ${jarName} run-initial-validator --ip ${nodePublicIp} > ${layer}.log 2>&1 &`,
    `start ${layer} initial-validator`
  );

  await pollRemoteNodeState(ssh, l1Ports.public, 'Ready');
}

async function startRemoteL1Validator(
  ssh: NodeSSH,
  params: RemoteNodeParams,
  nodePublicIp: string,
  ml0NodeId: string,
  ml0NodeIp: string,
  genesisNodeId: string,
  genesisNodeIp: string,
  layer: string,
  jarName: string
): Promise<void> {
  const { user, keystore, keyalias, password, network, gl0Ip, gl0Port, gl0Id, metagraphId, jvm } = params;
  const codeDir = REMOTE_CODE_DIR(user);
  const layerDir = `${codeDir}/${layer}`;
  const ml0Ports = REMOTE_PORTS['metagraph-l0'];
  const l1Ports = REMOTE_PORTS[layer as keyof typeof REMOTE_PORTS];
  if (!l1Ports) return;

  const jarExists = await run(ssh, `test -f ${layerDir}/${jarName} && echo 1 || echo 0`)
    .then((s) => s.trim() === '1');
  if (!jarExists) {
    logger.warn(`${jarName} not found on remote, skipping ${layer} validator`);
    return;
  }

  const envVars: Record<string, string> = {
    CL_PUBLIC_HTTP_PORT: String(l1Ports.public),
    CL_P2P_HTTP_PORT: String(l1Ports.p2p),
    CL_CLI_HTTP_PORT: String(l1Ports.cli),
    CL_L0_PEER_ID: ml0NodeId,
    CL_L0_PEER_HTTP_HOST: ml0NodeIp,
    CL_L0_PEER_HTTP_PORT: String(ml0Ports.public),
    CL_GLOBAL_L0_PEER_HTTP_HOST: gl0Ip,
    CL_GLOBAL_L0_PEER_HTTP_PORT: gl0Port,
    CL_GLOBAL_L0_PEER_ID: gl0Id,
    CL_KEYSTORE: keystore,
    CL_KEYALIAS: keyalias,
    CL_PASSWORD: password,
    CL_APP_ENV: network,
    CL_COLLATERAL: '0',
    CL_L0_TOKEN_IDENTIFIER: metagraphId,
  };

  await run(
    ssh,
    `cd ${layerDir} && ${envPrefix(envVars)} nohup java ${jvmOpts(jvm)} -jar ${jarName} run-validator --ip ${nodePublicIp} > ${layer}.log 2>&1 &`,
    `start ${layer} validator`
  );

  await pollRemoteNodeState(ssh, l1Ports.public, 'ReadyToJoin');

  // Join cluster
  await run(
    ssh,
    `curl -sf -X POST http://localhost:${l1Ports.cli}/cluster/join -H "Content-Type: application/json" -d '{"id":"${genesisNodeId}","ip":"${genesisNodeIp}","p2pPort":${l1Ports.p2p}}'`,
    `join ${layer} cluster`
  ).catch((err) => logger.warn(`${layer} cluster join warning: ${(err as Error).message}`));
}
