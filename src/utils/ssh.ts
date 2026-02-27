/**
 * SSH helper — typed wrapper around node-ssh.
 *
 * Replaces ansible-playbook remote operations with direct SSH/SFTP calls.
 * Used by remote command implementations in src/commands/remote/.
 */
import * as path from 'node:path';
import { NodeSSH } from 'node-ssh';
import { logger } from './logger.js';

export { NodeSSH };

/**
 * Connect to a remote host and return an authenticated SSH client.
 *
 * @param host    - Remote hostname or IP address
 * @param user    - SSH username
 * @param keyPath - Absolute path to SSH private key file
 */
export async function connect(host: string, user: string, keyPath: string): Promise<NodeSSH> {
  const spinner = logger.spin(`Connecting to ${host}...`);
  const client = new NodeSSH();
  try {
    await client.connect({
      host,
      username: user,
      privateKeyPath: keyPath,
      readyTimeout: 30_000,
    });
    spinner.succeed(`Connected to ${host}`);
    return client;
  } catch (err) {
    spinner.fail(`Failed to connect to ${host}`);
    logger.error(
      `Failed to connect to ${host}\n  Reason: ${(err as Error).message}\n  Fix: Check SSH key and host are correct`
    );
    throw new Error('unreachable'); // logger.error calls process.exit(1)
  }
}

/**
 * Run a command on the remote host.
 *
 * Streams stdout/stderr to debug log. Throws on non-zero exit code.
 *
 * @param client  - Connected NodeSSH client
 * @param command - Shell command to execute
 * @param label   - Optional human-readable label for debug output
 * @returns Trimmed stdout string
 */
export async function run(client: NodeSSH, command: string, label?: string): Promise<string> {
  logger.debug(label ? `[SSH] ${label}: ${command}` : `[SSH] ${command}`);

  const result = await client.execCommand(command);

  if (result.stdout) logger.debug(`[SSH stdout] ${result.stdout.slice(0, 500)}`);
  if (result.stderr) logger.debug(`[SSH stderr] ${result.stderr.slice(0, 200)}`);

  if (result.code !== 0) {
    throw new Error(
      `SSH command failed (exit ${result.code ?? 'unknown'}):\n` +
        `  Command: ${command}\n` +
        `  Stdout:  ${result.stdout || '(empty)'}\n` +
        `  Stderr:  ${result.stderr || '(empty)'}`
    );
  }

  return result.stdout.trim();
}

/**
 * Upload a local file to the remote host via SFTP.
 *
 * @param client     - Connected NodeSSH client
 * @param localPath  - Absolute local file path
 * @param remotePath - Absolute remote file path
 */
export async function upload(
  client: NodeSSH,
  localPath: string,
  remotePath: string
): Promise<void> {
  const basename = path.basename(localPath);
  const spinner = logger.spin(`Uploading ${basename}...`);
  try {
    await client.putFile(localPath, remotePath);
    spinner.succeed(`Uploaded ${basename}`);
  } catch (err) {
    spinner.fail(`Failed to upload ${basename}`);
    throw err;
  }
}

/**
 * Upload a local directory to the remote host via SFTP.
 * Skips node_modules directories.
 *
 * @param client    - Connected NodeSSH client
 * @param localDir  - Local directory path
 * @param remoteDir - Remote directory path
 */
export async function uploadDirectory(
  client: NodeSSH,
  localDir: string,
  remoteDir: string
): Promise<void> {
  const dirname = path.basename(localDir);
  const spinner = logger.spin(`Uploading directory ${dirname}...`);
  try {
    await client.putDirectory(localDir, remoteDir, {
      recursive: true,
      concurrency: 5,
      validate: (itemPath) => !itemPath.includes('node_modules'),
    });
    spinner.succeed(`Uploaded directory ${dirname}`);
  } catch (err) {
    spinner.fail(`Failed to upload directory ${dirname}`);
    throw err;
  }
}

/**
 * Close the SSH connection gracefully.
 */
export function disconnect(client: NodeSSH): void {
  client.dispose();
}
