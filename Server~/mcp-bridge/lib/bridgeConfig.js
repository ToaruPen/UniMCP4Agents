import fs from 'fs';
import path from 'path';

const DEFAULT_CONFIG_FILENAME = 'mcp-bridge.config.json';

function normalizePatternList(value, warnings, label) {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    warnings.push(`${label} must be an array of strings.`);
    return null;
  }

  const patterns = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      warnings.push(`${label} entries must be strings.`);
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      patterns.push(trimmed);
    }
  }

  return patterns;
}

function normalizeBridgeConfig(parsed, warnings) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push('Bridge config must be a JSON object.');
    return {};
  }

  const config = {};

  if (Object.prototype.hasOwnProperty.call(parsed, 'requireConfirmation')) {
    if (typeof parsed.requireConfirmation === 'boolean') {
      config.requireConfirmation = parsed.requireConfirmation;
    } else {
      warnings.push('requireConfirmation must be a boolean.');
    }
  }

  if (Object.prototype.hasOwnProperty.call(parsed, 'confirm')) {
    if (!parsed.confirm || typeof parsed.confirm !== 'object' || Array.isArray(parsed.confirm)) {
      warnings.push('confirm must be an object.');
    } else {
      const confirm = {};
      const allowlist = normalizePatternList(parsed.confirm.allowlist, warnings, 'confirm.allowlist');
      const denylist = normalizePatternList(parsed.confirm.denylist, warnings, 'confirm.denylist');

      if (allowlist !== null) {
        confirm.allowlist = allowlist;
      }
      if (denylist !== null) {
        confirm.denylist = denylist;
      }

      if (Object.keys(confirm).length > 0) {
        config.confirm = confirm;
      }
    }
  }

  return config;
}

export function resolveBridgeConfigPath(env, cwd = process.cwd()) {
  const raw = typeof env?.MCP_BRIDGE_CONFIG_PATH === 'string' ? env.MCP_BRIDGE_CONFIG_PATH.trim() : '';
  if (raw.length > 0) {
    return path.resolve(cwd, raw);
  }
  return path.join(cwd, DEFAULT_CONFIG_FILENAME);
}

export function loadBridgeConfig(env, cwd = process.cwd()) {
  const configPath = resolveBridgeConfigPath(env, cwd);
  const result = {
    path: configPath,
    exists: false,
    config: null,
    error: null,
    warnings: [],
  };

  if (!fs.existsSync(configPath)) {
    return result;
  }

  result.exists = true;

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    result.config = normalizeBridgeConfig(parsed, result.warnings);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.error = `Failed to read ${configPath}: ${message}`;
    return result;
  }
}

export { DEFAULT_CONFIG_FILENAME };
