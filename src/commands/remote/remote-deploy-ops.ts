/**
 * Remote deploy operations — replaces infra/ansible/remote/nodes/playbooks/deploy/*.yml
 *
 * Uses node-ssh to:
 *   1. Install Java dependencies on each remote node (configure.ansible.yml)
 *   2. Upload JARs and genesis files (deploy.ansible.yml)
 *   3. Upload per-node p12 key files
 *   4. Upload owner/staking/second-signer p12 files
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type NodeSSH } from '../../utils/ssh.js';
import { run, upload } from '../../utils/ssh.js';
import { logger } from '../../utils/logger.js';

// Remote code base directory
const REMOTE_CODE_DIR = (user: string) => `/home/${user}/code`;

// ---------------------------------------------------------------------------
// Dependency installation
// ---------------------------------------------------------------------------

/**
 * Install Java and required dependencies on a remote node.
 * Matches infra/ansible/remote/nodes/playbooks/deploy/configure.ansible.yml.
 *
 * @param ssh - Connected SSH client
 */
export async function installNodeDependencies(ssh: NodeSSH): Promise<void> {
  logger.step(`Installing dependencies on remote node...`);

  // Update apt and install Java 21
  await run(ssh, 'sudo apt-get update -qq', 'apt update');
  await run(
    ssh,
    'sudo apt-get install -y --no-install-recommends openjdk-21-jre curl wget gnupg',
    'install java'
  );

  logger.success('Dependencies installed');
}

// ---------------------------------------------------------------------------
// Directory creation
// ---------------------------------------------------------------------------

/**
 * Create required directories on a remote node.
 */
export async function createRemoteDirectories(
  ssh: NodeSSH,
  user: string,
  layers: string[]
): Promise<void> {
  const codeDir = REMOTE_CODE_DIR(user);
  await run(ssh, `mkdir -p ${codeDir}`, 'create code dir');

  if (layers.includes('metagraph-l0')) {
    await run(ssh, `mkdir -p ${codeDir}/metagraph-l0`, 'create metagraph-l0 dir');
  }
  if (layers.includes('currency-l1') || layers.includes('metagraph-l1-currency')) {
    await run(ssh, `mkdir -p ${codeDir}/currency-l1`, 'create currency-l1 dir');
  }
  if (layers.includes('data-l1') || layers.includes('metagraph-l1-data')) {
    await run(ssh, `mkdir -p ${codeDir}/data-l1`, 'create data-l1 dir');
  }
}

// ---------------------------------------------------------------------------
// JAR upload
// ---------------------------------------------------------------------------

export interface DeployJarsParams {
  user: string;
  infraPath: string;
  sourcePath: string;
  layers: string[];
  forceGenesis: boolean;
  deployClOne: boolean;
  deployDlOne: boolean;
}

/**
 * Upload JAR files and genesis files to a remote node.
 * Matches send JARs and genesis file tasks in deploy.ansible.yml.
 */
