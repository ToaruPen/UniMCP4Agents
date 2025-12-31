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

function pickComponentAddTool(tools) {
  const exact = tools.find((tool) => tool.name === 'unity.component.add');
  if (exact) {
    return exact;
  }

  const candidates = tools.filter((tool) => /^unity\.component\./i.test(tool.name) && /add/i.test(tool.name));
  if (candidates.length === 1) {
    return candidates[0];
  }

  const withComponentTypeKey = candidates.filter((tool) => {
    const properties = tool?.inputSchema?.properties;
    return properties && typeof properties === 'object' && Object.prototype.hasOwnProperty.call(properties, 'componentType');
  });
  if (withComponentTypeKey.length === 1) {
    return withComponentTypeKey[0];
  }

  fail(
    `Unable to select a component-add tool.\n` +
      `Candidates:\n- ${candidates.map((tool) => tool.name).slice(0, 50).join('\n- ')}`
  );
}

async function createEmptyGameObject(client, createTool, name) {
  // Deprecated: unity.create does not always support empty GameObjects.
  // Keep this helper for future back-compat, but prefer the MeshFilter/MeshRenderer removal strategy.
  const createArgs = buildArgsFromSchema(createTool, [
    { keys: ['primitiveType', 'type'], value: 'Cube' },
    { keys: ['name', 'gameObjectName', 'objectName'], value: name },
  ]);
  const result = await client.callTool({ name: createTool.name, arguments: createArgs });
  if (result?.isError) {
    fail(`Failed to create fallback GameObject:\n${stringifyToolCallResult(result)}`);
  }
  return { primitiveType: 'Cube', result };
}

function countSubstring(haystack, needle) {
  if (typeof haystack !== 'string' || needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) {
      return count;
    }
    count++;
    index = found + needle.length;
  }
}

