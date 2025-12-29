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

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    unityProjectRoot: null,
    unityHttpUrl: process.env.UNITY_HTTP_URL ?? null,
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

function requireTool(tools, expectedName, hintPattern) {
  const match = tools.find((tool) => tool.name === expectedName);
  if (match) {
    return match;
  }

  const candidates = hintPattern
    ? tools.filter((tool) => hintPattern.test(tool.name)).map((tool) => tool.name)
    : tools.map((tool) => tool.name);

  fail(
    `Tool not found: ${expectedName}\n` +
      `Available candidates:\n- ${candidates.slice(0, 50).join('\n- ')}`
  );
}

function requireSingleToolByFilter(tools, filter, label) {
  const matches = tools.filter(filter);
  if (matches.length === 1) {
    return matches[0];
  }
  const names = matches.map((tool) => tool.name);
  fail(
    `Expected exactly 1 tool for ${label}, but found ${matches.length}.\n` +
      `Matches:\n- ${names.slice(0, 50).join('\n- ')}`
  );
}

function buildArgsFromSchema(tool, desired, { allowPartial = false } = {}) {
  const schema = tool?.inputSchema;
  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema?.required) ? schema.required : [];

  const args = {};
  for (const entry of desired) {
    const { keys, value, optional } = entry;
    const key = keys.find((candidate) => Object.prototype.hasOwnProperty.call(properties, candidate)) ?? null;
    if (!key) {
      if (optional) {
        continue;
      }
      fail(`Tool ${tool.name} does not expose any of these input keys: ${keys.join(', ')}`);
    }
    args[key] = value;
  }

  if (!allowPartial) {
    const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(args, key));
    if (missing.length > 0) {
      fail(`Tool ${tool.name} requires missing args: ${missing.join(', ')}`);
    }
  }

  return args;
}

function selectBooleanArgKey(tool, preferredKeys) {
  const schema = tool?.inputSchema;
  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};

  for (const key of preferredKeys) {
    if (properties?.[key]?.type === 'boolean') {
      return key;
    }
  }

  const booleanKeys = Object.entries(properties)
    .filter(([, value]) => value?.type === 'boolean')
    .map(([key]) => key);

  if (booleanKeys.length === 1) {
    return booleanKeys[0];
  }

  fail(
    `Tool ${tool.name} needs an active flag, but boolean keys are ambiguous.\n` +
      `Boolean keys: ${booleanKeys.join(', ')}`
  );
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

  // Remove undefined entries
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }

  const client = new Client(
    { name: 'unity-mcp-bridge-smoke', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StdioClientTransport({
    command: 'node',
    args: [bridgeIndexPath],
    env,
  });

  try {
    await client.connect(transport);

    const ping = await client.callTool({ name: 'bridge.ping', arguments: {} });
    if (ping?.isError) {
      fail(`bridge.ping failed:\n${stringifyToolCallResult(ping)}`);
    }
    console.log(`[Smoke] bridge.ping OK`);

    const toolList = await client.listTools();
    const tools = toolList?.tools ?? [];

    const createTool = requireTool(tools, 'unity.create', /create/i);
    const sceneListTool = requireTool(tools, 'unity.scene.list', /scene\\.list/i);
    const setActiveTool = requireSingleToolByFilter(
      tools,
      (tool) => /^unity\./.test(tool.name) && /setActive/i.test(tool.name),
      'setActive'
    );
    const destroyTool = requireSingleToolByFilter(
      tools,
      (tool) => /^unity\.(gameObject|gameobject)\./i.test(tool.name) && /destroy/i.test(tool.name),
      'GameObject destroy'
    );

    const objectName = `McpSmoke_${Date.now()}`;

    const createArgs = buildArgsFromSchema(createTool, [
      { keys: ['primitiveType', 'type'], value: 'Cube' },
      { keys: ['name', 'gameObjectName', 'objectName'], value: objectName },
    ]);

    const createResult = await client.callTool({ name: createTool.name, arguments: createArgs });
    if (createResult?.isError) {
      fail(`Create failed:\n${stringifyToolCallResult(createResult)}`);
    }
    console.log(`[Smoke] Created: ${objectName}`);

    const sceneListArgs = buildArgsFromSchema(sceneListTool, [{ keys: ['maxDepth'], value: 50, optional: true }]);
    const sceneListResult = await client.callTool({ name: sceneListTool.name, arguments: sceneListArgs });
    if (sceneListResult?.isError) {
      fail(`Scene list failed:\n${stringifyToolCallResult(sceneListResult)}`);
    }

    const targetKey = buildArgsFromSchema(
      setActiveTool,
      [{ keys: ['gameObjectPath', 'path', 'hierarchyPath'], value: objectName }],
      { allowPartial: true }
    );
    const activeKey = selectBooleanArgKey(setActiveTool, ['active', 'isActive', 'enabled']);

    const deactivateArgs = { ...targetKey, [activeKey]: false };
    const deactivateResult = await client.callTool({ name: setActiveTool.name, arguments: deactivateArgs });
    if (deactivateResult?.isError) {
      fail(`Deactivate failed:\n${stringifyToolCallResult(deactivateResult)}`);
    }
    console.log(`[Smoke] Deactivated: ${objectName}`);

    const activateArgs = { ...targetKey, [activeKey]: true };
    const activateResult = await client.callTool({ name: setActiveTool.name, arguments: activateArgs });
    if (activateResult?.isError) {
      fail(`Reactivate failed:\n${stringifyToolCallResult(activateResult)}`);
    }
    console.log(`[Smoke] Reactivated: ${objectName}`);

    const destroyArgsBase = buildArgsFromSchema(destroyTool, [{ keys: ['gameObjectPath', 'path', 'hierarchyPath'], value: objectName }]);

    const destroyWithoutConfirm = await client.callTool({ name: destroyTool.name, arguments: destroyArgsBase });
    if (!destroyWithoutConfirm?.isError) {
      fail(`Destroy without __confirm unexpectedly succeeded:\n${stringifyToolCallResult(destroyWithoutConfirm)}`);
    }
    console.log(`[Smoke] Destroy without __confirm correctly blocked`);

    const destroyWithConfirm = await client.callTool({
      name: destroyTool.name,
      arguments: { ...destroyArgsBase, __confirm: true, __confirmNote: 'smoke test cleanup' },
    });
    if (destroyWithConfirm?.isError) {
      fail(`Destroy with __confirm failed:\n${stringifyToolCallResult(destroyWithConfirm)}`);
    }
    console.log(`[Smoke] Destroyed: ${objectName}`);

    console.log('[Smoke] PASS');
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