export async function deployJarsToNode(
  ssh: NodeSSH,
  params: DeployJarsParams
): Promise<void> {
  const { user, infraPath, sourcePath, layers, forceGenesis, deployClOne, deployDlOne } = params;
  const codeDir = REMOTE_CODE_DIR(user);
  const sharedJars = path.join(infraPath, 'shared', 'jars');
  const sharedGenesis = path.join(infraPath, 'shared', 'genesis');

  // Upload cl-keytool.jar and cl-wallet.jar to code dir, then copy to layers
  const clKeytoolLocal = path.join(sharedJars, 'cl-keytool.jar');
  const clWalletLocal = path.join(sharedJars, 'cl-wallet.jar');

  if (fs.existsSync(clKeytoolLocal)) {
    await upload(ssh, clKeytoolLocal, `${codeDir}/cl-keytool.jar`);
  }
  if (fs.existsSync(clWalletLocal)) {
    await upload(ssh, clWalletLocal, `${codeDir}/cl-wallet.jar`);
  }

  // Copy cl-keytool/cl-wallet to each layer
  if (layers.includes('metagraph-l0')) {
    await run(
      ssh,
      `cp ${codeDir}/cl-keytool.jar ${codeDir}/metagraph-l0/ && cp ${codeDir}/cl-wallet.jar ${codeDir}/metagraph-l0/`,
      'copy wallet jars to metagraph-l0'
    );
  }
  if (deployClOne) {
    await run(
      ssh,
      `cp ${codeDir}/cl-keytool.jar ${codeDir}/currency-l1/ && cp ${codeDir}/cl-wallet.jar ${codeDir}/currency-l1/`,
      'copy wallet jars to currency-l1'
    );
  }
  if (deployDlOne) {
    await run(
      ssh,
      `cp ${codeDir}/cl-keytool.jar ${codeDir}/data-l1/ && cp ${codeDir}/cl-wallet.jar ${codeDir}/data-l1/`,
      'copy wallet jars to data-l1'
    );
  }

  // Upload metagraph-l0.jar
  if (layers.includes('metagraph-l0')) {
    const ml0Jar = path.join(sharedJars, 'metagraph-l0.jar');
    if (fs.existsSync(ml0Jar)) {
      await upload(ssh, ml0Jar, `${codeDir}/metagraph-l0/metagraph-l0.jar`);
    }
  }

  // Upload currency-l1.jar
  if (deployClOne) {
    const cl1Jar = path.join(sharedJars, 'currency-l1.jar');
    if (fs.existsSync(cl1Jar)) {
      await upload(ssh, cl1Jar, `${codeDir}/currency-l1/currency-l1.jar`);
    }
  }

  // Upload data-l1.jar
  if (deployDlOne) {
    const dl1Jar = path.join(sharedJars, 'data-l1.jar');
    if (fs.existsSync(dl1Jar)) {
      await upload(ssh, dl1Jar, `${codeDir}/data-l1/data-l1.jar`);
    }
  }

  // Clean temp wallet jars from code root
  await run(
    ssh,
    `rm -f ${codeDir}/cl-keytool.jar ${codeDir}/cl-wallet.jar`,
    'clean tmp jars'
  );

  // Upload genesis files
  if (layers.includes('metagraph-l0')) {
    const genesisAddressLocal = path.join(sharedGenesis, 'genesis.address');
    const genesisSnapshotLocal = path.join(sharedGenesis, 'genesis.snapshot');
    const genesisCsvLocal = path.join(sourcePath, 'metagraph-l0', 'genesis', 'genesis.csv');

    // Check remote existence before uploading (unless forceGenesis)
    if (forceGenesis || !(await remoteFileExists(ssh, `${codeDir}/metagraph-l0/genesis.csv`))) {
      if (fs.existsSync(genesisCsvLocal)) {
        await upload(ssh, genesisCsvLocal, `${codeDir}/metagraph-l0/genesis.csv`);
      }
    }
    if (forceGenesis || !(await remoteFileExists(ssh, `${codeDir}/metagraph-l0/genesis.snapshot`))) {
      if (fs.existsSync(genesisSnapshotLocal)) {
        await upload(ssh, genesisSnapshotLocal, `${codeDir}/metagraph-l0/genesis.snapshot`);
      }
    }
    if (forceGenesis || !(await remoteFileExists(ssh, `${codeDir}/metagraph-l0/genesis.address`))) {
      if (fs.existsSync(genesisAddressLocal)) {
        await upload(ssh, genesisAddressLocal, `${codeDir}/metagraph-l0/genesis.address`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// P12 file upload
// ---------------------------------------------------------------------------

export interface DeployP12Params {
  user: string;
  sourcePath: string;
  nodeP12Name: string;
  ownerP12Name: string;
  stakingP12Name: string;
  secondSignerOwnerP12Name: string;
  secondSignerStakingP12Name: string;
  layers: string[];
  deployClOne: boolean;
  deployDlOne: boolean;
}

/**
 * Upload p12 key files to a remote node.
 * Matches the "Send p12 files" and "Send primary snapshot fee p12" tasks in deploy.ansible.yml.
 *
 * @param ssh    - Connected SSH client
 * @param params - P12 file names and paths
 */
export async function deployP12sToNode(
  ssh: NodeSSH,
  params: DeployP12Params
): Promise<void> {
  const {
    user, sourcePath, nodeP12Name, ownerP12Name, stakingP12Name,
    secondSignerOwnerP12Name, secondSignerStakingP12Name,
    layers, deployClOne, deployDlOne,
  } = params;
  const codeDir = REMOTE_CODE_DIR(user);
  const p12Dir = path.join(sourcePath, 'p12-files');

  // Upload the per-node p12
  const nodeP12Local = path.join(p12Dir, nodeP12Name);
  if (fs.existsSync(nodeP12Local)) {
    await upload(ssh, nodeP12Local, `${codeDir}/${nodeP12Name}`);
    if (layers.includes('metagraph-l0')) {
      await run(ssh, `cp ${codeDir}/${nodeP12Name} ${codeDir}/metagraph-l0/`, 'copy p12 to ml0');
    }
    if (deployClOne) {
      await run(ssh, `cp ${codeDir}/${nodeP12Name} ${codeDir}/currency-l1/`, 'copy p12 to cl1');
    }
    if (deployDlOne) {
      await run(ssh, `cp ${codeDir}/${nodeP12Name} ${codeDir}/data-l1/`, 'copy p12 to dl1');
    }
    await run(ssh, `rm -f ${codeDir}/${nodeP12Name}`, 'clean tmp p12');
  }

  // Upload owner p12 to metagraph-l0
  if (ownerP12Name) {
    const ownerLocal = path.join(p12Dir, ownerP12Name);
    if (fs.existsSync(ownerLocal)) {
      await upload(ssh, ownerLocal, `${codeDir}/metagraph-l0/${ownerP12Name}`);
    }
  }

  // Upload staking p12 to metagraph-l0
  if (stakingP12Name) {
    const stakingLocal = path.join(p12Dir, stakingP12Name);
    if (fs.existsSync(stakingLocal)) {
      await upload(ssh, stakingLocal, `${codeDir}/metagraph-l0/${stakingP12Name}`);
    }
  }

  // Upload second signer p12s (owner and staking) to metagraph-l0
  if (secondSignerOwnerP12Name) {
    const local = path.join(p12Dir, secondSignerOwnerP12Name);
    if (fs.existsSync(local)) {
      await upload(ssh, local, `${codeDir}/metagraph-l0/${secondSignerOwnerP12Name}`);
    }
  }
  if (secondSignerStakingP12Name) {
    const local = path.join(p12Dir, secondSignerStakingP12Name);
    if (fs.existsSync(local)) {
      await upload(ssh, local, `${codeDir}/metagraph-l0/${secondSignerStakingP12Name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function remoteFileExists(ssh: NodeSSH, remotePath: string): Promise<boolean> {
  try {
    await run(ssh, `test -f ${remotePath}`);
    return true;
  } catch {
    return false;
  }
}
