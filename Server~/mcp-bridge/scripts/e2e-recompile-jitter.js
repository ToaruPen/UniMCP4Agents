#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
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
    compileFile: null,
    intervalMs: 250,
    timeoutMs: 2000,
    maxWaitMs: 60_000,
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
    if (value === '--compile-file') {
      options.compileFile = args[i + 1] ?? null;
      i++;
      continue;
    }
    if (value === '--interval-ms') {
      options.intervalMs = parsePositiveInt(args[i + 1], options.intervalMs);
      i++;
      continue;
    }
    if (value === '--timeout-ms') {
      options.timeoutMs = parsePositiveInt(args[i + 1], options.timeoutMs);
      i++;
      continue;
    }
    if (value === '--max-wait-ms') {
      options.maxWaitMs = parsePositiveInt(args[i + 1], options.maxWaitMs);
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
    // Back-compat: first positional arg is treated as project root.
    if (!options.unityProjectRoot) {
      options.unityProjectRoot = value;
      continue;
    }
    fail(`Unexpected argument: ${value}`);
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
    httpPort,
    runtimePath,
    parsed,
  };
}

function stringifyToolCallResult(result) {
  const parts = [];
  for (const item of result?.content ?? []) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    } else {
      parts.push(JSON.stringify(item, null, 2));
    }
  }
  return parts.join('\n');
}

async function connectBridge({ bridgeIndexPath, env }) {
  const client = new Client({ name: 'unity-mcp-bridge-e2e-jitter', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: 'node', args: [bridgeIndexPath], env });
  await client.connect(transport);
  return client;
}

function ensureTempRuntimeConfigAbsent(runtimeConfigPath) {
  if (!fs.existsSync(runtimeConfigPath)) {
    return { restored: false, backupPath: null, previous: null };
  }

  const previous = fs.readFileSync(runtimeConfigPath, 'utf8');
  const backupPath = `${runtimeConfigPath}.bak_unimcp`;
  fs.writeFileSync(backupPath, previous);
  fs.unlinkSync(runtimeConfigPath);
  return { restored: true, backupPath, previous };
}

function restoreTempRuntimeConfig(runtimeConfigPath, backup) {
  if (!backup?.restored) {
    if (fs.existsSync(runtimeConfigPath)) {
      fs.unlinkSync(runtimeConfigPath);
    }
    return;
  }

  if (backup.backupPath && fs.existsSync(backup.backupPath)) {
    const previous = fs.readFileSync(backup.backupPath, 'utf8');
    fs.writeFileSync(runtimeConfigPath, previous);
    fs.unlinkSync(backup.backupPath);
  }
}

function assertGuidanceContainsNextSteps(text, label) {
  const required = ['MCP/Server/Start', 'bridge.status', 'bridge.reload_config', 'unity.log.history', 'Unity Console'];
  const missing = required.filter((needle) => !text.includes(needle));
  if (missing.length > 0) {
    fail(`${label}: expected guidance to include ${missing.join(', ')}\n\n${text}`);
  }
}

