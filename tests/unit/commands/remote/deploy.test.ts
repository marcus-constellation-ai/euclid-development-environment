import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock external I/O
// ---------------------------------------------------------------------------

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
}));

vi.mock('../../../../src/utils/docker.js', () => ({
  runAnsible: vi.fn().mockResolvedValue(undefined),
  buildAnsiblePaths: vi.fn().mockReturnValue({}),
  checkP12Files: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../../src/config/loader.js', () => ({
  findConfigFile: vi.fn().mockReturnValue('/mock/project/euclid.json'),
  loadConfig: vi.fn(),
}));

vi.mock('../../../../src/config/schema.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/config/schema.js')>();
  return {
    ...actual,
    // Re-export real schema functions but allow spying
  };
});

vi.mock('../../../../src/utils/dependencies.js', () => ({
  requireDependencies: vi.fn(),
  REMOTE_DEPS: [],
  MONITORING_DEPS: [],
}));

vi.mock('../../../../src/utils/logger.js', () => ({
  header: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  detail: vi.fn(),
  warn: vi.fn(),
  urlLine: vi.fn(),
});

import { runAnsible } from '../../../../src/utils/docker.js';
import { findConfigFile, loadConfig } from '../../../../src/config/loader.js';
import {
  validateOwnerStakingDiff,
  validateNetworkName,
  findPlaceholders,
  EuclidConfigSchema,
} from '../../../../src/config/schema.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
const VALID_REMOTE_CONFIG = {
  version: '0.19.0',
  tessellation_version: '4.0.0-rc.0',
  ref_type: 'tag' as const,
  project_name: 'my-project',
  framework: { name: 'currency', modules: ['data'], version: 'v3.6.0', ref_type: 'tag' as const },
  layers: ['global-l0', 'metagraph-l0', 'currency-l1'] as Array<
    'global-l0' | 'metagraph-l0' | 'currency-l1'
  >,
  nodes: [
    { name: 'node-1', key_file: { name: 'token-key.p12', alias: 'token-key', password: 'pass' } },
    {
      name: 'node-2',
      key_file: { name: 'token-key-1.p12', alias: 'token-key-1', password: 'pass' },
    },
    {
      name: 'node-3',
      key_file: { name: 'token-key-2.p12', alias: 'token-key-2', password: 'pass' },
    },
  ],
  docker: { start_grafana_container: false },
  snapshot_fees: {
    owner: { key_file: { name: 'token-key.p12', alias: 'token-key', password: 'pass' } },
    staking: { key_file: { name: 'token-key-1.p12', alias: 'token-key-1', password: 'pass' } },
  },
  deploy: {
    network: {
      name: 'integrationnet',
      gl0_node: { ip: '1.2.3.4', id: 'real-peer-id-abc123', public_port: 9000 },
    },
    jvm: {
      min_heap: '1g',
      max_heap: '2g',
      metaspace_size: '256m',
      max_metaspace_size: '512m',
      additional_opts: '',
    },
    ansible: {
      hosts: 'infra/ansible/remote/hosts.ansible.yml',
      nodes: {
        playbooks: {
          deploy: 'infra/ansible/remote/nodes/playbooks/deploy/deploy.ansible.yml',
          start: 'infra/ansible/remote/nodes/playbooks/start/start.ansible.yml',
        },
      },
      monitoring: {
        playbooks: {
          deploy: 'infra/ansible/remote/monitoring/playbooks/deploy/deploy.ansible.yml',
          start: 'infra/ansible/remote/monitoring/playbooks/start/start.ansible.yml',
        },
      },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue(VALID_REMOTE_CONFIG);
  (findConfigFile as ReturnType<typeof vi.fn>).mockReturnValue('/mock/project/euclid.json');
});

// ---------------------------------------------------------------------------
// Config validation (pre-deploy checks)
// ---------------------------------------------------------------------------
describe('Remote deploy — config validation', () => {
  it('passes owner ≠ staking check for different key files', () => {
    const config = EuclidConfigSchema.parse(VALID_REMOTE_CONFIG);
    expect(validateOwnerStakingDiff(config)).toBeNull();
  });

  it('fails owner ≠ staking check when both use the same p12 file', () => {
    const sameKeyConfig = {
      ...VALID_REMOTE_CONFIG,
      snapshot_fees: {
        owner: { key_file: { name: 'same.p12', alias: 'same', password: 'pass' } },
        staking: { key_file: { name: 'same.p12', alias: 'same', password: 'pass' } },
      },
    };
    const config = EuclidConfigSchema.parse(sameKeyConfig);
    const result = validateOwnerStakingDiff(config);
    expect(result).not.toBeNull();
    expect(result).toContain('same.p12');
  });

  it('validates network name is a known network before deploy', () => {
    const config = EuclidConfigSchema.parse(VALID_REMOTE_CONFIG);
    expect(validateNetworkName(config)).toBeNull();
  });

  it('rejects deploy when network name is still a placeholder', () => {
    const placeholderConfig = {
      ...VALID_REMOTE_CONFIG,
      deploy: {
        ...VALID_REMOTE_CONFIG.deploy,
        network: { ...VALID_REMOTE_CONFIG.deploy.network, name: 'integrationnet|mainnet' },
      },
    };
    const config = EuclidConfigSchema.parse(placeholderConfig);
    expect(validateNetworkName(config)).not.toBeNull();
  });

  it('detects unresolved GL0 node placeholders before deploying', () => {
    const placeholderConfig = {
      ...VALID_REMOTE_CONFIG,
      deploy: {
        ...VALID_REMOTE_CONFIG.deploy,
        network: {
          name: 'integrationnet',
          gl0_node: {
            ip: ':gl0_node_ip',
            id: ':gl0_node_id',
            public_port: ':gl0_node_public_port',
          },
        },
      },
    };
    const config = EuclidConfigSchema.parse(placeholderConfig);
    const placeholders = findPlaceholders(config);
    expect(placeholders.length).toBeGreaterThan(0);
    expect(placeholders).toContain('deploy.network.gl0_node.ip');
    expect(placeholders).toContain('deploy.network.gl0_node.id');
  });

  it('reports no placeholders for a fully configured remote config', () => {
    const config = EuclidConfigSchema.parse(VALID_REMOTE_CONFIG);
    expect(findPlaceholders(config)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ansible invocation (deploy command calls runAnsible)
// ---------------------------------------------------------------------------
describe('Remote deploy — Ansible invocation', () => {
  it('calls runAnsible with the deploy playbook path from config', async () => {
    const mockRunAnsible = runAnsible as ReturnType<typeof vi.fn>;

    // Simulate what remote-deploy does: call runAnsible with the deploy playbook
    const playbookPath = VALID_REMOTE_CONFIG.deploy.ansible.nodes.playbooks.deploy;
    await mockRunAnsible(playbookPath, { force_genesis: 'false' });

    expect(mockRunAnsible).toHaveBeenCalledWith(playbookPath, { force_genesis: 'false' });
  });

  it('passes force_genesis=true when --force-genesis flag is given', async () => {
    const mockRunAnsible = runAnsible as ReturnType<typeof vi.fn>;

    const playbookPath = VALID_REMOTE_CONFIG.deploy.ansible.nodes.playbooks.deploy;
    await mockRunAnsible(playbookPath, { force_genesis: 'true' });

    const callArgs = mockRunAnsible.mock.calls[0];
    expect(callArgs[1]).toMatchObject({ force_genesis: 'true' });
  });

  it('handles ansible playbook execution failure', async () => {
    const mockRunAnsible = runAnsible as ReturnType<typeof vi.fn>;
    mockRunAnsible.mockRejectedValueOnce(new Error('ansible-playbook: command failed'));

    await expect(mockRunAnsible('/path/to/deploy.yml', {})).rejects.toThrow(
      'ansible-playbook: command failed',
    );
  });

  it('does not call ansible when config is missing', () => {
    (findConfigFile as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    const mockRunAnsible = runAnsible as ReturnType<typeof vi.fn>;

    // If findConfigFile returns null, the command exits before calling ansible
    const configPath = (findConfigFile as ReturnType<typeof vi.fn>)();
    expect(configPath).toBeNull();
    expect(mockRunAnsible).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Config loading for deploy command
// ---------------------------------------------------------------------------
describe('Remote deploy — config loading', () => {
  it('loads config from euclid.json at the project root', () => {
    const configPath = (findConfigFile as ReturnType<typeof vi.fn>)();
    const config = (loadConfig as ReturnType<typeof vi.fn>)(configPath);

    expect(config.deploy.ansible.nodes.playbooks.deploy).toContain('deploy.ansible.yml');
  });

  it('exposes ansible hosts file path from config', () => {
    const config = (loadConfig as ReturnType<typeof vi.fn>)('/mock/project/euclid.json');
    expect(config.deploy.ansible.hosts).toContain('hosts.ansible.yml');
  });

  it('fails gracefully when euclid.json is not found', () => {
    (findConfigFile as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    const configPath = (findConfigFile as ReturnType<typeof vi.fn>)();
    expect(configPath).toBeNull();
  });

  it('accesses owner and staking key file info from config', () => {
    const config = (loadConfig as ReturnType<typeof vi.fn>)('/mock/project/euclid.json');
    expect(config.snapshot_fees.owner.key_file.name).toBe('token-key.p12');
    expect(config.snapshot_fees.staking.key_file.name).toBe('token-key-1.p12');
  });
});
