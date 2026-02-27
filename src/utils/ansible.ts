/**
 * Ansible helper utilities for the hydra CLI.
 *
 * Provides typed wrappers for running ansible-playbook commands,
 * parsing Ansible inventory YAML files, and validating remote host configurations.
 *
 * All shell invocations use execa (never child_process directly).
 */

import * as fs from 'node:fs';
import yaml from 'js-yaml';
import { execa } from 'execa';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single host entry in an Ansible inventory file. */
export interface AnsibleHost {
  ansible_host: string | null;
  ansible_user: string | null;
  ansible_ssh_private_key_file: string | null;
  [key: string]: unknown;
}

/**
 * Vars section for the `nodes` group in the Ansible inventory.
 * Port numbers come from infra/ansible/remote/hosts.ansible.yml.
 */
export interface AnsibleNodeVars {
  base_metagraph_l0_public_port: number;
  base_metagraph_l0_p2p_port: number;
  base_metagraph_l0_cli_port: number;
  base_currency_l1_public_port: number;
  base_currency_l1_p2p_port: number;
  base_currency_l1_cli_port: number;
  base_data_l1_public_port: number;
  base_data_l1_p2p_port: number;
  base_data_l1_cli_port: number;
  [key: string]: unknown;
}

/**
 * Fully typed representation of infra/ansible/remote/hosts.ansible.yml.
 *
 * Structure:
 * ```yaml
 * nodes:
 *   hosts:
 *     node-1: { ansible_host, ansible_user, ansible_ssh_private_key_file }
 *     node-2: ...
 *     node-3: ...
 *   vars:
 *     base_metagraph_l0_public_port: 9100
 *     ...
 * monitoring:
 *   hosts:
 *     monitoring-1: { ansible_host, ansible_user, ansible_ssh_private_key_file }
 *   vars: ...
 * ```
 */
