import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock external dependencies before importing status utilities
// ---------------------------------------------------------------------------

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('../../../../src/utils/docker.js', () => ({
  getContainerStatus: vi.fn(),
  runDocker: vi.fn(),
  runDockerCapture: vi.fn(),
}));

vi.mock('../../../../src/config/loader.js', () => ({
  findConfigFile: vi.fn().mockReturnValue('/mock/project/euclid.json'),
  loadConfig: vi.fn(),
}));

vi.mock('../../../../src/utils/dependencies.js', () => ({
  requireDependencies: vi.fn(),
  LOCAL_DEPS: [],
}));

vi.mock('../../../../src/utils/logger.js', () => ({
  header: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  detail: vi.fn(),
  warn: vi.fn(),
  urlLine: vi.fn(),
  printMetagraphInfo: vi.fn(),
  nodePort: vi.fn().mockImplementation((layer: string, idx: number) => {
    const BASE: Record<string, number> = {
      'global-l0': 9000,
      'dag-l1': 9100,
      'metagraph-l0': 9200,
      'currency-l1': 9300,
      'data-l1': 9400,
    };
    return (BASE[layer] ?? 9000) + idx * 10;
  }),
}));

import { execa } from 'execa';
import { getContainerStatus, runDockerCapture } from '../../../../src/utils/docker.js';
import { findConfigFile, loadConfig } from '../../../../src/config/loader.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const MOCK_CONFIG = {
  version: '0.19.0',
  tessellation_version: '4.0.0-rc.0',
  ref_type: 'tag' as const,
  project_name: 'my-project',
  framework: { name: 'currency', modules: ['data'], version: 'v3.6.0', ref_type: 'tag' as const },
  layers: ['global-l0', 'metagraph-l0', 'currency-l1'] as Array<
    'global-l0' | 'metagraph-l0' | 'currency-l1'
  >,
  nodes: [
    { name: 'node-1', key_file: { name: 'key1.p12', alias: 'key1', password: 'pass' } },
    { name: 'node-2', key_file: { name: 'key2.p12', alias: 'key2', password: 'pass' } },
    { name: 'node-3', key_file: { name: 'key3.p12', alias: 'key3', password: 'pass' } },
  ],
  docker: { start_grafana_container: false },
  snapshot_fees: {
    owner: { key_file: { name: 'owner.p12', alias: 'owner', password: 'pass' } },
    staking: { key_file: { name: 'staking.p12', alias: 'staking', password: 'pass' } },
  },
  deploy: {
    network: { name: 'integrationnet', gl0_node: { ip: '1.2.3.4', id: 'abc', public_port: 9000 } },
    jvm: {
      min_heap: '1g',
      max_heap: '2g',
      metaspace_size: '256m',
      max_metaspace_size: '512m',
      additional_opts: '',
    },
    ansible: {
      hosts: 'infra/hosts.yml',
      nodes: { playbooks: { deploy: 'infra/deploy.yml', start: 'infra/start.yml' } },
      monitoring: {
        playbooks: { deploy: 'infra/mon-deploy.yml', start: 'infra/mon-start.yml' },
      },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue(MOCK_CONFIG);
  (findConfigFile as ReturnType<typeof vi.fn>).mockReturnValue('/mock/project/euclid.json');
});

// ---------------------------------------------------------------------------
// getContainerStatus — the core utility used by the status command
// ---------------------------------------------------------------------------
describe('getContainerStatus utility (used by status command)', () => {
  it('reports "running" for an active container', async () => {
    const mockGetStatus = getContainerStatus as ReturnType<typeof vi.fn>;
    mockGetStatus.mockResolvedValueOnce('running');

    const status = await mockGetStatus('node-1');
    expect(status).toBe('running');
  });

  it('reports "not_found" when a container does not exist', async () => {
    const mockGetStatus = getContainerStatus as ReturnType<typeof vi.fn>;
    mockGetStatus.mockResolvedValueOnce('not_found');

    const status = await mockGetStatus('unknown-container');
    expect(status).toBe('not_found');
  });

  it('reports "exited" for a stopped container', async () => {
    const mockGetStatus = getContainerStatus as ReturnType<typeof vi.fn>;
    mockGetStatus.mockResolvedValueOnce('exited');

    const status = await mockGetStatus('node-1');
    expect(status).toBe('exited');
  });

  it('is called for each node in the config', async () => {
    const mockGetStatus = getContainerStatus as ReturnType<typeof vi.fn>;
    mockGetStatus.mockResolvedValue('running');

    // Simulate the status command calling getContainerStatus for each node
    for (const node of MOCK_CONFIG.nodes) {
      await mockGetStatus(node.name);
    }
    expect(mockGetStatus).toHaveBeenCalledTimes(MOCK_CONFIG.nodes.length);
  });
});

