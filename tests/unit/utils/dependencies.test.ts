import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock node:child_process before importing the module under test.
// vi.mock() calls are hoisted by vitest, so this mock is applied before
// any import that transitively uses execFileSync.
// ---------------------------------------------------------------------------
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// Silence logger output during tests
vi.mock('../../../src/utils/logger.js', () => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  header: vi.fn(),
  detail: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import {
  checkDependencies,
  requireDependencies,
  TOOL_DOCKER,
  TOOL_ANSIBLE_PLAYBOOK,
  TOOL_JQ,
  LOCAL_DEPS,
  REMOTE_DEPS,
  type ToolDescriptor,
} from '../../../src/utils/dependencies.js';

// ---------------------------------------------------------------------------
// Typed mock helper
// ---------------------------------------------------------------------------
const mockExec = execFileSync as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// checkDependencies — success paths
// ---------------------------------------------------------------------------
describe('checkDependencies (success)', () => {
  it('returns ok=true when all required tools are found', () => {
    // execFileSync returns a Buffer with a version string
    mockExec.mockReturnValue(Buffer.from('Docker version 26.1.0, build abc'));

    const minimalTool: ToolDescriptor = {
      name: 'mock-tool',
      checkCommand: ['mock-tool', '--version'],
      installHint: 'install mock-tool',
    };

    const result = checkDependencies([minimalTool]);
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.versionErrors).toHaveLength(0);
  });

  it('passes TOOL_DOCKER when docker ≥ 26 is present', () => {
    mockExec.mockReturnValue(Buffer.from('Docker version 26.1.0, build c8af8eb'));
    const result = checkDependencies([TOOL_DOCKER]);
    expect(result.ok).toBe(true);
    expect(result.versionErrors).toHaveLength(0);
  });

  it('returns ok=true for empty deps list', () => {
    const result = checkDependencies([]);
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('marks optional missing tool in missingOptional, not missing', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'optional-tool') throw new Error('not found');
      return Buffer.from('ok');
    });

    const optionalTool: ToolDescriptor = {
      name: 'optional-tool',
      checkCommand: ['optional-tool', '--version'],
      installHint: 'install optional-tool',
      optional: true,
    };

    const result = checkDependencies([optionalTool]);
    // Optional missing tools should not make ok=false
    expect(result.missing).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkDependencies — missing tools
// ---------------------------------------------------------------------------
describe('checkDependencies (missing tools)', () => {
  it('returns ok=false and lists missing required tool', () => {
    mockExec.mockImplementation(() => {
      throw new Error('command not found');
    });

    const result = checkDependencies([TOOL_DOCKER]);
    expect(result.ok).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
    expect(result.missing[0].name).toBe('docker');
  });

  it('returns all missing tools when multiple are absent', () => {
    mockExec.mockImplementation(() => {
      throw new Error('command not found');
    });

    const result = checkDependencies([TOOL_DOCKER, TOOL_JQ]);
    expect(result.ok).toBe(false);
    const missingNames = result.missing.map((t) => t.name);
    expect(missingNames).toContain('docker');
    expect(missingNames).toContain('jq');
  });

  it('identifies specific tool as missing among partially-installed tools', () => {
    // docker found, ansible not found
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'ansible-playbook') throw new Error('command not found');
      return Buffer.from('Docker version 26.1.0, build abc');
    });

    const result = checkDependencies([TOOL_DOCKER, TOOL_ANSIBLE_PLAYBOOK]);
    expect(result.ok).toBe(false);
    const missingNames = result.missing.map((t) => t.name);
    expect(missingNames).not.toContain('docker');
    expect(missingNames).toContain('ansible-playbook');
  });
});

// ---------------------------------------------------------------------------
// checkDependencies — version errors
// ---------------------------------------------------------------------------
describe('checkDependencies (version errors)', () => {
  it('flags docker version below minimum (26.0.0)', () => {
    mockExec.mockReturnValue(Buffer.from('Docker version 25.0.1, build abc'));

    const result = checkDependencies([TOOL_DOCKER]);
    expect(result.ok).toBe(false);
    expect(result.versionErrors.length).toBeGreaterThan(0);
    expect(result.versionErrors[0]).toMatch(/25\.|minimum|26/i);
  });

  it('accepts docker 27.x as meeting the minimum version', () => {
    mockExec.mockReturnValue(Buffer.from('Docker version 27.0.0, build abc'));

    const result = checkDependencies([TOOL_DOCKER]);
    expect(result.ok).toBe(true);
    expect(result.versionErrors).toHaveLength(0);
  });

  it('reports version error when tool is present but version string is unparseable', () => {
    // Return output that does not match the docker version regex
    mockExec.mockReturnValue(Buffer.from('some completely different output'));

    const result = checkDependencies([TOOL_DOCKER]);
    // Cannot parse version — should be flagged as a version error
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requireDependencies
// ---------------------------------------------------------------------------
describe('requireDependencies', () => {
  it('does not throw when all dependencies are satisfied', () => {
    mockExec.mockReturnValue(Buffer.from('Docker version 26.1.0, build abc'));
    expect(() => requireDependencies([TOOL_DOCKER])).not.toThrow();
  });

  it('throws when a required dependency is missing', () => {
    mockExec.mockImplementation(() => {
      throw new Error('command not found');
    });

    expect(() => requireDependencies([TOOL_DOCKER])).toThrow();
  });

  it('throws an error listing all missing tools', () => {
    mockExec.mockImplementation(() => {
      throw new Error('not found');
    });

    try {
      requireDependencies([TOOL_DOCKER, TOOL_JQ]);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});

// ---------------------------------------------------------------------------
// Dependency group constants
// ---------------------------------------------------------------------------
describe('dependency group constants', () => {
  it('LOCAL_DEPS includes docker', () => {
    const names = LOCAL_DEPS.map((t) => t.name);
    expect(names).toContain('docker');
  });

  it('REMOTE_DEPS includes ansible-playbook and ssh', () => {
    const names = REMOTE_DEPS.map((t) => t.name);
    expect(names).toContain('ansible-playbook');
    expect(names).toContain('ssh');
  });

  it('LOCAL_DEPS contains only ToolDescriptor objects with required fields', () => {
    for (const dep of LOCAL_DEPS) {
      expect(dep).toHaveProperty('name');
      expect(dep).toHaveProperty('checkCommand');
      expect(dep).toHaveProperty('installHint');
      expect(Array.isArray(dep.checkCommand)).toBe(true);
      expect(dep.checkCommand.length).toBeGreaterThan(0);
    }
  });
});
