#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  buildArgsFromSchema,
  buildBridgeEnv,
  extractLastJson,
  fail,
  readRuntimeConfig,
  requireSingleToolByFilter,
  requireTool,
  resolveBridgeIndexPath,
  stringifyToolCallResult,
} from './_e2eUtil.js';

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
    if (!options.unityProjectRoot) {
      options.unityProjectRoot = value;
      continue;
    }
    fail(`Unexpected argument: ${value}`);
  }

  return options;
}

function ensureNoMissingRequired(tool, args, label) {
  const required = Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [];
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(args, key));
  if (missing.length > 0) {
    fail(`${label} missing required args: ${missing.join(', ')}`);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  if (!options.unityProjectRoot && !options.unityHttpUrl) {
    fail(`Provide --project "/path/to/UnityProject" (or set UNITY_HTTP_URL).`);
  }

  let unityHttpUrl = options.unityHttpUrl;
  if (!unityHttpUrl) {
    const runtime = readRuntimeConfig(options.unityProjectRoot);
    unityHttpUrl = runtime.httpUrl;
  }

  const bridgeIndexPath = resolveBridgeIndexPath(import.meta.url);
  const env = buildBridgeEnv({ unityHttpUrl, verbose: options.verbose });

  const client = new Client({ name: 'unity-mcp-bridge-e2e-scene-save', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: 'node', args: [bridgeIndexPath], env });

  const runId = Date.now();
  const sceneFolder = 'Assets/McpE2E/Scenes';
  const sceneName = `Scene_${runId}`;
  const scenePath = `${sceneFolder}/${sceneName}.unity`;
  const markerName = `SceneMarker_${runId}`;
  const fallbackScenePath = 'Assets/Scenes/SampleScene.unity';

  if (options.unityProjectRoot) {
    fs.mkdirSync(path.join(options.unityProjectRoot, sceneFolder), { recursive: true });
  }

  try {
    await client.connect(transport);

    const toolList = await client.listTools();
    const tools = toolList?.tools ?? [];

    const sceneCreateTool = requireTool(tools, 'unity.scene.new', /^unity\.scene\.(new|create)$/i);
    const sceneSaveTool = requireTool(tools, 'unity.scene.save', /^unity\.scene\.save$/i);
    const sceneOpenTool = requireTool(tools, 'unity.scene.open', /^unity\.scene\.open$/i);
    const sceneListTool = requireTool(tools, 'unity.scene.list', /^unity\.scene\.list$/i);
    const assetFindTool = requireTool(tools, 'unity.asset.find', /^unity\.asset\.find$/i);
    const assetDeleteTool = requireTool(tools, 'unity.asset.delete', /^unity\.asset\.delete$/i);
    const createTool = requireTool(tools, 'unity.create', /create/i);
    const destroyTool = requireSingleToolByFilter(
      tools,
      (tool) => /^unity\.(gameObject|gameobject)\./i.test(tool.name) && /destroy/i.test(tool.name),
      'GameObject destroy'
    );

    const createSceneArgs = buildArgsFromSchema(
      sceneCreateTool,
      [
        { keys: ['sceneName', 'name'], value: sceneName },
        { keys: ['savePath'], value: sceneFolder, optional: true },
        { keys: ['setupType'], value: 'DefaultGameObjects', optional: true },
      ],
      { allowPartial: true }
    );
    ensureNoMissingRequired(sceneCreateTool, createSceneArgs, 'SC-01 scene.create');
    const sceneCreateResult = await client.callTool({ name: sceneCreateTool.name, arguments: createSceneArgs });
    if (sceneCreateResult?.isError) {
      fail(`SC-01 scene.create failed:\n${stringifyToolCallResult(sceneCreateResult)}`);
    }
    console.log('[SC-01] Scene created:', scenePath);

    const createMarkerArgs = buildArgsFromSchema(createTool, [
      { keys: ['primitiveType', 'type'], value: 'Cube' },
      { keys: ['name', 'gameObjectName', 'objectName'], value: markerName },
    ]);
    const createMarkerResult = await client.callTool({ name: createTool.name, arguments: createMarkerArgs });
    if (createMarkerResult?.isError) {
      fail(`SC-02 create marker failed:\n${stringifyToolCallResult(createMarkerResult)}`);
    }

    const saveArgs = buildArgsFromSchema(
      sceneSaveTool,
      [{ keys: ['scenePath', 'path'], value: scenePath }],
      { allowPartial: true }
    );
    ensureNoMissingRequired(sceneSaveTool, saveArgs, 'SC-03 scene.save');
    const saveResult = await client.callTool({ name: sceneSaveTool.name, arguments: saveArgs });
    if (saveResult?.isError) {
      fail(`SC-03 scene.save failed:\n${stringifyToolCallResult(saveResult)}`);
    }
    console.log('[SC-03] Scene saved');

    const listArgs = buildArgsFromSchema(sceneListTool, [{ keys: ['maxDepth'], value: 50, optional: true }], {
      allowPartial: true,
    });
    const listResult = await client.callTool({ name: sceneListTool.name, arguments: listArgs });
    if (listResult?.isError) {
      fail(`SC-04 scene.list failed:\n${stringifyToolCallResult(listResult)}`);
    }
    const listPayload = extractLastJson(listResult);
    if (!JSON.stringify(listPayload ?? {}).includes(markerName)) {
      fail(`SC-04 scene.list does not include marker "${markerName}"`);
    }
    console.log('[SC-04] scene.list includes marker');

    const findArgs = buildArgsFromSchema(assetFindTool, [{ keys: ['path', 'assetPath'], value: scenePath }], {
      allowPartial: true,
    });
    const findResult = await client.callTool({ name: assetFindTool.name, arguments: findArgs });
    if (findResult?.isError) {
      fail(`SC-05 asset.find failed:\n${stringifyToolCallResult(findResult)}`);
    }
    const findPayload = extractLastJson(findResult);
    if (findPayload?.found !== true) {
      fail(`SC-05 expected asset.find found=true:\n${JSON.stringify(findPayload, null, 2)}`);
    }
    console.log('[SC-05] Scene asset found');

    const openArgs = buildArgsFromSchema(
      sceneOpenTool,
      [
        { keys: ['scenePath', 'path'], value: fallbackScenePath },
        { keys: ['additive'], value: false, optional: true },
      ],
      { allowPartial: true }
    );
    ensureNoMissingRequired(sceneOpenTool, openArgs, 'SC-06 scene.open');
    const openResult = await client.callTool({ name: sceneOpenTool.name, arguments: openArgs });
    if (openResult?.isError) {
      fail(`SC-06 scene.open failed:\n${stringifyToolCallResult(openResult)}`);
    }
    console.log('[SC-06] Opened fallback scene');

    const destroyArgs = buildArgsFromSchema(destroyTool, [{ keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: markerName }]);
    await client.callTool({
      name: destroyTool.name,
      arguments: { ...destroyArgs, __confirm: true, __confirmNote: 'e2e-scene-save cleanup marker' },
    }).catch(() => {});

    const deleteArgs = buildArgsFromSchema(assetDeleteTool, [{ keys: ['path', 'assetPath'], value: scenePath }]);
    const deleteResult = await client.callTool({
      name: assetDeleteTool.name,
      arguments: { ...deleteArgs, __confirm: true, __confirmNote: 'e2e-scene-save cleanup scene asset' },
    });
    if (deleteResult?.isError) {
      fail(`SC-07 asset.delete failed:\n${stringifyToolCallResult(deleteResult)}`);
    }
    console.log('[SC-07] Scene asset deleted');

    console.log('[E2E scene save] PASS');
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
