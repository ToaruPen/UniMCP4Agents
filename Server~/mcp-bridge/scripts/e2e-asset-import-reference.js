#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const RUNTIME_CONFIG_FILENAME = '.unity-mcp-runtime.json';

// 1x1 PNG (opaque magenta)
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

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

function findObjectReferenceName(payload, propertyPath) {
  const properties = Array.isArray(payload?.properties) ? payload.properties : [];
  const prop = properties.find((entry) => entry?.path === propertyPath) ?? null;
  if (!prop) {
    return null;
  }
  const value = prop.objectReferenceValue;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function waitForAssetFind(client, assetFindTool, assetPathValue, timeoutMs = 60_000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    const args = buildArgsFromSchema(
      assetFindTool,
      [
        { keys: ['path', 'assetPath'], value: assetPathValue },
      ],
      { allowPartial: true }
    );
    const result = await client.callTool({ name: assetFindTool.name, arguments: args });
    if (!result?.isError) {
      const json = extractLastJson(result);
      if (json?.found === true) {
        return json;
      }
    }
    lastError = stringifyToolCallResult(result);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`Timed out waiting for asset to be discoverable: ${assetPathValue}\nLast error:\n${lastError ?? '(none)'}`);
}

async function main() {
  const options = parseArgs(process.argv);

  if (!options.unityProjectRoot) {
    fail(`This E2E writes assets to disk, so --project "/path/to/UnityProject" is required.`);
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

  const client = new Client({ name: 'unity-mcp-bridge-e2e-asset-import-reference', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: 'node', args: [bridgeIndexPath], env });

  const runId = Date.now();
  const texturesFolder = 'Assets/McpE2E/Textures';
  const materialsFolder = 'Assets/McpE2E/Materials';
  const textureBaseName = `AR_Texture_${runId}`;
  const materialBaseName = `AR_Mat_${runId}`;
  const textureAssetPath = `${texturesFolder}/${textureBaseName}.png`;
  const materialAssetPath = `${materialsFolder}/${materialBaseName}.mat`;
  const sourceName = `AR_Source_${runId}`;

  // Write a tiny PNG into Assets so Unity imports it.
  fs.mkdirSync(path.join(options.unityProjectRoot, texturesFolder), { recursive: true });
  fs.mkdirSync(path.join(options.unityProjectRoot, materialsFolder), { recursive: true });
  fs.writeFileSync(path.join(options.unityProjectRoot, textureAssetPath), Buffer.from(PNG_BASE64, 'base64'));

  try {
    await client.connect(transport);

    const toolList = await client.listTools();
    const tools = toolList?.tools ?? [];

    const assetRefreshTool = requireTool(tools, 'unity.asset.refresh', /^unity\.asset\.refresh$/i);
    const assetDeleteTool = requireTool(tools, 'unity.asset.delete', /^unity\.asset\.delete$/i);
    const assetFindTool = requireTool(tools, 'unity.asset.find', /^unity\.asset\.find$/i);
    const createMaterialTool = requireTool(tools, 'unity.asset.createMaterial', /^unity\.asset\.createMaterial$/i);
    const setTextureTypeTool = requireTool(tools, 'unity.assetImport.setTextureType', /^unity\.assetImport\.setTextureType$/i);
    const listSpritesTool = requireTool(tools, 'unity.assetImport.listSprites', /^unity\.assetImport\.listSprites$/i);

    const createTool = requireTool(tools, 'unity.create', /create/i);
    const addComponentTool = pickComponentAddTool(tools);
    const setReferenceTool = requireTool(tools, 'unity.component.setReference', /setreference/i);
    const setSpriteReferenceTool = requireTool(tools, 'unity.component.setSpriteReference', /^unity\.component\.setSpriteReference$/i);
    const serializedInspectTool = requireTool(tools, 'unity.serialized.inspect', /serialized\\.inspect/i);
    const destroyTool = requireSingleToolByFilter(
      tools,
      (tool) => /^unity\.(gameObject|gameobject)\./i.test(tool.name) && /destroy/i.test(tool.name),
      'GameObject destroy'
    );

    // Import/refresh new files.
    await client.callTool({ name: assetRefreshTool.name, arguments: {} });

    // AR-01: texture import is visible and configurable
    await waitForAssetFind(client, assetFindTool, textureAssetPath);

    const setTypeArgs = buildArgsFromSchema(setTextureTypeTool, [
      { keys: ['assetPath', 'path'], value: textureAssetPath },
      { keys: ['textureType'], value: 'Sprite' },
      { keys: ['reimport'], value: true, optional: true },
    ]);
    const setTypeResult = await client.callTool({
      name: setTextureTypeTool.name,
      arguments: { ...setTypeArgs, __confirm: true, __confirmNote: 'e2e-asset-import-reference AR-01' },
    });
    if (setTypeResult?.isError) {
      fail(`AR-01 unity.assetImport.setTextureType failed:\n${stringifyToolCallResult(setTypeResult)}`);
    }
    console.log('[AR-01] Texture imported and set to Sprite (bridge helper)');

    // AR-02: create a material asset (used for asset reference wiring)
    const createMaterialArgs = buildArgsFromSchema(createMaterialTool, [
      { keys: ['path', 'assetPath'], value: materialAssetPath },
    ]);
    const createMaterialResult = await client.callTool({ name: createMaterialTool.name, arguments: createMaterialArgs });
    if (createMaterialResult?.isError) {
      fail(`AR-02 createMaterial failed:\n${stringifyToolCallResult(createMaterialResult)}`);
    }
    console.log('[AR-02] Material created:', materialAssetPath);

    // AR-03: wire asset references via unity.component.setReference (referenceType omitted; Bridge infers asset from Assets/*)
    const sourceCreateArgs = buildArgsFromSchema(createTool, [
      { keys: ['primitiveType', 'type'], value: 'Cube' },
      { keys: ['name', 'gameObjectName', 'objectName'], value: sourceName },
    ]);
    const sourceCreate = await client.callTool({ name: createTool.name, arguments: sourceCreateArgs });
    if (sourceCreate?.isError) {
      fail(`AR-03 create source failed:\n${stringifyToolCallResult(sourceCreate)}`);
    }

    const addFixtureArgs = buildArgsFromSchema(addComponentTool, [
      { keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: sourceName },
      { keys: ['componentType', 'type', 'name'], value: 'SetReferenceFixture' },
    ]);
    const addFixtureResult = await client.callTool({ name: addComponentTool.name, arguments: addFixtureArgs });
    if (addFixtureResult?.isError) {
      fail(
        `AR-03 add SetReferenceFixture failed.\n` +
          `Ensure the Unity project contains a MonoBehaviour named SetReferenceFixture.\n\n` +
          `${stringifyToolCallResult(addFixtureResult)}`
      );
    }

    async function setAssetRef(fieldName, assetPathValue, label) {
      const args = buildArgsFromSchema(
        setReferenceTool,
        [
          { keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: sourceName },
          { keys: ['componentType', 'type'], value: 'SetReferenceFixture' },
          { keys: ['fieldName', 'propertyName', 'memberName'], value: fieldName },
          { keys: ['referencePath', 'targetPath', 'refPath'], value: assetPathValue },
        ],
        { allowPartial: true }
      );
      const result = await client.callTool({ name: setReferenceTool.name, arguments: args });
      if (result?.isError) {
        fail(`${label} setReference failed:\n${stringifyToolCallResult(result)}`);
      }
      return result;
    }

    await setAssetRef('material', materialAssetPath, 'AR-03 material');
    await setAssetRef('texture', textureAssetPath, 'AR-03 texture');

    const listSpritesArgs = buildArgsFromSchema(
      listSpritesTool,
      [{ keys: ['assetPath', 'path'], value: textureAssetPath }],
      { allowPartial: true }
    );
    const listSpritesResult = await client.callTool({ name: listSpritesTool.name, arguments: listSpritesArgs });
    if (listSpritesResult?.isError) {
      fail(`AR-03 listSprites failed:\n${stringifyToolCallResult(listSpritesResult)}`);
    }
    const listSpritesPayload = extractLastJson(listSpritesResult);
    const spriteNames = Array.isArray(listSpritesPayload?.spriteNames) ? listSpritesPayload.spriteNames : [];
    if (spriteNames.length === 0) {
      fail(`AR-03 expected listSprites to return >=1 spriteName, got:\n${JSON.stringify(listSpritesPayload, null, 2)}`);
    }

    const selectedSpriteName = spriteNames.includes(textureBaseName) ? textureBaseName : spriteNames[0];

    const setSpriteArgs = buildArgsFromSchema(
      setSpriteReferenceTool,
      [
        { keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: sourceName },
        { keys: ['componentType', 'type'], value: 'SetReferenceFixture' },
        { keys: ['fieldName', 'propertyName', 'memberName'], value: 'sprite' },
        { keys: ['assetPath', 'referencePath'], value: textureAssetPath },
        { keys: ['spriteName'], value: selectedSpriteName },
      ],
      { allowPartial: true }
    );
    const setSpriteResult = await client.callTool({ name: setSpriteReferenceTool.name, arguments: setSpriteArgs });
    if (setSpriteResult?.isError) {
      fail(`AR-03 setSpriteReference failed:\n${stringifyToolCallResult(setSpriteResult)}`);
    }

    console.log('[AR-03] Asset references set (material/texture/sprite)');

    const inspectArgs = buildArgsFromSchema(serializedInspectTool, [
      { keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: sourceName },
      { keys: ['componentType', 'type'], value: 'SetReferenceFixture' },
    ]);
    const inspectResult = await client.callTool({ name: serializedInspectTool.name, arguments: inspectArgs });
    if (inspectResult?.isError) {
      fail(`AR-03 serialized.inspect failed:\n${stringifyToolCallResult(inspectResult)}`);
    }

    const raw = extractLastJson(inspectResult);
    const payload = parseSerializedInspectPayload(raw);
    if (!payload) {
      fail(`AR-03 unable to parse serialized payload:\n${JSON.stringify(raw, null, 2)}`);
    }

    const materialRef = findObjectReferenceName(payload, 'material');
    const textureRef = findObjectReferenceName(payload, 'texture');
    const spriteRef = findObjectReferenceName(payload, 'sprite');

    if (!materialRef || !materialRef.includes(materialBaseName)) {
      fail(`AR-03 expected material reference to include "${materialBaseName}", got "${materialRef ?? '(null)'}"`);
    }
    if (!textureRef || !textureRef.includes(textureBaseName)) {
      fail(`AR-03 expected texture reference to include "${textureBaseName}", got "${textureRef ?? '(null)'}"`);
    }
    if (!spriteRef || !spriteRef.includes(selectedSpriteName)) {
      fail(`AR-03 expected sprite reference to include "${selectedSpriteName}", got "${spriteRef ?? '(null)'}"`);
    }
    console.log('[AR-03] Verified references via serialized.inspect');

    // Cleanup: destroy GO + delete assets.
    const destroyArgs = buildArgsFromSchema(destroyTool, [{ keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: sourceName }]);
    await client.callTool({
      name: destroyTool.name,
      arguments: { ...destroyArgs, __confirm: true, __confirmNote: 'e2e-asset-import-reference cleanup' },
    });

    const deleteMatArgs = buildArgsFromSchema(assetDeleteTool, [{ keys: ['path', 'assetPath'], value: materialAssetPath }]);
    await client.callTool({
      name: assetDeleteTool.name,
      arguments: { ...deleteMatArgs, __confirm: true, __confirmNote: 'e2e-asset-import-reference cleanup material' },
    });

    const deleteTexArgs = buildArgsFromSchema(assetDeleteTool, [{ keys: ['path', 'assetPath'], value: textureAssetPath }]);
    await client.callTool({
      name: assetDeleteTool.name,
      arguments: { ...deleteTexArgs, __confirm: true, __confirmNote: 'e2e-asset-import-reference cleanup texture' },
    });

    console.log('[E2E asset import/reference] PASS');
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