async function main() {
  const options = parseArgs(process.argv);

  const unityProjectRoot = options.unityProjectRoot ?? process.cwd();
  const runtime = readRuntimeConfig(unityProjectRoot);
  const unityHttpUrl = options.unityHttpUrl ?? runtime.httpUrl;
  const bridgeIndexPath = fileURLToPath(new URL('../index.js', import.meta.url));

  const bridgeRuntimeConfigPath = path.join(process.cwd(), RUNTIME_CONFIG_FILENAME);

  // JR-03: runtime config reload after failure (simulated by starting with a stale URL)
  const staleHttpUrl = `http://localhost:${runtime.httpPort + 1}`;
  const runtimeBackup = ensureTempRuntimeConfigAbsent(bridgeRuntimeConfigPath);

  try {
    const env = {
      ...getDefaultEnvironment(),
      UNITY_HTTP_URL: staleHttpUrl,
      MCP_VERBOSE: options.verbose ? 'true' : undefined,
    };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete env[key];
      }
    }

    const client = await connectBridge({ bridgeIndexPath, env });
    try {
      const first = await client.callTool({
        name: 'unity.scene.list',
        arguments: { __timeoutMs: options.timeoutMs },
      });
      if (!first?.isError) {
        fail(`JR-03 expected first scene.list to fail with stale URL, but it succeeded:\n${stringifyToolCallResult(first)}`);
      }
      const firstText = stringifyToolCallResult(first);
      assertGuidanceContainsNextSteps(firstText, 'JR-03');
      console.log('[JR-03] stale URL fails with next-step guidance');

      fs.writeFileSync(
        bridgeRuntimeConfigPath,
        JSON.stringify({ httpPort: runtime.httpPort, projectName: runtime.parsed?.projectName ?? '' }, null, 2)
      );

      const second = await client.callTool({
        name: 'unity.scene.list',
        arguments: { __timeoutMs: Math.max(options.timeoutMs, 5000) },
      });
      if (second?.isError) {
        fail(`JR-03 expected scene.list to recover after runtime config write, but it failed:\n${stringifyToolCallResult(second)}`);
      }
      console.log('[JR-03] recovered via runtime config reload');
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    restoreTempRuntimeConfig(bridgeRuntimeConfigPath, runtimeBackup);
  }

  // JR-02: read-only calls during recompilation
  const compileFile =
    options.compileFile ??
    path.join(unityProjectRoot, 'Assets', 'McpCompileTest.cs');

  if (!fs.existsSync(compileFile)) {
    fail(`Compile file not found: ${compileFile}\nPass --compile-file to override.`);
  }

  const originalCompileSource = fs.readFileSync(compileFile, 'utf8');
  const compileTag = `// unimcp-jitter ${new Date().toISOString()}`;

  const env2 = {
    ...getDefaultEnvironment(),
    UNITY_HTTP_URL: unityHttpUrl,
    MCP_VERBOSE: options.verbose ? 'true' : undefined,
  };
  for (const [key, value] of Object.entries(env2)) {
    if (value === undefined) {
      delete env2[key];
    }
  }

  const client2 = await connectBridge({ bridgeIndexPath, env: env2 });
  try {
    const warm = await client2.callTool({ name: 'unity.scene.list', arguments: { __timeoutMs: Math.max(options.timeoutMs, 5000) } });
    if (warm?.isError) {
      fail(`JR-02 warmup scene.list failed:\n${stringifyToolCallResult(warm)}`);
    }

    // Trigger compilation
    fs.writeFileSync(compileFile, `${originalCompileSource.trimEnd()}\n${compileTag}\n`);
    console.log(`[JR-02] touched compile file: ${compileFile}`);

    const start = Date.now();
    let totalCalls = 0;
    let okCalls = 0;
    let errorCalls = 0;
    let firstErrorText = null;
    let stableOkStreak = 0;

    while (Date.now() - start < options.maxWaitMs) {
      totalCalls++;
      const result = await client2.callTool({
        name: 'unity.scene.list',
        arguments: { __timeoutMs: options.timeoutMs },
      });

      if (result?.isError) {
        errorCalls++;
        stableOkStreak = 0;
        if (!firstErrorText) {
          firstErrorText = stringifyToolCallResult(result);
        }
      } else {
        okCalls++;
        stableOkStreak++;
        if (stableOkStreak >= 3 && (errorCalls > 0 || Date.now() - start > 5000)) {
          break;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }

    if (firstErrorText) {
      assertGuidanceContainsNextSteps(firstErrorText, 'JR-02');
      console.log('[JR-02] saw transient failure with guidance, then recovered');
    } else {
      console.log('[JR-02] no transient errors observed (OK)');
    }

    console.log(
      JSON.stringify(
        {
          unityHttpUrl,
          compileFile,
          intervalMs: options.intervalMs,
          timeoutMs: options.timeoutMs,
          maxWaitMs: options.maxWaitMs,
          calls: {
            total: totalCalls,
            ok: okCalls,
            error: errorCalls,
          },
          firstErrorText: firstErrorText ? firstErrorText.slice(0, 2000) : null,
        },
        null,
        2
      )
    );
  } finally {
    // Restore original contents (will trigger another compile; acceptable for test project).
    fs.writeFileSync(compileFile, originalCompileSource);
    await client2.close().catch(() => {});
  }

  console.log('[E2E recompile/jitter] PASS');
}

main().catch((error) => {
  if (!process.exitCode) {
    process.exitCode = 1;
  }
  console.error(error?.stack || String(error));
});

