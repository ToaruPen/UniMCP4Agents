#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const RUNTIME_CONFIG_FILENAME = '.unity-mcp-runtime.json';

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    unityProjectRoot: null,
    unityHttpUrl: process.env.UNITY_HTTP_URL ?? null,
    cycles: 10,
    maxErrors: 0,
    focusMode: 'none', // none | unity | other
    unityApp: 'Unity',
    otherApp: 'Finder',
    stableCount: 3,
    healthIntervalMs: 250,
    healthTimeoutMs: 180_000,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--project') {
      options.unityProjectRoot = args[i + 1] ?? null;
      i++;
      continue;
    }
    if (value === '--unity-http-url') {
      options.unityHttpUrl = args[i + 1] ?? null;
      i++;
      continue;
    }
    if (value === '--cycles') {
      options.cycles = parsePositiveInt(args[i + 1], options.cycles);
      i++;
      continue;
    }
    if (value === '--max-errors') {
      options.maxErrors = parsePositiveInt(args[i + 1], options.maxErrors);
      i++;
      continue;
    }
    if (value === '--focus') {
      options.focusMode = args[i + 1] ?? options.focusMode;
      i++;
      continue;
    }
    if (value === '--unity-app') {
      options.unityApp = args[i + 1] ?? options.unityApp;
      i++;
      continue;
    }
    if (value === '--other-app') {
      options.otherApp = args[i + 1] ?? options.otherApp;
      i++;
      continue;
    }
    if (value === '--stable-count') {
      options.stableCount = parsePositiveInt(args[i + 1], options.stableCount);
      i++;
      continue;
    }
    if (value === '--health-interval-ms') {
      options.healthIntervalMs = parsePositiveInt(args[i + 1], options.healthIntervalMs);
      i++;
      continue;
    }
    if (value === '--health-timeout-ms') {
      options.healthTimeoutMs = parsePositiveInt(args[i + 1], options.healthTimeoutMs);
      i++;
      continue;
    }
    if (value === '--verbose') {
      options.verbose = true;
      continue;
    }
    if (value.startsWith('-')) {
      fail(`Unknown option: ${value}`);
    }
    if (!options.unityProjectRoot) {
      options.unityProjectRoot = value;
      continue;
    }
    fail(`Unexpected argument: ${value}`);
  }

  if (!['none', 'unity', 'other'].includes(options.focusMode)) {
    fail(`--focus must be one of: none, unity, other (got: ${options.focusMode})`);
  }

  return options;
}

function readRuntimeConfig(unityProjectRoot) {
  const runtimePath = path.join(unityProjectRoot, RUNTIME_CONFIG_FILENAME);
  if (!fs.existsSync(runtimePath)) {
    fail(`Runtime config not found: ${runtimePath}\nOpen Unity once so the MCP server writes ${RUNTIME_CONFIG_FILENAME}.`);
  }

  const parsed = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  const httpPort = Number(parsed.httpPort);
  if (!Number.isFinite(httpPort) || httpPort <= 0) {
    fail(`Invalid httpPort in ${runtimePath}`);
  }

  return {
    httpUrl: `http://localhost:${httpPort}`,
    runtimePath,
    parsed,
  };
}