export interface AnsibleHosts {
  nodes: {
    hosts: Record<string, AnsibleHost>;
    vars: AnsibleNodeVars;
  };
  monitoring: {
    hosts: Record<string, AnsibleHost>;
    vars: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Extra vars builder
// ---------------------------------------------------------------------------

/**
 * Convert a vars record into ansible-playbook -e arguments.
 *
 * Matches the bash pattern:
 *   ansible-playbook -e "key1=value1" -e "key2=value2" ...
 *
 * @param vars - Key/value pairs to inject as extra vars
 * @returns Array of args: ['-e', 'key=val', '-e', 'key=val', ...]
 */
export function buildExtraVars(vars: Record<string, string>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    args.push('-e', `${key}=${value}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Ansible runner
// ---------------------------------------------------------------------------

/**
 * Ansible environment suppression — matches the bash exports in get-information.sh.
 * Used for all ansible-playbook invocations.
 */
const ANSIBLE_QUIET_ENV: NodeJS.ProcessEnv = {
  ANSIBLE_LOCALHOST_WARNING: 'False',
  ANSIBLE_INVENTORY_UNPARSED_WARNING: 'False',
  ANSIBLE_DEPRECATION_WARNINGS: 'False',
};

/**
 * Run an ansible-playbook command, inheriting stdio (output visible to user).
 *
 * Matches the bash pattern:
 *   ansible-playbook -e "key=val" ... -i inventory playbook.yml
 *
 * @param playbook  - Absolute path to the .ansible.yml playbook file
 * @param vars      - Extra vars passed as -e key=value (matched to bash -e flags)
 * @param inventory - Optional path to inventory file (passed as -i flag)
 * @param env       - Additional env vars (for lookup('env', ...) in playbooks)
 */
export async function runPlaybook(
  playbook: string,
  vars: Record<string, string> = {},
  inventory?: string,
  env: NodeJS.ProcessEnv = {}
): Promise<void> {
  // Build args in same order as bash: extra vars, then inventory, then playbook
  const args: string[] = [...buildExtraVars(vars)];

  if (inventory) {
    args.push('-i', inventory);
  }

  args.push(playbook);

  await execa('ansible-playbook', args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...ANSIBLE_QUIET_ENV,
      ...env,
    },
  });
}

// ---------------------------------------------------------------------------
// Hosts file parsing
// ---------------------------------------------------------------------------

/**
 * Parse a YAML Ansible inventory file and return a typed structure.
 *
 * Used to extract node IPs, users, and SSH keys without calling `yq`.
 * Matches the bash `yq eval -o=j $ANSIBLE_HOSTS_FILE | jq -cr '.nodes.hosts[]'` pattern.
 *
 * @param hostsFile - Absolute path to the hosts.ansible.yml file
 */
export async function parseHosts(hostsFile: string): Promise<AnsibleHosts> {
  let raw: string;
  try {
    raw = fs.readFileSync(hostsFile, 'utf-8');
  } catch (err) {
    throw new Error(
      `Cannot read Ansible hosts file at "${hostsFile}": ${(err as Error).message}`
    );
  }

  const parsed = yaml.load(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid YAML in Ansible hosts file: "${hostsFile}"`);
  }

  return parsed as AnsibleHosts;
}

// ---------------------------------------------------------------------------
// Host file validators
// ---------------------------------------------------------------------------

const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * Validate that all nodes in the hosts file have valid IPs and SSH keys in the agent.
 *
 * Matches check_nodes_host_file() in scripts/utils/validations.sh.
 *
 * @param hostsFile - Absolute path to the Ansible hosts file
 */
export async function checkNodesHostFile(hostsFile: string): Promise<void> {
  const hosts = await parseHosts(hostsFile);
  const nodeHosts = hosts.nodes?.hosts;

  if (!nodeHosts || Object.keys(nodeHosts).length === 0) {
    throw new Error(
      `No nodes found in Ansible hosts file "${hostsFile}". ` +
        'Please configure node IPs and SSH keys.'
    );
  }

  for (const [nodeName, nodeInfo] of Object.entries(nodeHosts)) {
    const ip = nodeInfo.ansible_host;
    if (!ip || !IPV4_REGEX.test(String(ip))) {
      throw new Error(
        `Node "${nodeName}" has an invalid or missing ansible_host IP: ${ip ?? '(empty)'}.\n` +
          `Edit ${hostsFile} and set a valid IPv4 address.`
      );
    }

    const keyFile = nodeInfo.ansible_ssh_private_key_file;
    if (!keyFile) {
      throw new Error(
        `Node "${nodeName}" has no ansible_ssh_private_key_file specified in ${hostsFile}.`
      );
    }

    await checkSshKeyInAgent(String(keyFile), nodeName);
  }
}

/**
 * Validate that the monitoring host in the hosts file has a valid IP and SSH key in the agent.
 *
 * Matches check_monitoring_host_file() in scripts/utils/validations.sh.
 *
 * @param hostsFile - Absolute path to the Ansible hosts file
 */
export async function checkMonitoringHostFile(hostsFile: string): Promise<void> {
  const hosts = await parseHosts(hostsFile);
  const monitoringHosts = hosts.monitoring?.hosts;

  if (!monitoringHosts || Object.keys(monitoringHosts).length === 0) {
    throw new Error(
      `No monitoring hosts found in Ansible hosts file "${hostsFile}". ` +
        'Please configure the monitoring host IP and SSH key.'
    );
  }

  for (const [hostName, hostInfo] of Object.entries(monitoringHosts)) {
    const ip = hostInfo.ansible_host;
    if (!ip || !IPV4_REGEX.test(String(ip))) {
      throw new Error(
        `Monitoring host "${hostName}" has an invalid or missing ansible_host IP: ${ip ?? '(empty)'}.\n` +
          `Edit ${hostsFile} and set a valid IPv4 address.`
      );
    }

    const keyFile = hostInfo.ansible_ssh_private_key_file;
    if (!keyFile) {
      throw new Error(
        `Monitoring host "${hostName}" has no ansible_ssh_private_key_file specified in ${hostsFile}.`
      );
    }

    await checkSshKeyInAgent(String(keyFile), hostName);
  }
}

/**
 * Verify that an SSH private key is loaded in the SSH agent.
 *
 * Matches the ssh-keygen + ssh-add -l check in check_nodes_host_file() /
 * check_monitoring_host_file() in scripts/utils/validations.sh.
 *
 * @param keyFile  - Path to the SSH private key file
 * @param hostName - Human-readable host label for error messages
 */
async function checkSshKeyInAgent(keyFile: string, hostName: string): Promise<void> {
  // Get the key fingerprint
  const keyScanResult = await execa('ssh-keygen', ['-lf', keyFile], { reject: false });

  if (keyScanResult.exitCode !== 0) {
    throw new Error(
      `Cannot read SSH key "${keyFile}" for host "${hostName}".\n` +
        `Check that the file exists and is a valid SSH private key.`
    );
  }

  // Format: "2048 SHA256:xxxx comment (RSA)" — extract the SHA256 fingerprint
  const fingerprint = keyScanResult.stdout.trim().split(/\s+/)[1];
  if (!fingerprint) {
    throw new Error(
      `Cannot extract fingerprint from SSH key "${keyFile}" for host "${hostName}".`
    );
  }

  // Check the SSH agent
  const agentResult = await execa('ssh-add', ['-l'], { reject: false });

  if (agentResult.exitCode === 2) {
    throw new Error(
      'SSH agent is not running.\n' +
        'Start it with: eval "$(ssh-agent -s)"\n' +
        `Then load your key: ssh-add ${keyFile}`
    );
  }

  if (!agentResult.stdout.includes(fingerprint)) {
    throw new Error(
      `SSH key for "${hostName}" (${keyFile}) is not loaded in the SSH agent.\n` +
        `Run: ssh-add ${keyFile}`
    );
  }
}

// ---------------------------------------------------------------------------
// Second signer helper
// ---------------------------------------------------------------------------

/**
 * Find the first node whose p12 key file differs from the given filename.
 *
 * Used to find the "second signer" for snapshot fee signing messages.
 * Matches get_additonal_file_info_to_sign_message() in scripts/utils/get-information.sh:
 *
 *   first_different_key_file=$(echo "$NODES" | jq -r --arg ext_name "$1" '
 *     .[] | select(.key_file.name != $ext_name) | .key_file | @json' | head -n 1)
 *
 * @param nodes           - Array of node definitions from euclid.json
 * @param excludeFileName - P12 filename to exclude (owner or staking file)
 * @returns The key_file object of the first node with a different filename
 */
export function getSecondSignerInfo(
  nodes: Array<{ key_file: { name: string; alias: string; password: string } }>,
  excludeFileName: string
): { name: string; alias: string; password: string } {
  const node = nodes.find((n) => n.key_file.name !== excludeFileName);

  if (!node) {
    throw new Error(
      `Could not find second signer p12 file. ` +
        `All nodes use the same key file as "${excludeFileName}". ` +
        `Ensure nodes have distinct p12 files.`
    );
  }

  return node.key_file;
}
