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

function flattenSceneNodes(rootObjects) {
  const nodes = [];
  const stack = Array.isArray(rootObjects) ? [...rootObjects] : [];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') {
      continue;
    }
    nodes.push(node);
    if (Array.isArray(node.children) && node.children.length > 0) {
      stack.push(...node.children);
    }
  }
  return nodes;
}

function parseSerializedInspectPayload(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (typeof raw.message === 'string') {
    try {
      return JSON.parse(raw.message);
    } catch {
      return null;
    }
  }
  return null;
}

function readIntProperty(payload, propertyPath) {
  const properties = Array.isArray(payload?.properties) ? payload.properties : [];
  const prop = properties.find((entry) => entry?.path === propertyPath) ?? null;
  if (!prop) {
    return null;
  }
  const candidate = prop.intValue ?? prop.longValue ?? prop.floatValue ?? prop.doubleValue ?? null;
  if (candidate === null || candidate === undefined) {
    return null;
  }
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

async function main() {
  const options = parseArgs(process.argv);

  if (!options.unityHttpUrl && !options.unityProjectRoot) {
    fail(`Provide --project "/path/to/UnityProject" (or set UNITY_HTTP_URL).`);
  }

  let unityHttpUrl = options.unityHttpUrl;
  if (!unityHttpUrl) {
    const runtime = readRuntimeConfig(options.unityProjectRoot);
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

  const client = new Client({ name: 'unity-mcp-bridge-e2e-prefab', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: 'node', args: [bridgeIndexPath], env });

  const runId = Date.now();
  const rootName = `PF_Root_${runId}`;
  const prefabFolder = 'Assets/McpE2E/Prefabs';
  const prefabPath = `${prefabFolder}/PF_${runId}.prefab`;

  try {
    await client.connect(transport);

    const toolList = await client.listTools();
    const tools = toolList?.tools ?? [];

    const createTool = requireTool(tools, 'unity.create', /create/i);
    const addComponentTool = pickComponentAddTool(tools);
    const setSerializedPropertyTool = requireTool(tools, 'unity.component.setSerializedProperty', /setserializedproperty/i);
    const serializedInspectTool = requireTool(tools, 'unity.serialized.inspect', /serialized\\.inspect/i);
    const sceneListTool = requireTool(tools, 'unity.scene.list', /scene\\.list/i);

    const prefabCreateTool = requireTool(tools, 'unity.prefab.create', /^unity\.prefab\.create$/i);
    const prefabInstantiateTool = requireTool(tools, 'unity.prefab.instantiate', /^unity\.prefab\.instantiate$/i);
    const prefabApplyTool = requireTool(tools, 'unity.prefab.apply', /^unity\.prefab\.apply$/i);
    const prefabRevertTool = requireTool(tools, 'unity.prefab.revert', /^unity\.prefab\.revert$/i);
    const prefabUnpackTool = requireTool(tools, 'unity.prefab.unpack', /^unity\.prefab\.unpack$/i);

    const assetDeleteTool = requireTool(tools, 'unity.asset.delete', /^unity\.asset\.delete$/i);
    const assetRefreshTool = requireTool(tools, 'unity.asset.refresh', /^unity\.asset\.refresh$/i);
    const destroyTool = requireSingleToolByFilter(
      tools,
      (tool) => /^unity\.(gameObject|gameobject)\./i.test(tool.name) && /destroy/i.test(tool.name),
      'GameObject destroy'
    );

    // Ensure prefab folder exists on disk (Unity will generate meta on refresh/import).
    if (options.unityProjectRoot) {
      fs.mkdirSync(path.join(options.unityProjectRoot, prefabFolder), { recursive: true });
    }
    await client.callTool({ name: assetRefreshTool.name, arguments: {} }).catch(() => {});

    // PF-01: create a source GameObject with McpCompileTest.
    const createArgs = buildArgsFromSchema(createTool, [
      { keys: ['primitiveType', 'type'], value: 'Cube' },
      { keys: ['name', 'gameObjectName', 'objectName'], value: rootName },
    ]);
    const createResult = await client.callTool({ name: createTool.name, arguments: createArgs });
    if (createResult?.isError) {
      fail(`PF-01 create failed:\n${stringifyToolCallResult(createResult)}`);
    }

    const addComponentArgs = buildArgsFromSchema(addComponentTool, [
      { keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: rootName },
      { keys: ['componentType', 'type', 'name'], value: 'McpCompileTest' },
    ]);
    const addComponentResult = await client.callTool({ name: addComponentTool.name, arguments: addComponentArgs });
    if (addComponentResult?.isError) {
      fail(
        `PF-01 add McpCompileTest failed.\n` +
          `Ensure the Unity project contains a MonoBehaviour named McpCompileTest.\n\n` +
          `${stringifyToolCallResult(addComponentResult)}`
      );
    }

    const baselineValue = 111;
    const setBaselineArgs = buildArgsFromSchema(setSerializedPropertyTool, [
      { keys: ['gameObjectPath', 'path'], value: rootName },
      { keys: ['componentType', 'type'], value: 'McpCompileTest' },
      { keys: ['propertyPath', 'fieldPath'], value: 'Value' },
      { keys: ['value'], value: String(baselineValue) },
    ]);
    const setBaselineResult = await client.callTool({ name: setSerializedPropertyTool.name, arguments: setBaselineArgs });
    if (setBaselineResult?.isError) {
      fail(`PF-01 set baseline Value failed:\n${stringifyToolCallResult(setBaselineResult)}`);
    }
    console.log('[PF-01] Created source and set baseline Value');

    // PF-02: create prefab asset, then destroy source object to avoid ambiguity.
    const prefabCreateArgs = buildArgsFromSchema(prefabCreateTool, [
      { keys: ['gameObjectPath', 'path'], value: rootName },
      { keys: ['prefabPath', 'path'], value: prefabPath },
    ]);
    const prefabCreateResult = await client.callTool({ name: prefabCreateTool.name, arguments: prefabCreateArgs });
    if (prefabCreateResult?.isError) {
      fail(`PF-02 prefab.create failed:\n${stringifyToolCallResult(prefabCreateResult)}`);
    }
    console.log('[PF-02] Prefab created:', prefabPath);

    const destroySourceArgs = buildArgsFromSchema(destroyTool, [{ keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: rootName }]);
    await client.callTool({
      name: destroyTool.name,
      arguments: { ...destroySourceArgs, __confirm: true, __confirmNote: 'e2e-prefab cleanup source instance before instantiate' },
    });

    // PF-03: instantiate prefab, locate the instance by scene.list.
    const prefabInstantiateArgs = buildArgsFromSchema(prefabInstantiateTool, [{ keys: ['prefabPath'], value: prefabPath }]);
    const prefabInstantiateResult = await client.callTool({ name: prefabInstantiateTool.name, arguments: prefabInstantiateArgs });
    if (prefabInstantiateResult?.isError) {
      fail(`PF-03 prefab.instantiate failed:\n${stringifyToolCallResult(prefabInstantiateResult)}`);
    }

    const sceneListResult = await client.callTool({ name: sceneListTool.name, arguments: {} });
    if (sceneListResult?.isError) {
      fail(`PF-03 scene.list failed:\n${stringifyToolCallResult(sceneListResult)}`);
    }
    const sceneJson = extractLastJson(sceneListResult);
    const nodes = flattenSceneNodes(sceneJson?.rootObjects);
    const instanceCandidates = nodes.filter(
      (node) =>
        typeof node?.name === 'string' &&
        node.name.includes(String(runId)) &&
        Array.isArray(node.components) &&
        node.components.includes('McpCompileTest')
    );
    if (instanceCandidates.length !== 1) {
      fail(
        `PF-03 expected exactly 1 prefab instance candidate but found ${instanceCandidates.length}\n` +
          `Candidates:\n${JSON.stringify(instanceCandidates.map((c) => ({ name: c.name, path: c.path })), null, 2)}\n\n` +
          `Scene JSON:\n${JSON.stringify(sceneJson, null, 2)}`
      );
    }
    const instancePath = instanceCandidates[0].path;
    console.log('[PF-03] Prefab instantiated:', instancePath);

    async function readValue(label) {
      const inspectArgs = buildArgsFromSchema(serializedInspectTool, [
        { keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: instancePath },
        { keys: ['componentType', 'type'], value: 'McpCompileTest' },
      ]);
      const inspectResult = await client.callTool({ name: serializedInspectTool.name, arguments: inspectArgs });
      if (inspectResult?.isError) {
        fail(`${label} serialized.inspect failed:\n${stringifyToolCallResult(inspectResult)}`);
      }

      const raw = extractLastJson(inspectResult);
      const payload = parseSerializedInspectPayload(raw);
      if (!payload) {
        fail(`${label} unable to parse serialized payload:\n${JSON.stringify(raw, null, 2)}`);
      }

      const value = readIntProperty(payload, 'Value');
      if (value === null) {
        fail(`${label} missing Value in serialized payload:\n${JSON.stringify(payload, null, 2)}`);
      }
      return value;
    }

    async function setValue(newValue, note) {
      const setArgs = buildArgsFromSchema(setSerializedPropertyTool, [
        { keys: ['gameObjectPath', 'path'], value: instancePath },
        { keys: ['componentType', 'type'], value: 'McpCompileTest' },
        { keys: ['propertyPath', 'fieldPath'], value: 'Value' },
        { keys: ['value'], value: String(newValue) },
      ]);
      const setResult = await client.callTool({ name: setSerializedPropertyTool.name, arguments: setArgs });
      if (setResult?.isError) {
        fail(`${note} setSerializedProperty failed:\n${stringifyToolCallResult(setResult)}`);
      }
    }

    // PF-04: revert restores prefab baseline
    await setValue(222, 'PF-04');
    const beforeRevert = await readValue('PF-04');
    if (beforeRevert !== 222) {
      fail(`PF-04 expected Value=222 before revert, got ${beforeRevert}`);
    }

    const revertArgs = buildArgsFromSchema(prefabRevertTool, [{ keys: ['instancePath', 'path'], value: instancePath }]);
    const revertResult = await client.callTool({ name: prefabRevertTool.name, arguments: revertArgs });
    if (revertResult?.isError) {
      fail(`PF-04 prefab.revert failed:\n${stringifyToolCallResult(revertResult)}`);
    }
    const afterRevert = await readValue('PF-04');
    if (afterRevert !== baselineValue) {
      fail(`PF-04 expected Value=${baselineValue} after revert, got ${afterRevert}`);
    }
    console.log('[PF-04] revert restores baseline');

    // PF-05: apply updates prefab base, and revert returns to the applied value.
    const appliedValue = 333;
    await setValue(appliedValue, 'PF-05');
    const applyArgs = buildArgsFromSchema(prefabApplyTool, [{ keys: ['instancePath', 'path'], value: instancePath }]);
    const applyResult = await client.callTool({ name: prefabApplyTool.name, arguments: applyArgs });
    if (applyResult?.isError) {
      fail(`PF-05 prefab.apply failed:\n${stringifyToolCallResult(applyResult)}`);
    }

    await setValue(444, 'PF-05');
    const revert2Result = await client.callTool({ name: prefabRevertTool.name, arguments: revertArgs });
    if (revert2Result?.isError) {
      fail(`PF-05 prefab.revert (after apply) failed:\n${stringifyToolCallResult(revert2Result)}`);
    }
    const afterApplyRevert = await readValue('PF-05');
    if (afterApplyRevert !== appliedValue) {
      fail(`PF-05 expected Value=${appliedValue} after apply+revert, got ${afterApplyRevert}`);
    }
    console.log('[PF-05] apply updates prefab, revert returns to applied value');

    // PF-06: unpack breaks prefab link (apply/revert should error)
    const unpackArgs = buildArgsFromSchema(prefabUnpackTool, [
      { keys: ['instancePath', 'path'], value: instancePath },
      { keys: ['unpackMode'], value: 'Completely', optional: true },
    ]);
    const unpackResult = await client.callTool({ name: prefabUnpackTool.name, arguments: unpackArgs });
    if (unpackResult?.isError) {
      fail(`PF-06 prefab.unpack failed:\n${stringifyToolCallResult(unpackResult)}`);
    }

    const applyAfterUnpack = await client.callTool({ name: prefabApplyTool.name, arguments: applyArgs });
    if (!applyAfterUnpack?.isError) {
      fail(`PF-06 expected prefab.apply to fail after unpack, but it succeeded:\n${stringifyToolCallResult(applyAfterUnpack)}`);
    }
    console.log('[PF-06] unpack removes prefab link (apply fails as expected)');

    // Cleanup: destroy instance + delete prefab asset.
    const destroyInstanceArgs = buildArgsFromSchema(destroyTool, [{ keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: instancePath }]);
    await client.callTool({
      name: destroyTool.name,
      arguments: { ...destroyInstanceArgs, __confirm: true, __confirmNote: 'e2e-prefab cleanup instance' },
    });

    const deletePrefabArgs = buildArgsFromSchema(assetDeleteTool, [{ keys: ['path', 'assetPath'], value: prefabPath }]);
    await client.callTool({
      name: assetDeleteTool.name,
      arguments: { ...deletePrefabArgs, __confirm: true, __confirmNote: 'e2e-prefab cleanup prefab asset' },
    });

    console.log('[E2E prefab] PASS');
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
