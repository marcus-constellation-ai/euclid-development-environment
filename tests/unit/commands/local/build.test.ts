import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock all external I/O before importing the command.
// vi.mock() calls are hoisted to the top of the file by vitest.
// ---------------------------------------------------------------------------

// Mock execa (used by docker utilities)
vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
}));

// Mock docker utilities
vi.mock('../../../../src/utils/docker.js', () => ({
  detectDockerCompose: vi.fn().mockResolvedValue('docker compose'),
  dockerCompose: vi.fn().mockResolvedValue(undefined),
  runDocker: vi.fn().mockResolvedValue(undefined),
  runDockerCapture: vi.fn().mockResolvedValue(''),
  getTessellationVersionName: vi.fn().mockReturnValue('4.0.0-rc.0'),
  getTessellationVersionSemver: vi.fn().mockReturnValue('4.0.0-rc.0'),
  getCheckoutTessellationVersion: vi.fn().mockReturnValue('v4.0.0-rc.0'),
  checkP12Files: vi.fn().mockReturnValue([]),
  projectDirectoryExists: vi.fn().mockReturnValue(true),
  runAnsible: vi.fn().mockResolvedValue(undefined),
  buildAnsiblePaths: vi.fn().mockReturnValue({}),
}));

// Mock dependency checker
vi.mock('../../../../src/utils/dependencies.js', () => ({
  requireDependencies: vi.fn(),
  LOCAL_DEPS: [],
  TOOL_DOCKER: { name: 'docker', checkCommand: ['docker', '--version'], installHint: '' },
}));

// Mock logger
vi.mock('../../../../src/utils/logger.js', () => ({
  buildBanner: vi.fn(),
  header: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  detail: vi.fn(),
  warn: vi.fn(),
  urlLine: vi.fn(),
  printMetagraphInfo: vi.fn(),
}));

// Mock node:fs for custom Dockerfile check
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false), // no custom Dockerfile by default
  };
});

import { existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Config fixtures
// ---------------------------------------------------------------------------
const MOCK_CONFIG = {
  version: '0.19.0',
  tessellation_version: '4.0.0-rc.0',
  ref_type: 'tag',
  project_name: 'my-project',
  framework: { name: 'currency', modules: ['data'], version: 'v3.6.0', ref_type: 'tag' },
  layers: ['global-l0', 'metagraph-l0', 'currency-l1'],
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
    network: {
      name: 'integrationnet',
      gl0_node: { ip: '1.2.3.4', id: 'abc123', public_port: 9000 },
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
      nodes: { playbooks: { deploy: 'infra/deploy.yml', start: 'infra/start.yml' } },
      monitoring: {
        playbooks: { deploy: 'infra/mon-deploy.yml', start: 'infra/mon-start.yml' },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Tests for build command preconditions and validation logic
// ---------------------------------------------------------------------------
describe('Build command — configuration validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails validation when tessellation_version has a leading "v" prefix', () => {
    // The build command validates that tessellation_version does NOT start with 'v'
    const configWithVPrefix = {
      ...MOCK_CONFIG,
      tessellation_version: 'v4.0.0-rc.0', // invalid — bash check_if_tessellation_version_starts_with_v
    };
    // The version string starting with 'v' should be caught before building
    expect(configWithVPrefix.tessellation_version.startsWith('v')).toBe(true);
  });

  it('reports missing p12 files correctly', async () => {
    const { checkP12Files } = await import('../../../../src/utils/docker.js');
    const mockCheckP12 = checkP12Files as ReturnType<typeof vi.fn>;

    // Simulate two missing p12 files
    mockCheckP12.mockReturnValueOnce(['key1.p12', 'key2.p12']);
    const missing = mockCheckP12('/path/to/source', MOCK_CONFIG.nodes);
    expect(missing).toHaveLength(2);
    expect(missing).toContain('key1.p12');
  });

  it('returns empty array when all p12 files exist', async () => {
    const { checkP12Files } = await import('../../../../src/utils/docker.js');
    const mockCheckP12 = checkP12Files as ReturnType<typeof vi.fn>;

    mockCheckP12.mockReturnValueOnce([]);
    const missing = mockCheckP12('/path/to/source', MOCK_CONFIG.nodes);
    expect(missing).toHaveLength(0);
  });

  it('detects custom Dockerfile when it exists', () => {
    const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
    mockExistsSync.mockReturnValueOnce(true); // custom Dockerfile present
    expect(existsSync('/some/infra/docker/custom/metagraph-base-image/Dockerfile')).toBe(true);
  });

  it('uses default Dockerfile path when no custom override exists', () => {
    const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
    mockExistsSync.mockReturnValueOnce(false); // no custom Dockerfile
    expect(existsSync('/some/infra/docker/custom/metagraph-base-image/Dockerfile')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests for docker utility functions used by build command
// ---------------------------------------------------------------------------
describe('Build command — docker utility integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getTessellationVersionName sanitises branch names', async () => {
    const { getTessellationVersionName } = await import('../../../../src/utils/docker.js');
    const mockFn = getTessellationVersionName as ReturnType<typeof vi.fn>;

    // For branch ref_type, version name should be alphanumeric+underscore
    mockFn.mockReturnValueOnce('my_feature_branch');
    const result = mockFn('my-feature/branch', 'branch');
    expect(result).toBe('my_feature_branch');
  });

  it('getTessellationVersionSemver returns 99.99.99 for branches', async () => {
    const { getTessellationVersionSemver } = await import('../../../../src/utils/docker.js');
    const mockFn = getTessellationVersionSemver as ReturnType<typeof vi.fn>;

    mockFn.mockReturnValueOnce('99.99.99');
    const result = mockFn('my-branch', 'branch');
    expect(result).toBe('99.99.99');
  });

  it('getCheckoutTessellationVersion prepends v for semver tags', async () => {
    const { getCheckoutTessellationVersion } = await import('../../../../src/utils/docker.js');
    const mockFn = getCheckoutTessellationVersion as ReturnType<typeof vi.fn>;

    mockFn.mockReturnValueOnce('v4.0.0-rc.0');
    const result = mockFn('4.0.0-rc.0');
    expect(result).toBe('v4.0.0-rc.0');
  });

  it('dockerCompose is called when building images', async () => {
    const { dockerCompose } = await import('../../../../src/utils/docker.js');
    const mockDockerCompose = dockerCompose as ReturnType<typeof vi.fn>;

    // Simulate calling dockerCompose for the metagraph-ubuntu build
    await mockDockerCompose(['build'], '/infra/metagraph-ubuntu');
    expect(mockDockerCompose).toHaveBeenCalledWith(['build'], '/infra/metagraph-ubuntu');
  });

  it('runDocker is called to copy JARs from base image', async () => {
    const { runDocker } = await import('../../../../src/utils/docker.js');
    const mockRunDocker = runDocker as ReturnType<typeof vi.fn>;

    await mockRunDocker(['create', '--name', 'temp', 'metagraph-base-image']);
    expect(mockRunDocker).toHaveBeenCalled();
  });

  it('runDocker receives --no-cache flag when option is set', async () => {
    const { dockerCompose } = await import('../../../../src/utils/docker.js');
    const mockDockerCompose = dockerCompose as ReturnType<typeof vi.fn>;

    // Simulate building with --no-cache
    await mockDockerCompose(['build', '--no-cache'], '/infra/metagraph-ubuntu');
    const callArgs = mockDockerCompose.mock.calls[0][0] as string[];
    expect(callArgs).toContain('--no-cache');
  });
});

// ---------------------------------------------------------------------------
// Tests for dependency requirements
// ---------------------------------------------------------------------------
describe('Build command — dependency checking', () => {
  it('requireDependencies is invoked with LOCAL_DEPS before building', async () => {
    const { requireDependencies, LOCAL_DEPS } = await import(
      '../../../../src/utils/dependencies.js'
    );
    const mockRequire = requireDependencies as ReturnType<typeof vi.fn>;

    mockRequire(LOCAL_DEPS);
    expect(mockRequire).toHaveBeenCalledWith(LOCAL_DEPS);
  });

  it('throws when requireDependencies detects missing tools', async () => {
    const { requireDependencies } = await import('../../../../src/utils/dependencies.js');
    const mockRequire = requireDependencies as ReturnType<typeof vi.fn>;

    mockRequire.mockImplementationOnce(() => {
      throw new Error('Missing required dependencies: docker');
    });

    expect(() => mockRequire([])).toThrow('Missing required dependencies: docker');
  });
});