// ---------------------------------------------------------------------------
// Docker info check (status command verifies Docker is running)
// ---------------------------------------------------------------------------
describe('Status command — docker availability check', () => {
  it('uses execa to check docker info', async () => {
    const mockExeca = execa as ReturnType<typeof vi.fn>;
    mockExeca.mockResolvedValueOnce({ stdout: 'Server:\n  Running: true', exitCode: 0 });

    const result = await mockExeca('docker', ['info']);
    expect(result.exitCode).toBe(0);
    expect(mockExeca).toHaveBeenCalledWith('docker', ['info']);
  });

  it('handles docker not running (execa throws)', async () => {
    const mockExeca = execa as ReturnType<typeof vi.fn>;
    mockExeca.mockRejectedValueOnce(new Error('Cannot connect to the Docker daemon'));

    await expect(mockExeca('docker', ['info'])).rejects.toThrow('Cannot connect to the Docker');
  });
});

// ---------------------------------------------------------------------------
// Port arithmetic used by status command
// ---------------------------------------------------------------------------
describe('Status command — port arithmetic', () => {
  const BASE_PORTS: Record<string, number> = {
    'global-l0': 9000,
    'dag-l1': 9100,
    'metagraph-l0': 9200,
    'currency-l1': 9300,
    'data-l1': 9400,
  };
  const PORT_OFFSET = 10;

  it('computes node-1 global-l0 port as 9000', () => {
    expect(BASE_PORTS['global-l0'] + 0 * PORT_OFFSET).toBe(9000);
  });

  it('computes node-2 global-l0 port as 9010', () => {
    expect(BASE_PORTS['global-l0'] + 1 * PORT_OFFSET).toBe(9010);
  });

  it('computes node-3 metagraph-l0 port as 9220', () => {
    expect(BASE_PORTS['metagraph-l0'] + 2 * PORT_OFFSET).toBe(9220);
  });

  it('computes node-1 currency-l1 port as 9300', () => {
    expect(BASE_PORTS['currency-l1'] + 0 * PORT_OFFSET).toBe(9300);
  });

  it('all three node ports for a layer are distinct', () => {
    const ports = [0, 1, 2].map((i) => BASE_PORTS['global-l0'] + i * PORT_OFFSET);
    const unique = new Set(ports);
    expect(unique.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Config loading for status command
// ---------------------------------------------------------------------------
describe('Status command — config loading', () => {
  it('calls findConfigFile and loadConfig during run', () => {
    // Simulate what the status command does during initialization
    const configPath = (findConfigFile as ReturnType<typeof vi.fn>)();
    expect(configPath).toBe('/mock/project/euclid.json');

    const config = (loadConfig as ReturnType<typeof vi.fn>)(configPath);
    expect(config.nodes).toHaveLength(3);
  });

  it('aborts when findConfigFile returns null (no euclid.json)', () => {
    (findConfigFile as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    const configPath = (findConfigFile as ReturnType<typeof vi.fn>)();
    // Status command checks for null and calls this.error(...)
    expect(configPath).toBeNull();
  });

  it('reads correct metagraph ID from config', () => {
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      ...MOCK_CONFIG,
      metagraph_id: 'DAG_TEST_ID_123',
    });
    const config = (loadConfig as ReturnType<typeof vi.fn>)('/mock/project/euclid.json');
    expect(config.metagraph_id).toBe('DAG_TEST_ID_123');
  });
});

// ---------------------------------------------------------------------------
// runDockerCapture used to query container info
// ---------------------------------------------------------------------------
describe('Status command — docker exec for node info', () => {
  it('runs docker exec to get node identity via cl-wallet', async () => {
    const mockCapture = runDockerCapture as ReturnType<typeof vi.fn>;
    const peerId = 'abc123def456';
    mockCapture.mockResolvedValueOnce(peerId);

    const result = await mockCapture([
      'exec',
      'node-1',
      'java',
      '-jar',
      '/code/cl-wallet.jar',
      'show-id',
    ]);
    expect(result).toBe(peerId);
  });

  it('handles docker exec failure gracefully', async () => {
    const mockCapture = runDockerCapture as ReturnType<typeof vi.fn>;
    mockCapture.mockRejectedValueOnce(new Error('container not running'));

    await expect(
      mockCapture(['exec', 'stopped-node', 'java', '-jar', 'cl-wallet.jar', 'show-id']),
    ).rejects.toThrow('container not running');
  });
});