function activateApp(appName) {
  if (typeof appName !== 'string' || appName.trim().length === 0) {
    return;
  }
  const escaped = appName.replace(/"/g, '\\"');
  spawnSync('osascript', ['-e', `tell application "${escaped}" to activate`], { stdio: 'ignore' });
}

async function healthOnce(httpUrl, timeoutMs = 1000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${httpUrl}/health`, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, status: response.status };
    }
    const json = await response.json().catch(() => null);
    return { ok: json?.status === 'ok', json };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error) };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitForHealthStable(httpUrl, { stableCount, intervalMs, maxWaitMs }) {
  const startTime = Date.now();
  let okStreak = 0;

  while (Date.now() - startTime < maxWaitMs) {
    const result = await healthOnce(httpUrl, 1000);
    if (result.ok) {
      okStreak++;
      if (okStreak >= stableCount) {
        return { ok: true, elapsedMs: Date.now() - startTime, last: result };
      }
    } else {
      okStreak = 0;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return { ok: false, elapsedMs: Date.now() - startTime, last: await healthOnce(httpUrl, 1000) };
}

function extractLastJson(result) {
  const parts = [];
  for (const item of result?.content ?? []) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }

  for (let i = parts.length - 1; i >= 0; i--) {
    const text = parts[i].trim();
    if (!text.startsWith('{') && !text.startsWith('[')) {
      continue;
    }
    try {
      return JSON.parse(text);
    } catch {
      continue;
    }
  }

  return null;
}

async function callToolTimed(client, name, args) {
  const startTime = Date.now();
  const result = await client.callTool({ name, arguments: args });
  return {
    name,
    durationMs: Date.now() - startTime,
    isError: result?.isError === true,
    json: extractLastJson(result),
  };
}

function makeSkippedCallMetric(name, reason) {
  return {
    name,
    durationMs: 0,
    isError: false,
    skipped: true,
    reason,
    json: null,
  };
}

function countErrorMetrics(metrics, { includeStatusTools }) {
  const errors = [];
  for (const entry of metrics) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const cycle = entry.cycle ?? null;

    if (entry.playCall?.isError) {
      errors.push({ cycle, kind: 'playCall' });
    }
    if (entry.stopCall?.isError) {
      errors.push({ cycle, kind: 'stopCall' });
    }

    if (entry.playRecover?.ok === false) {
      errors.push({ cycle, kind: 'playRecover' });
    }
    if (entry.stopRecover?.ok === false) {
      errors.push({ cycle, kind: 'stopRecover' });
    }

    if (includeStatusTools) {
      if (entry.playStatus?.isError) {
        errors.push({ cycle, kind: 'playStatus' });
      }
      if (entry.stopStatus?.isError) {
        errors.push({ cycle, kind: 'stopStatus' });
      }
    }
  }

  const counts = {};
  for (const err of errors) {
    counts[err.kind] = (counts[err.kind] ?? 0) + 1;
  }

  return { errors, counts, total: errors.length };
}

async function main() {
  const options = parseArgs(process.argv);

  let unityHttpUrl = options.unityHttpUrl;
  if (!unityHttpUrl) {
    const unityProjectRoot = options.unityProjectRoot ?? process.cwd();
    const runtime = readRuntimeConfig(unityProjectRoot);
    unityHttpUrl = runtime.httpUrl;
  }

  const bridgeIndexPath = fileURLToPath(new URL('../index.js', import.meta.url));
  const env = {
    ...getDefaultEnvironment(),
    UNITY_HTTP_URL: unityHttpUrl,
    MCP_VERBOSE: options.verbose ? 'true' : undefined,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }

  const client = new Client({ name: 'unity-mcp-bridge-playmode-ab', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: 'node', args: [bridgeIndexPath], env });

  try {
    await client.connect(transport);

    const toolsList = await client.listTools().catch(() => null);
    const tools = toolsList?.tools ?? [];
    const hasPlayModeStatusTool = tools.some((tool) => tool?.name === 'unity.editor.playModeStatus');

    if (options.focusMode === 'unity') {
      activateApp(options.unityApp);
    } else if (options.focusMode === 'other') {
      activateApp(options.otherApp);
    }

    const warm = await waitForHealthStable(unityHttpUrl, {
      stableCount: options.stableCount,
      intervalMs: options.healthIntervalMs,
      maxWaitMs: options.healthTimeoutMs,
    });
    if (!warm.ok) {
      fail(`Unity /health did not become stable within ${options.healthTimeoutMs}ms (last: ${JSON.stringify(warm.last)})`);
    }

    // Ensure stopped (best-effort).
    await callToolTimed(client, 'unity.editor.stop', {}).catch(() => {});
    await waitForHealthStable(unityHttpUrl, {
      stableCount: options.stableCount,
      intervalMs: options.healthIntervalMs,
      maxWaitMs: options.healthTimeoutMs,
    });

    const metrics = [];
    for (let i = 0; i < options.cycles; i++) {
      if (options.focusMode === 'unity') {
        activateApp(options.unityApp);
      }

      const playCall = await callToolTimed(client, 'unity.editor.play', {});
      if (options.focusMode === 'other') {
        activateApp(options.otherApp);
      }

      const playRecover = await waitForHealthStable(unityHttpUrl, {
        stableCount: options.stableCount,
        intervalMs: options.healthIntervalMs,
        maxWaitMs: options.healthTimeoutMs,
      });
      const playStatus = hasPlayModeStatusTool
        ? await callToolTimed(client, 'unity.editor.playModeStatus', {})
        : makeSkippedCallMetric('unity.editor.playModeStatus', 'tool not found');

      if (options.focusMode === 'unity') {
        activateApp(options.unityApp);
      }

      const stopCall = await callToolTimed(client, 'unity.editor.stop', {});
      if (options.focusMode === 'other') {
        activateApp(options.otherApp);
      }

      const stopRecover = await waitForHealthStable(unityHttpUrl, {
        stableCount: options.stableCount,
        intervalMs: options.healthIntervalMs,
        maxWaitMs: options.healthTimeoutMs,
      });
      const stopStatus = hasPlayModeStatusTool
        ? await callToolTimed(client, 'unity.editor.playModeStatus', {})
        : makeSkippedCallMetric('unity.editor.playModeStatus', 'tool not found');

      metrics.push({
        cycle: i + 1,
        playCall,
        playRecover,
        playStatus,
        stopCall,
        stopRecover,
        stopStatus,
      });
    }

    const errorSummary = countErrorMetrics(metrics, { includeStatusTools: hasPlayModeStatusTool });

    console.log(
      JSON.stringify(
        {
          unityHttpUrl,
          cycles: options.cycles,
          maxErrors: options.maxErrors,
          focusMode: options.focusMode,
          unityApp: options.unityApp,
          otherApp: options.otherApp,
          health: {
            stableCount: options.stableCount,
            intervalMs: options.healthIntervalMs,
            timeoutMs: options.healthTimeoutMs,
          },
          summary: {
            hasPlayModeStatusTool,
            errors: {
              total: errorSummary.total,
              counts: errorSummary.counts,
              maxAllowed: options.maxErrors,
            },
          },
          metrics,
        },
        null,
        2
      )
    );

    if (errorSummary.total > options.maxErrors) {
      console.error(
        `[playmode-ab] FAIL: errors=${errorSummary.total} exceeds maxErrors=${options.maxErrors}\n` +
          `Counts: ${JSON.stringify(errorSummary.counts)}`
      );
      process.exitCode = 1;
    } else {
      console.error(
        `[playmode-ab] OK: errors=${errorSummary.total} within maxErrors=${options.maxErrors}\n` +
          `Counts: ${JSON.stringify(errorSummary.counts)}`
      );
    }
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((error) => {
  if (!process.exitCode) {
    process.exitCode = 1;
  }
  console.error(error?.stack || String(error));
});
