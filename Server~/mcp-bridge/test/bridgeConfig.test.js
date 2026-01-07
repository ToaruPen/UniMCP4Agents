import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadBridgeConfig, resolveBridgeConfigPath } from '../lib/bridgeConfig.js';

test('resolveBridgeConfigPath uses defaults and env override', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-config-'));
  try {
    assert.equal(resolveBridgeConfigPath({}, tempDir), path.join(tempDir, 'mcp-bridge.config.json'));
    assert.equal(
      resolveBridgeConfigPath({ MCP_BRIDGE_CONFIG_PATH: ' configs/custom.json ' }, tempDir),
      path.resolve(tempDir, 'configs/custom.json')
    );
    assert.equal(
      resolveBridgeConfigPath({ MCP_BRIDGE_CONFIG_PATH: '   ' }, tempDir),
      path.join(tempDir, 'mcp-bridge.config.json')
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadBridgeConfig reports missing files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-config-'));
  try {
    const result = loadBridgeConfig({}, tempDir);
    assert.equal(result.exists, false);
    assert.equal(result.config, null);
    assert.equal(result.error, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadBridgeConfig handles invalid JSON', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-config-'));
  try {
    const configPath = path.join(tempDir, 'mcp-bridge.config.json');
    fs.writeFileSync(configPath, '{ invalid json ', 'utf8');
    const result = loadBridgeConfig({}, tempDir);
    assert.equal(result.exists, true);
    assert.equal(result.config, null);
    assert.ok(result.error && result.error.includes('Failed to read'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadBridgeConfig normalizes lists and warnings', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-config-'));
  try {
    const configPath = path.join(tempDir, 'mcp-bridge.config.json');
    const config = {
      requireConfirmation: false,
      confirm: {
        allowlist: [' unity.scene.list ', 123, ''],
        denylist: ['unity.asset.delete'],
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
    const result = loadBridgeConfig({}, tempDir);
    assert.equal(result.exists, true);
    assert.deepEqual(result.config, {
      requireConfirmation: false,
      confirm: {
        allowlist: ['unity.scene.list'],
        denylist: ['unity.asset.delete'],
      },
    });
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0], 'confirm.allowlist entries must be strings.');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
