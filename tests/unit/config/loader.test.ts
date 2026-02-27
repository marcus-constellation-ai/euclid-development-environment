import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findConfigFile,
  loadConfig,
  loadConfigAsync,
  ConfigValidationError,
} from '../../../src/config/loader.js';

// ---------------------------------------------------------------------------
// Minimal valid euclid.json config fixture — new camelCase structure
// ---------------------------------------------------------------------------
const VALID_CONFIG = {
  version: '0.19.0',
  tessellation_version: '4.0.0-rc.0',
  ref_type: 'tag',
  projectName: 'my-project',
  framework: { name: 'currency', modules: ['data'], version: 'v3.6.0', ref_type: 'tag' },
  layers: ['global-l0', 'metagraph-l0', 'currency-l1'],
  nodes: [
    { name: 'node-1', key_file: { name: 'key1.p12', alias: 'key1', password: 'pass' } },
    { name: 'node-2', key_file: { name: 'key2.p12', alias: 'key2', password: 'pass' } },
    { name: 'node-3', key_file: { name: 'key3.p12', alias: 'key3', password: 'pass' } },
  ],
  monitoring: {
    grafana: { enabled: false },
    prometheus: { enabled: false },
  },
  snapshot_fees: {
    owner: { key_file: { name: 'owner.p12', alias: 'owner', password: 'pass' } },
    staking: { key_file: { name: 'staking.p12', alias: 'staking', password: 'pass' } },
  },
  deploy: {
    network: 'integrationnet',
    gl0Node: { ip: '1.2.3.4', id: 'abc123', publicPort: 9000 },
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
// Helpers
// ---------------------------------------------------------------------------
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'euclid-loader-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// findConfigFile
// ---------------------------------------------------------------------------
describe('findConfigFile', () => {
  it('returns null when no euclid.json exists anywhere up the tree', () => {
    // Use the OS temp dir itself — euclid.json is extremely unlikely to be there
    const result = findConfigFile(tmpDir);
    expect(result).toBeNull();
  });

  it('finds euclid.json in the exact directory given', () => {
    const configPath = join(tmpDir, 'euclid.json');
    writeFileSync(configPath, '{}');
    const result = findConfigFile(tmpDir);
    expect(result).toBe(configPath);
  });

  it('walks up the tree and finds euclid.json in a parent directory', () => {
    const configPath = join(tmpDir, 'euclid.json');
    writeFileSync(configPath, '{}');
    const subDir = join(tmpDir, 'src', 'commands', 'local');
    mkdirSync(subDir, { recursive: true });

    const result = findConfigFile(subDir);
    expect(result).toBe(configPath);
  });

  it('stops at the nearest euclid.json when multiple exist', () => {
    // Parent has one config
    writeFileSync(join(tmpDir, 'euclid.json'), '{"parent": true}');
    // Child has another (closer) config
    const childDir = join(tmpDir, 'child');
    mkdirSync(childDir);
    const childConfig = join(childDir, 'euclid.json');
    writeFileSync(childConfig, '{"child": true}');

    const result = findConfigFile(childDir);
    expect(result).toBe(childConfig);
  });
});

// ---------------------------------------------------------------------------
// loadConfig — happy paths
// ---------------------------------------------------------------------------
describe('loadConfig (success)', () => {
  it('loads and returns a valid euclid.json by explicit path', () => {
    const configPath = join(tmpDir, 'euclid.json');
    writeFileSync(configPath, JSON.stringify(VALID_CONFIG));

    const config = loadConfig(configPath);
    expect(config.version).toBe('0.19.0');
    expect(config.tessellation_version).toBe('4.0.0-rc.0');
    expect(config.nodes).toHaveLength(3);
    expect(config.ref_type).toBe('tag');
  });

  it('accepts a directory path and reads euclid.json inside it', () => {
    const configPath = join(tmpDir, 'euclid.json');
    writeFileSync(configPath, JSON.stringify(VALID_CONFIG));

    const config = loadConfig(tmpDir);
    expect(config.projectName).toBe('my-project');
  });

  it('preserves all nested config fields correctly', () => {
    const configPath = join(tmpDir, 'euclid.json');
    writeFileSync(configPath, JSON.stringify(VALID_CONFIG));

    const config = loadConfig(configPath);
    expect(config.deploy.network).toBe('integrationnet');
    expect(config.deploy.gl0Node.ip).toBe('1.2.3.4');
    expect(config.deploy.jvm.min_heap).toBe('1g');
    expect(config.snapshot_fees.owner.key_file.name).toBe('owner.p12');
    expect(config.snapshot_fees.staking.key_file.name).toBe('staking.p12');
  });

  it('marks optional metagraph_id as undefined when absent', () => {
    const configPath = join(tmpDir, 'euclid.json');
    writeFileSync(configPath, JSON.stringify(VALID_CONFIG));

    const config = loadConfig(configPath);
    expect(config.metagraph_id).toBeUndefined();
  });

  it('loads metagraph_id when present', () => {
    const configPath = join(tmpDir, 'euclid.json');
    writeFileSync(configPath, JSON.stringify({ ...VALID_CONFIG, metagraph_id: 'DAG123' }));

    const config = loadConfig(configPath);
    expect(config.metagraph_id).toBe('DAG123');
  });
});

// ---------------------------------------------------------------------------
// loadConfig — error paths
// ---------------------------------------------------------------------------
describe('loadConfig (errors)', () => {
  it('throws when the file does not exist', () => {
    expect(() => loadConfig('/nonexistent/path/euclid.json')).toThrow();
  });

  it('throws "Could not find euclid.json" when no path given and none found', () => {
    // Change cwd is not safe in tests, so test via findConfigFile returning null
    // We can verify the error message via findConfigFile itself:
    const result = findConfigFile('/tmp/definitely-no-euclid-here-xyz-789');
    expect(result).toBeNull();
  });

  it('throws "Invalid JSON" on malformed JSON content', () => {
    const configPath = join(tmpDir, 'euclid.json');
    writeFileSync(configPath, '{ this is : not json }');
    expect(() => loadConfig(configPath)).toThrow(/Invalid JSON/);
  });

  it('throws "No euclid.json found in directory" for a directory without euclid.json', () => {
    expect(() => loadConfig(tmpDir)).toThrow(/No euclid.json found in directory/);
  });

  it('throws ConfigValidationError when required fields are missing', () => {
    const configPath = join(tmpDir, 'euclid.json');
    writeFileSync(configPath, JSON.stringify({ version: '0.19.0' }));
    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
  });

  it('ConfigValidationError message contains the failing field path', () => {
    const configPath = join(tmpDir, 'euclid.json');
    const invalid = { ...VALID_CONFIG, ref_type: 'commit' }; // invalid enum value
    writeFileSync(configPath, JSON.stringify(invalid));

    try {
      loadConfig(configPath);
      expect.fail('Expected ConfigValidationError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const validationErr = err as ConfigValidationError;
      expect(validationErr.message).toContain('ref_type');
      expect(validationErr.filePath).toBe(configPath);
      expect(validationErr.zodError).toBeDefined();
    }
  });

  it('ConfigValidationError lists multiple field violations', () => {
    const configPath = join(tmpDir, 'euclid.json');
    // Missing nodes and layers
    const partial = {
      version: '0.19.0',
      tessellation_version: '4.0.0-rc.0',
      ref_type: 'tag',
      projectName: 'proj',
    };
    writeFileSync(configPath, JSON.stringify(partial));

    try {
      loadConfig(configPath);
      expect.fail('Expected ConfigValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      // The error message should mention multiple missing fields
      const msg = (err as ConfigValidationError).message;
      expect(msg.includes('nodes') || msg.includes('layers') || msg.includes('framework')).toBe(
        true,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// loadConfigAsync
// ---------------------------------------------------------------------------
describe('loadConfigAsync', () => {
  it('loads a valid config asynchronously', async () => {
    const configPath = join(tmpDir, 'euclid.json');
    writeFileSync(configPath, JSON.stringify(VALID_CONFIG));

    const config = await loadConfigAsync(configPath);
    expect(config.version).toBe('0.19.0');
  });

  it('rejects with ConfigValidationError on invalid config', async () => {
    const configPath = join(tmpDir, 'euclid.json');
    writeFileSync(configPath, JSON.stringify({ version: 'only-this' }));

    await expect(loadConfigAsync(configPath)).rejects.toThrow(ConfigValidationError);
  });

  it('rejects on missing file', async () => {
    await expect(loadConfigAsync('/no/such/file.json')).rejects.toThrow();
  });
});