async function callToolWithRetry(client, tool, args, { attempts = 20, delayMs = 1000, label }) {
  let lastErrorText = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await client.callTool({ name: tool.name, arguments: args });
    if (!result?.isError) {
      return result;
    }

    lastErrorText = stringifyToolCallResult(result);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  fail(`${label} failed after ${attempts} attempts:\n${lastErrorText ?? '(no error text)'}`);
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

  const client = new Client({ name: 'unity-mcp-bridge-e2e-tilemap', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: 'node', args: [bridgeIndexPath], env });

  const runId = Date.now();
  const primitiveName = `TM_Primitive_${runId}`;
  const tilemapRootName = `TM_TilemapRoot_${runId}`;

  try {
    await client.connect(transport);

    const toolList = await client.listTools();
    const tools = toolList?.tools ?? [];

    const createTool = requireTool(tools, 'unity.create', /create/i);
    const addComponentTool = pickComponentAddTool(tools);
    const removeComponentTool = requireTool(tools, 'unity.component.remove', /component\\.remove/i);
    const sceneListTool = requireTool(tools, 'unity.scene.list', /scene\\.list/i);
    const executeMenuItemTool = requireTool(tools, 'unity.editor.executeMenuItem', /executeMenuItem/i);
    const destroyTool = requireSingleToolByFilter(
      tools,
      (tool) => /^unity\.(gameObject|gameobject)\./i.test(tool.name) && /destroy/i.test(tool.name),
      'GameObject destroy'
    );

    // TM-01: wrong route (primitive + TilemapRenderer)
    const primitiveCreateArgs = buildArgsFromSchema(createTool, [
      { keys: ['primitiveType', 'type'], value: 'Cube' },
      { keys: ['name', 'gameObjectName', 'objectName'], value: primitiveName },
    ]);
    const primitiveCreate = await client.callTool({ name: createTool.name, arguments: primitiveCreateArgs });
    if (primitiveCreate?.isError) {
      fail(`Create primitive failed:\n${stringifyToolCallResult(primitiveCreate)}`);
    }

    const addTilemapRendererArgs = buildArgsFromSchema(
      addComponentTool,
      [
        { keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: primitiveName },
        { keys: ['componentType', 'type', 'name'], value: 'UnityEngine.Tilemaps.TilemapRenderer' },
      ],
      { allowPartial: true }
    );
    const tm01 = await client.callTool({ name: addComponentTool.name, arguments: addTilemapRendererArgs });
    if (!tm01?.isError) {
      fail(`TM-01 expected TilemapRenderer add to fail, but it succeeded:\n${stringifyToolCallResult(tm01)}`);
    }
    const tm01Text = stringifyToolCallResult(tm01);
    if (!tm01Text.includes('MeshFilter') || !tm01Text.includes('Tilemap/Rectangular')) {
      fail(`TM-01 expected guidance to mention MeshFilter and Tilemap/Rectangular:\n${tm01Text}`);
    }
    console.log('[TM-01] Primitive route fails with guidance');

    // TM-02: correct route (empty GO + Tilemap + TilemapRenderer)
    // unity.create does not always support empty objects, so we create a primitive and remove mesh components.
    const tilemapRootCreateArgs = buildArgsFromSchema(createTool, [
      { keys: ['primitiveType', 'type'], value: 'Cube' },
      { keys: ['name', 'gameObjectName', 'objectName'], value: tilemapRootName },
    ]);
    const tilemapRootCreate = await client.callTool({ name: createTool.name, arguments: tilemapRootCreateArgs });
    if (tilemapRootCreate?.isError) {
      fail(`TM-02 create tilemap root failed:\n${stringifyToolCallResult(tilemapRootCreate)}`);
    }

    for (const componentType of ['MeshFilter', 'MeshRenderer']) {
      const removeArgs = buildArgsFromSchema(removeComponentTool, [
        { keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: tilemapRootName },
        { keys: ['componentType', 'type', 'name'], value: componentType },
      ]);
      const removeResult = await client.callTool({
        name: removeComponentTool.name,
        arguments: { ...removeArgs, __confirm: true, __confirmNote: `e2e-tilemap TM-02 remove ${componentType}` },
      });
      if (removeResult?.isError) {
        fail(`TM-02 remove ${componentType} failed:\n${stringifyToolCallResult(removeResult)}`);
      }
    }

    const addTilemapArgs = buildArgsFromSchema(
      addComponentTool,
      [
        { keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: tilemapRootName },
        { keys: ['componentType', 'type', 'name'], value: 'UnityEngine.Tilemaps.Tilemap' },
      ],
      { allowPartial: true }
    );
    const addTilemap = await client.callTool({ name: addComponentTool.name, arguments: addTilemapArgs });
    if (addTilemap?.isError) {
      fail(`TM-02 add Tilemap failed:\n${stringifyToolCallResult(addTilemap)}`);
    }

    const addTilemapRenderer2Args = buildArgsFromSchema(
      addComponentTool,
      [
        { keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: tilemapRootName },
        { keys: ['componentType', 'type', 'name'], value: 'UnityEngine.Tilemaps.TilemapRenderer' },
      ],
      { allowPartial: true }
    );
    const addTilemapRenderer2 = await client.callTool({ name: addComponentTool.name, arguments: addTilemapRenderer2Args });
    if (addTilemapRenderer2?.isError) {
      fail(`TM-02 add TilemapRenderer failed:\n${stringifyToolCallResult(addTilemapRenderer2)}`);
    }

    const tm02SceneArgs = buildArgsFromSchema(sceneListTool, [{ keys: ['maxDepth'], value: 50, optional: true }]);
    const tm02Scene = await client.callTool({ name: sceneListTool.name, arguments: tm02SceneArgs });
    if (tm02Scene?.isError) {
      fail(`TM-02 scene.list failed:\n${stringifyToolCallResult(tm02Scene)}`);
    }
    const tm02SceneText = stringifyToolCallResult(tm02Scene);
    if (!tm02SceneText.includes(tilemapRootName) || !tm02SceneText.includes('TilemapRenderer') || !tm02SceneText.includes('Tilemap')) {
      fail(`TM-02 expected scene.list to include Tilemap + TilemapRenderer on ${tilemapRootName}:\n${tm02SceneText}`);
    }
    console.log('[TM-02] Empty GO route works');

    // TM-03: menu route (executeMenuItem)
    const beforeScene = await callToolWithRetry(client, sceneListTool, tm02SceneArgs, { label: 'TM-03 scene.list(before)' });
    const beforeText = stringifyToolCallResult(beforeScene);
    const beforeCount = countSubstring(beforeText, 'TilemapRenderer');

    const executeArgs = buildArgsFromSchema(executeMenuItemTool, [
      { keys: ['menuPath', 'menuItem', 'menuItemPath', 'path'], value: 'GameObject/2D Object/Tilemap/Rectangular' },
    ]);
    const exec = await client.callTool({
      name: executeMenuItemTool.name,
      arguments: { ...executeArgs, __confirm: true, __confirmNote: 'e2e-tilemap TM-03' },
    });
    if (exec?.isError) {
      fail(`TM-03 executeMenuItem failed:\n${stringifyToolCallResult(exec)}`);
    }

    const afterScene = await callToolWithRetry(client, sceneListTool, tm02SceneArgs, { label: 'TM-03 scene.list(after)' });
    const afterText = stringifyToolCallResult(afterScene);
    const afterCount = countSubstring(afterText, 'TilemapRenderer');
    if (!(afterCount > beforeCount)) {
      fail(
        `TM-03 expected TilemapRenderer occurrences to increase after menu create.\n` +
          `before=${beforeCount}, after=${afterCount}\n`
      );
    }
    console.log('[TM-03] Menu route created a TilemapRenderer');

    // Cleanup
    const destroyPrimitiveArgs = buildArgsFromSchema(destroyTool, [{ keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: primitiveName }]);
    await client.callTool({ name: destroyTool.name, arguments: { ...destroyPrimitiveArgs, __confirm: true, __confirmNote: 'e2e-tilemap cleanup' } }).catch(() => {});
    const destroyRootArgs = buildArgsFromSchema(destroyTool, [{ keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: tilemapRootName }]);
    await client.callTool({ name: destroyTool.name, arguments: { ...destroyRootArgs, __confirm: true, __confirmNote: 'e2e-tilemap cleanup' } }).catch(() => {});

    console.log('[E2E tilemap] PASS');
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
