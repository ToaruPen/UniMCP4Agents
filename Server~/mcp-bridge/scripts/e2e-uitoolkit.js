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

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function callToolWithRetry(client, name, args, { attempts = 30, delayMs = 500, label } = {}) {
  let lastErrorText = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await client.callTool({ name, arguments: args });
    if (!result?.isError) {
      return result;
    }
    lastErrorText = stringifyToolCallResult(result);
    await sleep(delayMs);
  }

  fail(`${label ?? name} failed after ${attempts} attempts:\n${lastErrorText ?? '(no error text)'}`);
}

function assertSchemaHasProperty(tool, propertyName, label) {
  const props = tool?.inputSchema?.properties;
  if (!props || typeof props !== 'object' || !Object.prototype.hasOwnProperty.call(props, propertyName)) {
    fail(`${label}: expected schema to include '${propertyName}', got:\n${JSON.stringify(tool?.inputSchema ?? null, null, 2)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  if (!options.unityProjectRoot) {
    fail(`--project "/path/to/UnityProject" is required for this E2E.`);
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

  const client = new Client({ name: 'unity-mcp-bridge-e2e-uitoolkit', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: 'node', args: [bridgeIndexPath], env });

  const runId = Date.now();
  const folder = 'Assets/McpE2E/UIToolkit';
  const uxmlPath = `${folder}/UITK_${runId}.uxml`;
  const ussPath = `${folder}/UITK_${runId}.uss`;
  const panelSettingsPath = `${folder}/UITK_${runId}.asset`;
  const gameObjectName = `UITK_Doc_${runId}`;
  const labelName = 'HPLabel';

  let createdGameObjectPath = null;
  let playStarted = false;
  let destroyTool = null;
  let assetDeleteTool = null;

  try {
    await client.connect(transport);

    const toolList = await client.listTools();
    const tools = toolList?.tools ?? [];

    const createUxmlTool = requireTool(tools, 'unity.uitoolkit.asset.createUxml', /uitoolkit.*createUxml/i);
    const updateUxmlTool = requireTool(tools, 'unity.uitoolkit.asset.updateUxml', /uitoolkit.*updateUxml/i);
    const createUssTool = requireTool(tools, 'unity.uitoolkit.asset.createUss', /uitoolkit.*createUss/i);
    const updateUssTool = requireTool(tools, 'unity.uitoolkit.asset.updateUss', /uitoolkit.*updateUss/i);
    const linkStyleSheetTool = requireTool(tools, 'unity.uitoolkit.asset.linkStyleSheet', /uitoolkit.*linkStyleSheet/i);
    const createPanelSettingsTool = requireTool(tools, 'unity.uitoolkit.asset.createPanelSettings', /uitoolkit.*createPanelSettings/i);

    const createUiGameObjectTool = requireTool(tools, 'unity.uitoolkit.scene.createUIGameObject', /uitoolkit.*createUIGameObject/i);
    const configureUiDocumentTool = requireTool(tools, 'unity.uitoolkit.scene.configureUIDocument', /uitoolkit.*configureUIDocument/i);

    const getUiDocumentTool = requireTool(tools, 'unity.uitoolkit.runtime.getUIDocument', /uitoolkit.*getUIDocument/i);
    const queryElementTool = requireTool(tools, 'unity.uitoolkit.runtime.queryElement', /uitoolkit.*queryElement/i);
    const setElementTextTool = requireTool(tools, 'unity.uitoolkit.runtime.setElementText', /uitoolkit.*setElementText/i);

    const playTool = requireTool(tools, 'unity.editor.play', /^unity\.editor\.play$/i);
    const stopTool = requireTool(tools, 'unity.editor.stop', /^unity\.editor\.stop$/i);

    destroyTool = requireSingleToolByFilter(
      tools,
      (tool) => /^unity\.(gameObject|gameobject)\./i.test(tool.name) && /destroy/i.test(tool.name),
      'GameObject destroy'
    );
    assetDeleteTool = requireTool(tools, 'unity.asset.delete', /^unity\.asset\.delete$/i);

    // Schema sanity: runtime tools should expose selector (bridge patches schemas for better UX).
    assertSchemaHasProperty(queryElementTool, 'selector', 'UITK-01 queryElement schema');
    assertSchemaHasProperty(setElementTextTool, 'selector', 'UITK-01 setElementText schema');
    assertSchemaHasProperty(configureUiDocumentTool, 'uxmlPath', 'UITK-01 configureUIDocument schema');
    assertSchemaHasProperty(configureUiDocumentTool, 'panelSettingsPath', 'UITK-01 configureUIDocument schema');
    console.log('[UITK-01] schema OK (selector + UIDocument config props exposed)');

    // Create assets.
    const createUxmlArgs = buildArgsFromSchema(createUxmlTool, [{ keys: ['path'], value: uxmlPath }]);
    const createUxmlResult = await client.callTool({ name: createUxmlTool.name, arguments: createUxmlArgs });
    if (createUxmlResult?.isError) {
      fail(`UITK-02 createUxml failed:\n${stringifyToolCallResult(createUxmlResult)}`);
    }

    const uxmlContent =
      `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n` +
      `  <ui:VisualElement name="Root">\n` +
      `    <ui:Label name="${labelName}" text="HP: 10" />\n` +
      `  </ui:VisualElement>\n` +
      `</ui:UXML>\n`;
    const updateUxmlArgs = buildArgsFromSchema(updateUxmlTool, [
      { keys: ['path'], value: uxmlPath },
      { keys: ['content'], value: uxmlContent },
    ]);
    const updateUxmlResult = await client.callTool({ name: updateUxmlTool.name, arguments: updateUxmlArgs });
    if (updateUxmlResult?.isError) {
      fail(`UITK-02 updateUxml failed:\n${stringifyToolCallResult(updateUxmlResult)}`);
    }

    const createUssArgs = buildArgsFromSchema(createUssTool, [
      { keys: ['path'], value: ussPath },
      { keys: ['theme'], value: 'game', optional: true },
    ]);
    const createUssResult = await client.callTool({ name: createUssTool.name, arguments: createUssArgs });
    if (createUssResult?.isError) {
      fail(`UITK-02 createUss failed:\n${stringifyToolCallResult(createUssResult)}`);
    }

    const ussContent = `#${labelName} { color: red; }\n`;
    const updateUssArgs = buildArgsFromSchema(updateUssTool, [
      { keys: ['path'], value: ussPath },
      { keys: ['content'], value: ussContent },
    ]);
    const updateUssResult = await client.callTool({ name: updateUssTool.name, arguments: updateUssArgs });
    if (updateUssResult?.isError) {
      fail(`UITK-02 updateUss failed:\n${stringifyToolCallResult(updateUssResult)}`);
    }

    const linkArgs = buildArgsFromSchema(linkStyleSheetTool, [
      { keys: ['uxmlPath'], value: uxmlPath },
      { keys: ['ussPath'], value: ussPath },
    ]);
    const linkResult = await client.callTool({ name: linkStyleSheetTool.name, arguments: linkArgs });
    if (linkResult?.isError) {
      fail(`UITK-02 linkStyleSheet failed:\n${stringifyToolCallResult(linkResult)}`);
    }

    const createPanelArgs = buildArgsFromSchema(createPanelSettingsTool, [{ keys: ['path'], value: panelSettingsPath }]);
    const createPanelResult = await client.callTool({ name: createPanelSettingsTool.name, arguments: createPanelArgs });
    if (createPanelResult?.isError) {
      fail(`UITK-02 createPanelSettings failed:\n${stringifyToolCallResult(createPanelResult)}`);
    }

    console.log('[UITK-02] created UXML/USS/PanelSettings');

    // Create UI GO + configure UIDocument.
    const createGoArgs = buildArgsFromSchema(createUiGameObjectTool, [{ keys: ['name'], value: gameObjectName }]);
    const createGoResult = await client.callTool({ name: createUiGameObjectTool.name, arguments: createGoArgs });
    if (createGoResult?.isError) {
      fail(`UITK-03 createUIGameObject failed:\n${stringifyToolCallResult(createGoResult)}`);
    }
    createdGameObjectPath = extractLastJson(createGoResult)?.path ?? gameObjectName;

    const configureArgs = buildArgsFromSchema(
      configureUiDocumentTool,
      [{ keys: ['gameObjectPath', 'gameObject', 'path'], value: createdGameObjectPath }],
      { allowPartial: true }
    );
    const configureResult = await client.callTool({
      name: configureUiDocumentTool.name,
      arguments: { ...configureArgs, uxmlPath, panelSettingsPath, sortingOrder: 0 },
    });
    if (configureResult?.isError) {
      fail(`UITK-03 configureUIDocument failed:\n${stringifyToolCallResult(configureResult)}`);
    }

    const infoArgs = buildArgsFromSchema(getUiDocumentTool, [{ keys: ['gameObjectPath', 'gameObject'], value: createdGameObjectPath }]);
    const infoResult = await client.callTool({ name: getUiDocumentTool.name, arguments: infoArgs });
    if (infoResult?.isError) {
      fail(`UITK-03 getUIDocument failed:\n${stringifyToolCallResult(infoResult)}`);
    }
    console.log('[UITK-03] UIDocument configured');

    // Enter play mode (runtime API tests).
    const playArgs = buildArgsFromSchema(playTool, [], { allowPartial: true });
    const playResult = await client.callTool({ name: playTool.name, arguments: playArgs });
    if (playResult?.isError) {
      fail(`UITK-04 play failed:\n${stringifyToolCallResult(playResult)}`);
    }
    playStarted = true;

    // Let the UI initialize (and tolerate transient reloads).
    await sleep(750);

    // UITK-04: query by legacy key `query` (bridge should normalize to selector).
    const queryArgs = buildArgsFromSchema(queryElementTool, [{ keys: ['gameObjectPath', 'gameObject'], value: createdGameObjectPath }], {
      allowPartial: true,
    });
    const queryResult = await callToolWithRetry(
      client,
      queryElementTool.name,
      { ...queryArgs, query: `#${labelName}` },
      { attempts: 40, delayMs: 250, label: 'UITK-04 queryElement' }
    );
    if (queryResult?.isError) {
      fail(`UITK-04 queryElement failed:\n${stringifyToolCallResult(queryResult)}`);
    }
    console.log('[UITK-04] queryElement OK');

    // UITK-05: set text by legacy key `elementName` (bridge should normalize to selector).
    const setArgs = buildArgsFromSchema(
      setElementTextTool,
      [
        { keys: ['gameObjectPath', 'gameObject'], value: createdGameObjectPath },
        { keys: ['text'], value: 'HP: 7' },
      ],
      { allowPartial: true }
    );
    const setResult = await callToolWithRetry(
      client,
      setElementTextTool.name,
      { ...setArgs, elementName: labelName },
      { attempts: 40, delayMs: 250, label: 'UITK-05 setElementText' }
    );
    if (setResult?.isError) {
      fail(`UITK-05 setElementText failed:\n${stringifyToolCallResult(setResult)}`);
    }
    console.log('[UITK-05] setElementText OK');

    console.log('[E2E UIToolkit] PASS');
  } finally {
    // Best-effort cleanup.
    try {
      if (playStarted) {
        await client
          .callTool({ name: 'unity.editor.stop', arguments: {} })
          .catch(() => {});
      }

      if (createdGameObjectPath && destroyTool) {
        const destroyArgs = buildArgsFromSchema(
          destroyTool,
          [{ keys: ['path', 'gameObjectPath', 'hierarchyPath'], value: createdGameObjectPath }],
          { allowPartial: true }
        );
        await client
          .callTool({
            name: destroyTool.name,
            arguments: { ...destroyArgs, __confirm: true, __confirmNote: 'e2e-uitoolkit cleanup GO' },
          })
          .catch(() => {});
      }

      if (assetDeleteTool) {
        for (const assetPathValue of [uxmlPath, ussPath, panelSettingsPath]) {
          const deleteArgs = buildArgsFromSchema(
            assetDeleteTool,
            [{ keys: ['path', 'assetPath'], value: assetPathValue }],
            { allowPartial: true }
          );
          await client
            .callTool({
              name: assetDeleteTool.name,
              arguments: { ...deleteArgs, __confirm: true, __confirmNote: 'e2e-uitoolkit cleanup assets' },
            })
            .catch(() => {});
        }
      }
    } catch {
      // Ignore cleanup errors; the test project may be left with artifacts.
    }

    await client.close().catch(() => {});
  }
}

main().catch((error) => {
  if (!process.exitCode) {
    process.exitCode = 1;
  }
  console.error(error?.stack || String(error));
});
