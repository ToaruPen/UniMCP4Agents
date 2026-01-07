#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const util = await import(pathToFileURL(path.join(process.cwd(), 'scripts/_e2eUtil.js')));
const {
  buildArgsFromSchema,
  buildBridgeEnv,
  extractLastJson,
  fail,
  readRuntimeConfig,
  requireSingleToolByFilter,
  requireTool,
  stringifyToolCallResult,
} = util;

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

async function callToolExpectOk(client, tool, args, label) {
  const result = await client.callTool({ name: tool.name, arguments: args });
  if (result?.isError) {
    fail(`${label} failed:\n${stringifyToolCallResult(result)}`);
  }
  return result;
}

async function callToolAllowExists(client, tool, args, label) {
  const result = await client.callTool({ name: tool.name, arguments: args });
  if (!result?.isError) {
    return result;
  }
  const text = stringifyToolCallResult(result);
  if (/already exists/i.test(text)) {
    console.log(`[Skip] ${label}: already exists`);
    return result;
  }
  fail(`${label} failed:\n${text}`);
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

  const env = buildBridgeEnv({ unityHttpUrl, verbose: options.verbose });
  const bridgeIndexPath = path.resolve('index.js');

  const client = new Client({ name: 'unity-mcp-manual-ops', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: 'node', args: [bridgeIndexPath], env });

  const runId = Date.now();
  const rootFolder = 'Assets/McpManual';
  const sceneFolder = `${rootFolder}/Scenes`;
  const prefabFolder = `${rootFolder}/Prefabs`;
  const materialFolder = `${rootFolder}/Materials`;

  const sceneName = `McpManualScene_${runId}`;
  const scenePath = `${sceneFolder}/${sceneName}.unity`;

  const rootName = `McpRoot_${runId}`;
  const environmentName = `McpEnvironment_${runId}`;
  const actorsName = `McpActors_${runId}`;
  const runtimeName = `McpRuntime_${runId}`;

  const playerName = `McpPlayer_${runId}`;
  const enemyName = `McpEnemy_${runId}`;
  const emptyMarkerName = `McpEmpty_${runId}`;
  const tempDeleteName = `McpTemp_Delete_${runId}`;
  const referencesName = `McpReferences_${runId}`;

  const playerPrefabPath = `${prefabFolder}/${playerName}.prefab`;
  const materialPath = `${materialFolder}/McpManualMat_${runId}.mat`;
  const tempMaterialPath = `${materialFolder}/McpTempMat_${runId}.mat`;

  try {
    await client.connect(transport);

    const toolList = await client.listTools();
    const tools = toolList?.tools ?? [];

    const assetCreateFolderTool = requireTool(tools, 'unity.asset.createFolder', /asset\.createFolder/i);
    const assetListTool = requireTool(tools, 'unity.asset.list', /asset\.list/i);
    const assetFindTool = requireTool(tools, 'unity.asset.find', /asset\.find/i);
    const assetDeleteTool = requireTool(tools, 'unity.asset.delete', /asset\.delete/i);
    const assetCreateMaterialTool = requireTool(tools, 'unity.asset.createMaterial', /asset\.createMaterial/i);

    const sceneNewTool = requireTool(tools, 'unity.scene.new', /^unity\.scene\.(new|create)$/i);
    const sceneSaveTool = requireTool(tools, 'unity.scene.save', /^unity\.scene\.save$/i);
    const sceneOpenTool = requireTool(tools, 'unity.scene.open', /^unity\.scene\.open$/i);
    const sceneListTool = requireTool(tools, 'unity.scene.list', /^unity\.scene\.list$/i);

    const createTool = requireTool(tools, 'unity.create', /create/i);
    const createEmptySafeTool = tools.find((tool) => tool.name === 'unity.gameObject.createEmptySafe') ?? null;

    const setParentTool =
      tools.find((tool) => /^unity\.(gameObject|gameobject)\./i.test(tool.name) && /setParent/i.test(tool.name)) ??
      tools.find((tool) => /^unity\.transform\./i.test(tool.name) && /setParent/i.test(tool.name));
    if (!setParentTool) {
      fail('Unable to find a setParent tool (unity.gameObject.setParent or unity.transform.setParent).');
    }

    const setPositionTool =
      tools.find((tool) => /^unity\.transform\./i.test(tool.name) && /setPosition/i.test(tool.name)) ??
      requireSingleToolByFilter(tools, (tool) => /setPosition/i.test(tool.name), 'transform setPosition');

    const addComponentTool = pickComponentAddTool(tools);
    const setSerializedPropertyTool = requireTool(tools, 'unity.component.setSerializedProperty', /setserializedproperty/i);
    const setReferenceTool = requireTool(tools, 'unity.component.setReference', /setreference/i);

    const prefabCreateTool = requireTool(tools, 'unity.prefab.create', /^unity\.prefab\.create$/i);

    const destroyTool = requireSingleToolByFilter(
      tools,
      (tool) => /^unity\.(gameObject|gameobject)\./i.test(tool.name) && /destroy/i.test(tool.name),
      'GameObject destroy'
    );

    console.log('[Step] Folder structure');
    const folders = [rootFolder, sceneFolder, prefabFolder, materialFolder];
    for (const folderPath of folders) {
      const parent = path.posix.dirname(folderPath);
      const name = path.posix.basename(folderPath);
      const props = assetCreateFolderTool?.inputSchema?.properties ?? {};
      let createArgs = {};
      if (props.path) {
        createArgs = { path: folderPath };
      } else {
        const args = [];
        if (props.parentFolder) {
          args.push({ keys: ['parentFolder'], value: parent });
        } else if (props.parentPath) {
          args.push({ keys: ['parentPath'], value: parent });
        }
        if (props.newFolderName) {
          args.push({ keys: ['newFolderName'], value: name });
        } else if (props.name) {
          args.push({ keys: ['name'], value: name });
        } else if (props.folderName) {
          args.push({ keys: ['folderName'], value: name });
        }
        createArgs = buildArgsFromSchema(assetCreateFolderTool, args, { allowPartial: true });
        ensureNoMissingRequired(assetCreateFolderTool, createArgs, 'asset.createFolder');
      }
      await callToolAllowExists(client, assetCreateFolderTool, createArgs, `Create folder ${folderPath}`);
    }

    console.log('[Step] Scene create + save');
    const sceneNewArgs = buildArgsFromSchema(
      sceneNewTool,
      [
        { keys: ['sceneName', 'name'], value: sceneName },
        { keys: ['savePath'], value: sceneFolder, optional: true },
        { keys: ['setupType'], value: 'DefaultGameObjects', optional: true },
      ],
      { allowPartial: true }
    );
    ensureNoMissingRequired(sceneNewTool, sceneNewArgs, 'scene.new');
    await callToolExpectOk(client, sceneNewTool, sceneNewArgs, 'scene.new');

    const sceneSaveArgs = buildArgsFromSchema(
      sceneSaveTool,
      [{ keys: ['scenePath', 'path'], value: scenePath }],
      { allowPartial: true }
    );
    ensureNoMissingRequired(sceneSaveTool, sceneSaveArgs, 'scene.save');
    await callToolExpectOk(client, sceneSaveTool, sceneSaveArgs, 'scene.save');

    console.log('[Step] Create hierarchy');
    async function createEmpty(name) {
      if (createEmptySafeTool) {
        const args = buildArgsFromSchema(createEmptySafeTool, [{ keys: ['name'], value: name }], { allowPartial: true });
        ensureNoMissingRequired(createEmptySafeTool, args, 'createEmptySafe');
        await callToolExpectOk(client, createEmptySafeTool, args, `createEmptySafe ${name}`);
        return;
      }
      fail('createEmptySafe not available; cannot create empty GameObject safely.');
    }

    await createEmpty(rootName);
    await createEmpty(environmentName);
    await createEmpty(actorsName);
    await createEmpty(runtimeName);
    await createEmpty(emptyMarkerName);
    await createEmpty(referencesName);

    async function setParent(child, parent) {
      const args = buildArgsFromSchema(
        setParentTool,
        [
          { keys: ['path', 'gameObjectPath', 'childPath', 'targetPath'], value: child },
          { keys: ['parentPath', 'newParentPath', 'parent'], value: parent },
        ],
        { allowPartial: true }
      );
      ensureNoMissingRequired(setParentTool, args, 'setParent');
      await callToolExpectOk(client, setParentTool, args, `setParent ${child} -> ${parent}`);
    }

    await setParent(environmentName, rootName);
    await setParent(actorsName, rootName);
    await setParent(runtimeName, rootName);
    await setParent(emptyMarkerName, runtimeName);
    await setParent(referencesName, runtimeName);

    console.log('[Step] Create objects + place');
    const createPlayerArgs = buildArgsFromSchema(createTool, [
      { keys: ['primitiveType', 'type'], value: 'Cube' },
      { keys: ['name', 'gameObjectName', 'objectName'], value: playerName },
    ]);
    await callToolExpectOk(client, createTool, createPlayerArgs, 'create player');
    await setParent(playerName, actorsName);

    const createEnemyArgs = buildArgsFromSchema(createTool, [
      { keys: ['primitiveType', 'type'], value: 'Sphere' },
      { keys: ['name', 'gameObjectName', 'objectName'], value: enemyName },
    ]);
    await callToolExpectOk(client, createTool, createEnemyArgs, 'create enemy');
    await setParent(enemyName, actorsName);

    const setPlayerPosArgs = buildArgsFromSchema(
      setPositionTool,
      [
        { keys: ['path', 'gameObjectPath', 'targetPath'], value: playerName },
        { keys: ['x'], value: 0 },
        { keys: ['y'], value: 0 },
        { keys: ['z'], value: 0 },
      ],
      { allowPartial: true }
    );
    ensureNoMissingRequired(setPositionTool, setPlayerPosArgs, 'setPosition');
    await callToolExpectOk(client, setPositionTool, setPlayerPosArgs, 'setPosition player');

    const setEnemyPosArgs = buildArgsFromSchema(
      setPositionTool,
      [
        { keys: ['path', 'gameObjectPath', 'targetPath'], value: enemyName },
        { keys: ['x'], value: 3 },
        { keys: ['y'], value: 0 },
        { keys: ['z'], value: 0 },
      ],
      { allowPartial: true }
    );
    ensureNoMissingRequired(setPositionTool, setEnemyPosArgs, 'setPosition');
    await callToolExpectOk(client, setPositionTool, setEnemyPosArgs, 'setPosition enemy');

    console.log('[Step] Add components + edit data');
    const addRigidbodyArgs = buildArgsFromSchema(
      addComponentTool,
      [
        { keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: playerName },
        { keys: ['componentType', 'type', 'name'], value: 'Rigidbody' },
      ],
      { allowPartial: true }
    );
    await callToolExpectOk(client, addComponentTool, addRigidbodyArgs, 'add Rigidbody');

    const addCompileTestArgs = buildArgsFromSchema(
      addComponentTool,
      [
        { keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: playerName },
        { keys: ['componentType', 'type', 'name'], value: 'McpCompileTest' },
      ],
      { allowPartial: true }
    );
    await callToolExpectOk(client, addComponentTool, addCompileTestArgs, 'add McpCompileTest');

    const setValueArgs = buildArgsFromSchema(
      setSerializedPropertyTool,
      [
        { keys: ['gameObjectPath', 'path'], value: playerName },
        { keys: ['componentType', 'type'], value: 'McpCompileTest' },
        { keys: ['propertyPath', 'fieldPath'], value: 'Value' },
        { keys: ['value'], value: '42' },
      ],
      { allowPartial: true }
    );
    await callToolExpectOk(client, setSerializedPropertyTool, setValueArgs, 'set McpCompileTest.Value');

    const addReferenceArgs = buildArgsFromSchema(
      addComponentTool,
      [
        { keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: referencesName },
        { keys: ['componentType', 'type', 'name'], value: 'SetReferenceFixture' },
      ],
      { allowPartial: true }
    );
    await callToolExpectOk(client, addComponentTool, addReferenceArgs, 'add SetReferenceFixture');

    console.log('[Step] Create assets + references');
    const createMaterialArgs = buildArgsFromSchema(assetCreateMaterialTool, [
      { keys: ['path', 'assetPath'], value: materialPath },
    ]);
    await callToolExpectOk(client, assetCreateMaterialTool, createMaterialArgs, 'create material');

    const createTempMaterialArgs = buildArgsFromSchema(assetCreateMaterialTool, [
      { keys: ['path', 'assetPath'], value: tempMaterialPath },
    ]);
    await callToolExpectOk(client, assetCreateMaterialTool, createTempMaterialArgs, 'create temp material');

    const setTargetRefArgs = buildArgsFromSchema(
      setReferenceTool,
      [
        { keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: referencesName },
        { keys: ['componentType', 'type'], value: 'SetReferenceFixture' },
        { keys: ['fieldName', 'propertyName', 'memberName'], value: 'target' },
        { keys: ['referencePath', 'targetPath', 'refPath'], value: playerName },
      ],
      { allowPartial: true }
    );
    await callToolExpectOk(client, setReferenceTool, setTargetRefArgs, 'set SetReferenceFixture.target');

    const setMaterialRefArgs = buildArgsFromSchema(
      setReferenceTool,
      [
        { keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: referencesName },
        { keys: ['componentType', 'type'], value: 'SetReferenceFixture' },
        { keys: ['fieldName', 'propertyName', 'memberName'], value: 'material' },
        { keys: ['referencePath', 'targetPath', 'refPath'], value: materialPath },
      ],
      { allowPartial: true }
    );
    await callToolExpectOk(client, setReferenceTool, setMaterialRefArgs, 'set SetReferenceFixture.material');

    console.log('[Step] Prefab create');
    const prefabCreateArgs = buildArgsFromSchema(
      prefabCreateTool,
      [
        { keys: ['gameObjectPath', 'path'], value: playerName },
        { keys: ['prefabPath', 'path'], value: playerPrefabPath },
      ],
      { allowPartial: true }
    );
    await callToolExpectOk(client, prefabCreateTool, prefabCreateArgs, 'prefab.create');

    console.log('[Step] File search / list');
    const listArgs = buildArgsFromSchema(
      assetListTool,
      [
        { keys: ['path', 'assetPath', 'folder'], value: rootFolder },
        { keys: ['assetType'], value: 'Object' },
        { keys: ['recursive', 'includeSubfolders', 'deep'], value: true, optional: true },
      ],
      { allowPartial: true }
    );
    const listResult = await callToolExpectOk(client, assetListTool, listArgs, 'asset.list');
    const listPayload = extractLastJson(listResult);
    console.log('[asset.list] entries:', Array.isArray(listPayload?.assets) ? listPayload.assets.length : 'unknown');

    const findSceneArgs = buildArgsFromSchema(assetFindTool, [{ keys: ['path', 'assetPath'], value: scenePath }], { allowPartial: true });
    await callToolExpectOk(client, assetFindTool, findSceneArgs, 'asset.find scene');

    const findPrefabArgs = buildArgsFromSchema(assetFindTool, [{ keys: ['path', 'assetPath'], value: playerPrefabPath }], { allowPartial: true });
    await callToolExpectOk(client, assetFindTool, findPrefabArgs, 'asset.find prefab');

    console.log('[Step] Empty GameObject search');
    const sceneListArgs = buildArgsFromSchema(sceneListTool, [{ keys: ['maxDepth'], value: 50, optional: true }], { allowPartial: true });
    const sceneListResult = await callToolExpectOk(client, sceneListTool, sceneListArgs, 'scene.list');
    const scenePayload = extractLastJson(sceneListResult);
    const rootObjects = scenePayload?.rootObjects ?? scenePayload?.objects ?? [];
    const nodes = flattenSceneNodes(rootObjects);
    const emptyObjects = nodes.filter((node) => Array.isArray(node.components) && node.components.length === 1 && node.components[0] === 'Transform');
    const emptyLeaf = emptyObjects.filter((node) => {
      const childCount = Number.isFinite(node.childCount) ? node.childCount : Array.isArray(node.children) ? node.children.length : 0;
      return childCount === 0;
    });
    const emptyNames = emptyLeaf.map((node) => node.path ?? node.name ?? '(unnamed)');
    console.log('[Empty objects] count:', emptyLeaf.length);
    console.log('[Empty objects] sample:', emptyNames.slice(0, 10));
    if (!emptyNames.some((name) => String(name).includes(emptyMarkerName))) {
      fail(`Expected empty marker ${emptyMarkerName} to be listed in empty GameObject search.`);
    }

    console.log('[Step] Delete temp objects / files');
    const createTempArgs = buildArgsFromSchema(createTool, [
      { keys: ['primitiveType', 'type'], value: 'Cube' },
      { keys: ['name', 'gameObjectName', 'objectName'], value: tempDeleteName },
    ]);
    await callToolExpectOk(client, createTool, createTempArgs, 'create temp delete object');
    await setParent(tempDeleteName, runtimeName);

    const destroyTempArgs = buildArgsFromSchema(
      destroyTool,
      [{ keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: tempDeleteName }],
      { allowPartial: true }
    );
    await client.callTool({
      name: destroyTool.name,
      arguments: { ...destroyTempArgs, __confirm: true, __confirmNote: 'manual ops delete temp object' },
    });

    const deleteMatArgs = buildArgsFromSchema(assetDeleteTool, [{ keys: ['path', 'assetPath'], value: tempMaterialPath }], { allowPartial: true });
    await client.callTool({
      name: assetDeleteTool.name,
      arguments: { ...deleteMatArgs, __confirm: true, __confirmNote: 'manual ops delete temp material' },
    });

    console.log('[Step] Save scene');
    await callToolExpectOk(client, sceneSaveTool, sceneSaveArgs, 'scene.save');

    console.log('[Step] Optional: open scene to verify');
    const sceneOpenArgs = buildArgsFromSchema(
      sceneOpenTool,
      [
        { keys: ['scenePath', 'path'], value: scenePath },
        { keys: ['additive'], value: false, optional: true },
      ],
      { allowPartial: true }
    );
    ensureNoMissingRequired(sceneOpenTool, sceneOpenArgs, 'scene.open');
    await callToolExpectOk(client, sceneOpenTool, sceneOpenArgs, 'scene.open');

    console.log('[Manual ops] PASS');
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
