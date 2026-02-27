import { describe, it, expect } from 'vitest';
import {
  EuclidConfigSchema,
  KeyFileSchema,
  LayerEnum,
  FrameworkSchema,
  NodeSchema,
  validateOwnerStakingDiff,
  validateNetworkName,
  findPlaceholders,
  coercePublicPort,
} from '../../../src/config/schema.js';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------
const BASE_CONFIG = {
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
// EuclidConfigSchema
// ---------------------------------------------------------------------------
describe('EuclidConfigSchema', () => {
  it('parses a complete valid config successfully', () => {
    const result = EuclidConfigSchema.safeParse(BASE_CONFIG);
    expect(result.success).toBe(true);
  });

  it('fails when required top-level fields are missing', () => {
    const result = EuclidConfigSchema.safeParse({ version: '0.19.0' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => String(i.path[0]));
      expect(paths).toContain('tessellation_version');
      expect(paths).toContain('nodes');
    }
  });

  it('fails when ref_type is not "tag" or "branch"', () => {
    const result = EuclidConfigSchema.safeParse({ ...BASE_CONFIG, ref_type: 'commit' });
    expect(result.success).toBe(false);
  });

  it('fails when nodes array has fewer than 3 entries', () => {
    const result = EuclidConfigSchema.safeParse({
      ...BASE_CONFIG,
      nodes: [BASE_CONFIG.nodes[0], BASE_CONFIG.nodes[1]],
    });
    expect(result.success).toBe(false);
  });

  it('fails when layers array is empty', () => {
    const result = EuclidConfigSchema.safeParse({ ...BASE_CONFIG, layers: [] });
    expect(result.success).toBe(false);
  });

  it('fails when an unrecognised layer name is used', () => {
    const result = EuclidConfigSchema.safeParse({
      ...BASE_CONFIG,
      layers: ['global-l0', 'unknown-layer'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts metagraph_id as optional — passes both with and without it', () => {
    expect(EuclidConfigSchema.safeParse({ ...BASE_CONFIG, metagraph_id: 'DAG1' }).success).toBe(
      true,
    );
    expect(EuclidConfigSchema.safeParse(BASE_CONFIG).success).toBe(true);
  });

  it('accepts placeholder strings for gl0_node fields (template compatibility)', () => {
    const withPlaceholders = {
      ...BASE_CONFIG,
      deploy: {
        ...BASE_CONFIG.deploy,
        network: {
          name: 'integrationnet|mainnet',
          gl0_node: {
            ip: ':gl0_node_ip',
            id: ':gl0_node_id',
            public_port: ':gl0_node_public_port',
          },
        },
      },
    };
    const result = EuclidConfigSchema.safeParse(withPlaceholders);
    expect(result.success).toBe(true);
  });

  it('accepts nodes array with more than 3 entries', () => {
    const result = EuclidConfigSchema.safeParse({
      ...BASE_CONFIG,
      nodes: [
        ...BASE_CONFIG.nodes,
        { name: 'node-4', key_file: { name: 'key4.p12', alias: 'key4', password: 'pass' } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('allows "branch" as a valid ref_type', () => {
    const result = EuclidConfigSchema.safeParse({ ...BASE_CONFIG, ref_type: 'branch' });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LayerEnum
// ---------------------------------------------------------------------------
describe('LayerEnum', () => {
  const valid = [
    'global-l0',
    'dag-l1',
    'metagraph-l0',
    'currency-l1',
    'data-l1',
    'metagraph-l1-currency',
    'metagraph-l1-data',
  ];

  it.each(valid)('accepts valid layer "%s"', (layer) => {
    expect(LayerEnum.safeParse(layer).success).toBe(true);
  });

  it('rejects unrecognised layer names', () => {
    expect(LayerEnum.safeParse('global-l1').success).toBe(false);
    expect(LayerEnum.safeParse('').success).toBe(false);
    expect(LayerEnum.safeParse('metagraph').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// KeyFileSchema
// ---------------------------------------------------------------------------
describe('KeyFileSchema', () => {
  it('parses a valid key file object', () => {
    const result = KeyFileSchema.safeParse({
      name: 'token-key.p12',
      alias: 'token-key',
      password: 'secret',
    });
    expect(result.success).toBe(true);
  });

  it('fails when name is an empty string', () => {
    expect(
      KeyFileSchema.safeParse({ name: '', alias: 'token-key', password: 'pass' }).success,
    ).toBe(false);
  });

  it('fails when alias is an empty string', () => {
    expect(
      KeyFileSchema.safeParse({ name: 'token-key.p12', alias: '', password: 'pass' }).success,
    ).toBe(false);
  });

  it('allows empty password (users may have no password)', () => {
    expect(
      KeyFileSchema.safeParse({ name: 'key.p12', alias: 'key', password: '' }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FrameworkSchema
// ---------------------------------------------------------------------------
describe('FrameworkSchema', () => {
  it('parses a valid framework config', () => {
    const result = FrameworkSchema.safeParse({
      name: 'currency',
      modules: ['data'],
      version: 'v3.6.0',
      ref_type: 'tag',
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty modules array', () => {
    const result = FrameworkSchema.safeParse({
      name: 'currency',
      modules: [],
      version: 'v3.6.0',
      ref_type: 'tag',
    });
    expect(result.success).toBe(true);
  });

  it('fails when ref_type is not "tag" or "branch"', () => {
    const result = FrameworkSchema.safeParse({
      name: 'currency',
      modules: [],
      version: 'v3.6.0',
      ref_type: 'latest',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NodeSchema
// ---------------------------------------------------------------------------
describe('NodeSchema', () => {
  it('parses a valid node', () => {
    const result = NodeSchema.safeParse({
      name: 'metagraph-node-1',
      key_file: { name: 'token-key.p12', alias: 'token-key', password: 'password' },
    });
    expect(result.success).toBe(true);
  });

  it('fails when name is empty', () => {
    const result = NodeSchema.safeParse({
      name: '',
      key_file: { name: 'token-key.p12', alias: 'token-key', password: 'password' },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateOwnerStakingDiff
// ---------------------------------------------------------------------------
describe('validateOwnerStakingDiff', () => {
  it('returns null when owner and staking key files are different', () => {
    const config = EuclidConfigSchema.parse(BASE_CONFIG);
    expect(validateOwnerStakingDiff(config)).toBeNull();
  });

  it('returns an error string when owner and staking key files are the same', () => {
    const sameFile = {
      ...BASE_CONFIG,
      snapshot_fees: {
        owner: { key_file: { name: 'same.p12', alias: 'same', password: 'pass' } },
        staking: { key_file: { name: 'same.p12', alias: 'same', password: 'pass' } },
      },
    };
    const config = EuclidConfigSchema.parse(sameFile);
    const result = validateOwnerStakingDiff(config);
    expect(result).not.toBeNull();
    expect(result).toContain('same.p12');
  });

  it('error message describes the duplicated filename', () => {
    const config = EuclidConfigSchema.parse({
      ...BASE_CONFIG,
      snapshot_fees: {
        owner: { key_file: { name: 'dup.p12', alias: 'dup', password: 'pass' } },
        staking: { key_file: { name: 'dup.p12', alias: 'dup', password: 'pass' } },
      },
    });
    const result = validateOwnerStakingDiff(config);
    expect(result).toContain('dup.p12');
    expect(result).toContain('differ');
  });
});

// ---------------------------------------------------------------------------
// validateNetworkName
// ---------------------------------------------------------------------------
describe('validateNetworkName', () => {
  it('returns null for "integrationnet"', () => {
    const config = EuclidConfigSchema.parse(BASE_CONFIG);
    expect(validateNetworkName(config)).toBeNull();
  });

  it('returns null for "mainnet"', () => {
    const config = EuclidConfigSchema.parse({
      ...BASE_CONFIG,
      deploy: {
        ...BASE_CONFIG.deploy,
        network: { ...BASE_CONFIG.deploy.network, name: 'mainnet' },
      },
    });
    expect(validateNetworkName(config)).toBeNull();
  });

  it('returns null for "testnet"', () => {
    const config = EuclidConfigSchema.parse({
      ...BASE_CONFIG,
      deploy: {
        ...BASE_CONFIG.deploy,
        network: { ...BASE_CONFIG.deploy.network, name: 'testnet' },
      },
    });
    expect(validateNetworkName(config)).toBeNull();
  });

  it('returns an error message for an unknown network name', () => {
    const config = EuclidConfigSchema.parse({
      ...BASE_CONFIG,
      deploy: {
        ...BASE_CONFIG.deploy,
        network: { ...BASE_CONFIG.deploy.network, name: 'wrongnet' },
      },
    });
    const result = validateNetworkName(config);
    expect(result).not.toBeNull();
    expect(result).toContain('wrongnet');
  });

  it('returns an error for the pipe-separated template placeholder value', () => {
    const config = EuclidConfigSchema.parse({
      ...BASE_CONFIG,
      deploy: {
        ...BASE_CONFIG.deploy,
        network: { ...BASE_CONFIG.deploy.network, name: 'integrationnet|mainnet' },
      },
    });
    const result = validateNetworkName(config);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findPlaceholders
// ---------------------------------------------------------------------------
describe('findPlaceholders', () => {
  it('returns empty array for a fully-configured (non-placeholder) config', () => {
    const config = EuclidConfigSchema.parse(BASE_CONFIG);
    expect(findPlaceholders(config)).toHaveLength(0);
  });

  it('detects placeholder IP address', () => {
    const config = EuclidConfigSchema.parse({
      ...BASE_CONFIG,
      deploy: {
        ...BASE_CONFIG.deploy,
        network: {
          name: 'integrationnet',
          gl0_node: { ip: ':gl0_node_ip', id: 'real-id', public_port: 9000 },
        },
      },
    });
    expect(findPlaceholders(config)).toContain('deploy.network.gl0_node.ip');
  });

  it('detects placeholder node ID', () => {
    const config = EuclidConfigSchema.parse({
      ...BASE_CONFIG,
      deploy: {
        ...BASE_CONFIG.deploy,
        network: {
          name: 'integrationnet',
          gl0_node: { ip: '1.2.3.4', id: ':gl0_node_id', public_port: 9000 },
        },
      },
    });
    expect(findPlaceholders(config)).toContain('deploy.network.gl0_node.id');
  });

  it('detects placeholder public_port string', () => {
    const config = EuclidConfigSchema.parse({
      ...BASE_CONFIG,
      deploy: {
        ...BASE_CONFIG.deploy,
        network: {
          name: 'integrationnet',
          gl0_node: { ip: '1.2.3.4', id: 'real-id', public_port: ':gl0_node_public_port' },
        },
      },
    });
    expect(findPlaceholders(config)).toContain('deploy.network.gl0_node.public_port');
  });

  it('detects pipe-separated network name placeholder', () => {
    const config = EuclidConfigSchema.parse({
      ...BASE_CONFIG,
      deploy: {
        ...BASE_CONFIG.deploy,
        network: {
          name: 'integrationnet|mainnet',
          gl0_node: { ip: '1.2.3.4', id: 'real-id', public_port: 9000 },
        },
      },
    });
    expect(findPlaceholders(config)).toContain('deploy.network.name');
  });

  it('reports all four placeholders simultaneously', () => {
    const config = EuclidConfigSchema.parse({
      ...BASE_CONFIG,
      deploy: {
        ...BASE_CONFIG.deploy,
        network: {
          name: 'integrationnet|mainnet',
          gl0_node: {
            ip: ':gl0_node_ip',
            id: ':gl0_node_id',
            public_port: ':gl0_node_public_port',
          },
        },
      },
    });
    const placeholders = findPlaceholders(config);
    expect(placeholders).toHaveLength(4);
    expect(placeholders).toContain('deploy.network.name');
    expect(placeholders).toContain('deploy.network.gl0_node.ip');
    expect(placeholders).toContain('deploy.network.gl0_node.id');
    expect(placeholders).toContain('deploy.network.gl0_node.public_port');
  });
});

// ---------------------------------------------------------------------------
// coercePublicPort
// ---------------------------------------------------------------------------
describe('coercePublicPort', () => {
  it('returns a number unchanged', () => {
    expect(coercePublicPort(9000)).toBe(9000);
  });

  it('parses a valid numeric string to number', () => {
    expect(coercePublicPort('9000')).toBe(9000);
  });

  it('parses a numeric string with leading/trailing whitespace is OK via parseInt', () => {
    expect(coercePublicPort('  9000  ')).toBe(9000);
  });

  it('throws on a non-numeric placeholder string', () => {
    expect(() => coercePublicPort(':gl0_node_public_port')).toThrow();
  });

  it('throws on an empty string', () => {
    expect(() => coercePublicPort('')).toThrow();
  });

  it('throws on alphabetic string', () => {
    expect(() => coercePublicPort('abc')).toThrow();
  });
});
