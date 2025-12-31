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

async function runScenario({ unityHttpUrl, bridgeIndexPath, verbose, enableUnsafeInvoke }) {
  const env = {
    ...getDefaultEnvironment(),
    UNITY_HTTP_URL: unityHttpUrl,
    MCP_VERBOSE: verbose ? 'true' : undefined,
    MCP_ENABLE_UNSAFE_EDITOR_INVOKE: enableUnsafeInvoke ? 'true' : undefined,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }

  const client = new Client(
    {
      name: `unity-mcp-bridge-e2e-invoke-safety-${enableUnsafeInvoke ? 'unsafe-on' : 'unsafe-off'}`,
      version: '1.0.0',
    },
    { capabilities: {} }
  );
  const transport = new StdioClientTransport({ command: 'node', args: [bridgeIndexPath], env });

  try {
    await client.connect(transport);

    const toolList = await client.listTools();
    const tools = toolList?.tools ?? [];

    const invokeTool = tools.find((tool) => tool.name === 'unity.editor.invokeStaticMethod') ?? null;
    const listMenuItemsTool = requireTool(tools, 'unity.editor.listMenuItems', /listMenuItems/i);

    // INV-01: tools/list hides invoke by default
    if (!enableUnsafeInvoke) {
      if (invokeTool) {
        fail('INV-01 expected unity.editor.invokeStaticMethod to be hidden, but it is present in tools/list.');
      }
      console.log('[INV-01] invokeStaticMethod hidden (default OFF)');
    } else {
      if (!invokeTool) {
        fail('INV-01 expected unity.editor.invokeStaticMethod to be visible when unsafe is enabled.');
      }
      console.log('[INV-01] invokeStaticMethod visible (unsafe ON)');
    }

    // INV-03: listMenuItems works (safe override) and includes MCP/Server/Start
    const listArgs = buildArgsFromSchema(listMenuItemsTool, [{ keys: ['filter'], value: 'MCP', optional: true }], {
      allowPartial: true,
    });
    const menuItemsResult = await client.callTool({ name: listMenuItemsTool.name, arguments: listArgs });
    if (menuItemsResult?.isError) {
      fail(`INV-03 unity.editor.listMenuItems failed:\n${stringifyToolCallResult(menuItemsResult)}`);
    }
    const menuText = stringifyToolCallResult(menuItemsResult);
    if (!menuText.includes('MCP/Server/Start')) {
      fail(`INV-03 expected listMenuItems to include MCP/Server/Start, got:\n${menuText}`);
    }
    console.log('[INV-03] listMenuItems OK (contains MCP/Server/Start)');

    if (!enableUnsafeInvoke) {
      // INV-02: direct call is blocked with enable instructions
      const direct = await client.callTool({
        name: 'unity.editor.invokeStaticMethod',
        arguments: { typeName: 'System.String', methodName: 'Copy', parameters: ['x'] },
      });
      if (!direct?.isError) {
        fail(`INV-02 expected invokeStaticMethod to be blocked, but it succeeded:\n${stringifyToolCallResult(direct)}`);
      }
      const text = stringifyToolCallResult(direct);
      if (!text.includes('MCP_ENABLE_UNSAFE_EDITOR_INVOKE=true') || !text.includes('__confirm: true')) {
        fail(`INV-02 expected enable instructions in error message, got:\n${text}`);
      }
      console.log('[INV-02] direct invokeStaticMethod blocked with instructions');
      return;
    }

    // INV-04: unsafe ON still requires __confirm
    const withoutConfirm = await client.callTool({
      name: 'unity.editor.invokeStaticMethod',
      arguments: {
        typeName: 'UniMCP4CC.Editor.McpMenuItemLister',
        methodName: 'ListMenuItemsBase64',
        parameters: ['MCP'],
      },
    });
    if (!withoutConfirm?.isError) {
      fail(`INV-04 expected invokeStaticMethod without __confirm to be blocked, but it succeeded:\n${stringifyToolCallResult(withoutConfirm)}`);
    }
    const blockedText = stringifyToolCallResult(withoutConfirm);
    if (!blockedText.includes('__confirm')) {
      fail(`INV-04 expected confirm-required message, got:\n${blockedText}`);
    }
    console.log('[INV-04] invokeStaticMethod requires __confirm even when enabled');

    const withConfirm = await client.callTool({
      name: 'unity.editor.invokeStaticMethod',
      arguments: {
        typeName: 'UniMCP4CC.Editor.McpMenuItemLister',
        methodName: 'ListMenuItemsBase64',
        parameters: ['MCP'],
        __confirm: true,
        __confirmNote: 'e2e-invoke-safety INV-04',
      },
    });
    if (withConfirm?.isError) {
      fail(`INV-04 invokeStaticMethod with __confirm failed:\n${stringifyToolCallResult(withConfirm)}`);
    }
    console.log('[INV-04] invokeStaticMethod executes with __confirm');
  } finally {
    await client.close().catch(() => {});
  }
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

  await runScenario({ unityHttpUrl, bridgeIndexPath, verbose: options.verbose, enableUnsafeInvoke: false });
  await runScenario({ unityHttpUrl, bridgeIndexPath, verbose: options.verbose, enableUnsafeInvoke: true });

  console.log('[E2E invoke safety] PASS');
}

main().catch((error) => {
  if (!process.exitCode) {
    process.exitCode = 1;
  }
  console.error(error?.stack || String(error));
});

