#!/usr/bin/env node
/**
 * Unity MCP Bridge Server
 *
 * This server bridges MCP clients (stdio) and Unity Editor via MCP protocol.
 * No external dependencies required (uses Node.js built-in fetch API).
 *
 * Requirements: Node.js 18+ (for native fetch support)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import {
  buildTargetResolutionError,
  clampTimeoutMs,
  createBridgeConfig,
  extractGameObjectQuery,
  filterAssetCandidates,
  findAmbiguousName,
  findSceneMatches,
  findTargetIdentifier,
  getConfirmFlags,
  getNonDestructiveAmbiguousTargetWarning,
  truncateUnityLogHistoryPayload,
  getToolTimeoutMs,
  isConfirmationRequiredToolName,
  isLikelyGameObjectTargetToolName,
  isReadOnlyToolName,
  isUnambiguousTargetRequiredToolName,
  normalizeSearchInFolders,
  normalizeUnityArguments,
  parseUnityAssetFilter,
} from './lib/bridgeLogic.js';

/**
 * Loads Unity HTTP port from .unity-mcp-runtime.json
 * Falls back to environment variable or default port
 */
const RUNTIME_CONFIG_FILENAME = '.unity-mcp-runtime.json';
const DEFAULT_UNITY_HTTP_URL = 'http://localhost:5051';
const MENU_ITEM_LISTER_TYPE = 'UniMCP4CC.Editor.McpMenuItemLister';
const MENU_ITEM_LISTER_METHOD = 'ListMenuItemsBase64';
const ASSET_IMPORT_TYPE = 'UniMCP4CC.Editor.McpAssetImport';
const ASSET_IMPORT_SET_TEXTURE_TYPE_METHOD = 'SetTextureTypeBase64';
const ASSET_IMPORT_SET_SPRITE_REFERENCE_METHOD = 'SetSpriteReferenceBase64';
const ASSET_IMPORT_LIST_SPRITES_METHOD = 'ListSpritesBase64';

const BRIDGE_CONFIG = createBridgeConfig(process.env);
const DEFAULT_TOOL_TIMEOUT_MS = BRIDGE_CONFIG.defaultToolTimeoutMs;
const HEAVY_TOOL_TIMEOUT_MS = BRIDGE_CONFIG.heavyToolTimeoutMs;
const MAX_TOOL_TIMEOUT_MS = BRIDGE_CONFIG.maxToolTimeoutMs;
const REQUIRE_CONFIRMATION = BRIDGE_CONFIG.requireConfirmation;
const REQUIRE_UNAMBIGUOUS_TARGETS = BRIDGE_CONFIG.requireUnambiguousTargets;
const SCENE_LIST_MAX_DEPTH = BRIDGE_CONFIG.sceneListMaxDepth;
const AMBIGUOUS_CANDIDATE_LIMIT = BRIDGE_CONFIG.ambiguousCandidateLimit;
const PREFLIGHT_SCENE_LIST_TIMEOUT_MS = BRIDGE_CONFIG.preflightSceneListTimeoutMs;
const ENABLE_UNSAFE_EDITOR_INVOKE = BRIDGE_CONFIG.enableUnsafeEditorInvoke;

function patchUnityToolSchemas(unityTools) {
  return (unityTools || []).map((tool) => {
    if (!tool || typeof tool !== 'object') {
      return tool;
    }

    const name = typeof tool.name === 'string' ? tool.name : '';
    const nameLower = name.toLowerCase();
    let optionalNote = '';
    if (nameLower.startsWith('unity.cinemachine.')) {
      optionalNote = '[Optional] 依存パッケージ: com.unity.cinemachine (Cinemachine). 未導入の場合は呼び出しが失敗します。';
    } else if (nameLower.startsWith('unity.inputsystem.')) {
      optionalNote = '[Optional] 依存パッケージ: com.unity.inputsystem (Input System). 未導入の場合は呼び出しが失敗します。';
    } else if (nameLower.startsWith('unity.probuilder.')) {
      optionalNote = '[Optional] 依存パッケージ: com.unity.probuilder (ProBuilder). 未導入の場合は呼び出しが失敗します。';
    } else if (nameLower.startsWith('unity.recorder.')) {
      optionalNote = '[Optional] 依存パッケージ: com.unity.recorder (Recorder). 未導入の場合は呼び出しが失敗します。';
    } else if (nameLower.startsWith('unity.shadergraph.')) {
      optionalNote = '[Optional] 依存パッケージ: com.unity.shadergraph (Shader Graph). 未導入の場合は呼び出しが失敗します。';
    } else if (nameLower.startsWith('unity.timeline.')) {
      optionalNote = '[Optional] 依存パッケージ: com.unity.timeline (Timeline). 未導入の場合は呼び出しが失敗します。';
    } else if (nameLower.startsWith('unity.compositing.')) {
      optionalNote = '[Optional] 依存拡張: LocalMcp.UnityServer.Compositing.Editor. 未導入の場合は呼び出しが失敗します。';
    } else if (nameLower.startsWith('unity.volume.')) {
      optionalNote = '[Optional] 依存拡張: LocalMcp.UnityServer.Volume.Editor. 未導入の場合は呼び出しが失敗します。';
    } else if (nameLower.startsWith('unity.uitoolkit.')) {
      optionalNote =
        '[Optional] 依存拡張: LocalMcp.UnityServer.UIToolkit.Editor（Samples: UIToolkit Extension を Import）. 未導入の場合は呼び出しが失敗します。';
    } else if (nameLower.startsWith('unity.textmeshpro.')) {
      optionalNote = '[Optional] 依存パッケージ: TextMeshPro. 未導入の場合は呼び出しが失敗します。';
    } else if (nameLower.startsWith('unity.import.')) {
      optionalNote =
        "[Optional] 依存拡張: LocalMcp.UnityServer.AssetImport.Editor. 未導入の場合は呼び出しが失敗します（代替: unity.assetImport.setTextureType）。";
    }

    let nextTool = tool;
    if (optionalNote) {
      const currentDescription = typeof tool.description === 'string' ? tool.description.trim() : '';
      const alreadyAnnotated = currentDescription.includes(optionalNote);
      if (!alreadyAnnotated) {
        nextTool = {
          ...tool,
          description: currentDescription ? `${currentDescription}\n\n${optionalNote}` : optionalNote,
        };
      }
    }

    if (name === 'unity.asset.find') {
      const inputSchema =
        nextTool.inputSchema && typeof nextTool.inputSchema === 'object' ? nextTool.inputSchema : { type: 'object' };
      const properties = inputSchema.properties && typeof inputSchema.properties === 'object' ? inputSchema.properties : {};
      const patchedSchema = {
        ...inputSchema,
        properties: {
          ...properties,
          path: {
            type: 'string',
            description: "アセットパス（bridge互換: Unity実装は path/guid を要求する場合があります）",
          },
          guid: {
            type: 'string',
            description: "アセットGUID（bridge互換: Unity実装は path/guid を要求する場合があります）",
          },
        },
        // Allow either the documented filter-based query, or direct identifiers.
        anyOf: [{ required: ['filter'] }, { required: ['path'] }, { required: ['guid'] }],
      };
      delete patchedSchema.required;

      return {
        ...nextTool,
        inputSchema: patchedSchema,
      };
    }

    if (name === 'unity.asset.list') {
      const inputSchema =
        nextTool.inputSchema && typeof nextTool.inputSchema === 'object' ? nextTool.inputSchema : { type: 'object' };
      const properties = inputSchema.properties && typeof inputSchema.properties === 'object' ? inputSchema.properties : {};
      return {
        ...nextTool,
        inputSchema: {
          ...inputSchema,
          properties: {
            ...properties,
            assetType: {
              type: 'string',
              description: "アセット種別（bridge互換: Unity実装は assetType を要求する場合があります。例: 'Material', 'Scene', 'Prefab', 'Object'）",
            },
          },
        },
      };
    }

    if (name === 'unity.component.setReference') {
      const inputSchema =
        nextTool.inputSchema && typeof nextTool.inputSchema === 'object' ? nextTool.inputSchema : { type: 'object' };
      const properties = inputSchema.properties && typeof inputSchema.properties === 'object' ? inputSchema.properties : {};

      const referenceTypeSchema =
        properties.referenceType && typeof properties.referenceType === 'object'
          ? properties.referenceType
          : { type: 'string' };

      const referencePathSchema =
        properties.referencePath && typeof properties.referencePath === 'object'
          ? properties.referencePath
          : null;

      const required = Array.isArray(inputSchema.required) ? inputSchema.required.filter((key) => key !== 'referenceType') : null;

      const patchedSchema = {
        ...inputSchema,
        properties: {
          ...properties,
          referenceType: {
            ...referenceTypeSchema,
            description:
              "参照種別（例: 'asset' / 'gameObject' / 'component'）。省略時は Bridge が fieldName から推論します（失敗したら明示してください）。",
          },
          ...(referencePathSchema
            ? {
                referencePath: {
                  ...referencePathSchema,
                  description:
                    (typeof referencePathSchema.description === 'string' && referencePathSchema.description.trim().length > 0
                      ? `${referencePathSchema.description}\n\n`
                      : '') +
                    '参照先の GameObject パス（例: "Root/Child"）。曖昧な場合は unity.scene.list で候補の path を取得してください。',
                },
              }
            : {}),
        },
      };

      if (required) {
        patchedSchema.required = required;
      }

      return {
        ...nextTool,
        inputSchema: patchedSchema,
      };
    }

    return nextTool;
  });
}

function buildEmptyAssetResult() {
  return {
    found: false,
    asset: {
      name: '',
      path: '',
      guid: '',
      type: '',
      fileSize: 0,
      lastModified: '',
    },
  };
}

async function tryCallUnityTool(unityHttpUrl, name, args, timeoutMs) {
  const response = await httpPost(
    `${unityHttpUrl}/api/mcp`,
    {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name,
        arguments: args || {},
      },
      id: 2,
    },
    timeoutMs
  );

  if (response?.error) {
    return { ok: false, error: response.error };
  }

  return { ok: true, result: response?.result ?? null };
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
  if (parts.length === 0) {
    return JSON.stringify(result, null, 2);
  }
  return parts.join('\n');
}

function parseInvokeStaticMethodBase64Payload(invokeCall, label) {
  const outerMessage = invokeCall?.result?.message;
  if (typeof outerMessage !== 'string' || outerMessage.trim().length === 0) {
    throw new Error(`Missing message in unity.editor.invokeStaticMethod response (${label})`);
  }

  const outerJson = JSON.parse(outerMessage);
  const base64 = outerJson?.result;
  if (typeof base64 !== 'string' || base64.trim().length === 0) {
    throw new Error(`Missing base64 result from invokeStaticMethod response (${label})`);
  }

  const decoded = Buffer.from(base64, 'base64').toString('utf8');
  const payload = JSON.parse(decoded);
  const isError = payload?.status === 'error';

  return { payload, isError };
}

function looksLikeSpriteReferenceMismatch(args, errorText) {
  const referencePathCandidate =
    typeof args?.referencePath === 'string'
      ? args.referencePath.trim()
      : typeof args?.assetPath === 'string'
        ? args.assetPath.trim()
        : '';
  if (!/^(Assets|Packages)\//.test(referencePathCandidate)) {
    return false;
  }

  const fieldName = typeof args?.fieldName === 'string' ? args.fieldName.trim().toLowerCase() : '';
  const isSpriteFieldName = fieldName.includes('sprite');

  const normalizedError = typeof errorText === 'string' ? errorText.toLowerCase() : '';
  const looksLikeSpriteMismatch =
    normalizedError.includes('expects sprite') ||
    normalizedError.includes('unityengine.sprite') ||
    (normalizedError.includes('sprite') && normalizedError.includes('texture2d')) ||
    (normalizedError.includes('type mismatch') && normalizedError.includes('sprite'));

  return isSpriteFieldName || looksLikeSpriteMismatch;
}

function buildSetReferenceGuidance({ args, attemptedReferenceTypes, lastError, userProvidedReferenceType }) {
  const missingKeys = [];
  const requiredStringKeys = ['path', 'componentType', 'fieldName', 'referencePath'];
  for (const key of requiredStringKeys) {
    const value = args?.[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      missingKeys.push(key);
    }
  }

  const retryTemplate = {
    path: typeof args?.path === 'string' ? args.path : typeof args?.gameObjectPath === 'string' ? args.gameObjectPath : '<SOURCE_PATH>',
    componentType: typeof args?.componentType === 'string' ? args.componentType : '<ComponentType>',
    fieldName: typeof args?.fieldName === 'string' ? args.fieldName : '<fieldName>',
    referencePath: typeof args?.referencePath === 'string' ? args.referencePath : '<TARGET_PATH>',
    referenceType: '<asset|gameObject|component>',
  };

  const headline = `unity.component.setReference guidance`;
  const missingLine = missingKeys.length > 0 ? `Missing/invalid keys: ${missingKeys.join(', ')}\n\n` : '';
  const attemptedLine =
    attemptedReferenceTypes && attemptedReferenceTypes.length > 0
      ? `Tried referenceType candidates: ${attemptedReferenceTypes.join(', ')}\n\n`
      : '';

  const sourceLine = userProvidedReferenceType
    ? 'Note: referenceType was provided explicitly; Bridge does not override it.\n\n'
    : '';

  const spriteHint =
    looksLikeSpriteReferenceMismatch(args, lastError) && typeof args?.fieldName === 'string'
      ? `Sprite fields:\n` +
        `- unity.component.setReference may fail when referencePath points to a texture file (Texture2D main asset) but the field expects Sprite.\n` +
        `- Use the dedicated tools instead (no silent fallback):\n` +
        `  1) unity.assetImport.listSprites { assetPath: \"${typeof args?.referencePath === 'string' ? args.referencePath : 'Assets/Foo.png'}\" }\n` +
        `  2) unity.component.setSpriteReference { path: \"${typeof args?.path === 'string' ? args.path : '<GameObjectPath>'}\", componentType: \"${typeof args?.componentType === 'string' ? args.componentType : '<ComponentType>'}\", fieldName: \"${typeof args?.fieldName === 'string' ? args.fieldName : 'sprite'}\", assetPath: \"${typeof args?.referencePath === 'string' ? args.referencePath : 'Assets/Foo.png'}\", spriteName: \"<pick from spriteNames>\" }\n\n`
      : '';

  const help =
    `${headline}\n\n` +
    `${missingLine}` +
    `${sourceLine}` +
    `referenceType values:\n` +
    `- asset: set an Asset reference (use referencePath like \"Assets/Foo.asset\")\n` +
    `- gameObject: set a GameObject reference\n` +
    `- component: set a Component reference (e.g. Transform, Rigidbody2D)\n\n` +
    `referencePath format:\n` +
    `- Use a hierarchy path (e.g. "Root/Child") when possible.\n` +
    `- If you only have a name, ensure it's unique in the scene.\n` +
    `- Use unity.scene.list to find the exact path.\n\n` +
    `${spriteHint}` +
    `Retry template:\n` +
    `${JSON.stringify(retryTemplate, null, 2)}\n\n` +
    (lastError ? `Last error:\n${lastError}` : '');

  return {
    content: [{ type: 'text', text: help }],
    isError: true,
  };
}

async function handleComponentSetReference(unityHttpUrl, args, timeoutMs, { userProvidedReferenceType } = {}) {
  const baseArgs = args && typeof args === 'object' ? args : {};

  const requested = typeof baseArgs.referenceType === 'string' ? baseArgs.referenceType.trim() : '';
  const inferred = requested.length > 0 ? requested : 'gameObject';
  const candidates =
    userProvidedReferenceType
      ? [inferred]
      : inferred === 'asset'
        ? ['asset']
        : inferred === 'component'
          ? ['component', 'gameObject']
          : ['gameObject', 'component'];

  let lastError = null;
  for (const referenceType of candidates) {
    const callArgs = { ...baseArgs, referenceType };
    const call = await tryCallUnityTool(unityHttpUrl, 'unity.component.setReference', callArgs, timeoutMs);
    if (!call.ok) {
      const message = call.error?.message || 'Unknown JSON-RPC error';
      const code = call.error?.code;
      const details = code ? ` (code: ${code})` : '';
      lastError = `Unity JSON-RPC error${details}: ${message}`;

      continue;
    }

    const result = call.result || {};
    if (result.isError === true) {
      lastError = stringifyToolCallResult(result);
      continue;
    }

    return result;
  }

  return buildSetReferenceGuidance({
    args: baseArgs,
    attemptedReferenceTypes: candidates,
    lastError,
    userProvidedReferenceType,
  });
}

function getTilemapRendererPitfallHint(toolName, args) {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return null;
  }

  // Only apply to component add-like tools.
  if (!/^unity\.component\./i.test(toolName) || !/add/i.test(toolName)) {
    return null;
  }

  const componentTypeRaw =
    typeof args?.componentType === 'string'
      ? args.componentType
      : typeof args?.type === 'string'
        ? args.type
        : typeof args?.name === 'string'
          ? args.name
          : '';

  const componentType = componentTypeRaw.trim();
  if (componentType.length === 0) {
    return null;
  }

  const componentTypeLeaf = componentType.split('.').pop();
  if (componentTypeLeaf !== 'TilemapRenderer') {
    return null;
  }

  return (
    `[Tilemap Pitfall] TilemapRenderer は MeshFilter/MeshRenderer 等と競合するため、primitive（Cube/Quad 等）に追加すると失敗します。\n` +
    `回避策:\n` +
    `- 空の GameObject を作成し、そこに Tilemap + TilemapRenderer を追加する\n` +
    `- または unity.editor.executeMenuItem(\"GameObject/2D Object/Tilemap/Rectangular\") を使う\n`
  );
}

async function handleEditorListMenuItems(unityHttpUrl, args, timeoutMs) {
  const filter = typeof args?.filter === 'string' ? args.filter : '';
  const invokeArgs = {
    typeName: MENU_ITEM_LISTER_TYPE,
    methodName: MENU_ITEM_LISTER_METHOD,
    parameters: [filter],
  };

  const invokeCall = await tryCallUnityTool(unityHttpUrl, 'unity.editor.invokeStaticMethod', invokeArgs, timeoutMs);
  if (!invokeCall.ok) {
    const message = invokeCall.error?.message || 'Unknown JSON-RPC error';
    const code = invokeCall.error?.code;
    const details = code ? ` (code: ${code})` : '';
    return { content: [{ type: 'text', text: `Unity JSON-RPC error${details}: ${message}` }], isError: true };
  }

  try {
    const outerMessage = invokeCall.result?.message;
    if (typeof outerMessage !== 'string' || outerMessage.trim().length === 0) {
      throw new Error('Missing message in unity.editor.invokeStaticMethod response');
    }

    const outerJson = JSON.parse(outerMessage);
    const base64 = outerJson?.result;
    if (typeof base64 !== 'string' || base64.trim().length === 0) {
      throw new Error('Missing base64 result from MenuItem lister');
    }

    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    const payload = JSON.parse(decoded);
    const menuItems = Array.isArray(payload?.menuItems) ? payload.menuItems : [];
    const count = Number.isFinite(payload?.count) ? payload.count : menuItems.length;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              status: 'success',
              message: JSON.stringify({ menuItems, count }),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const fallbackCall = await tryCallUnityTool(unityHttpUrl, 'unity.editor.listMenuItems', { filter }, timeoutMs);
    if (fallbackCall.ok) {
      return { content: [{ type: 'text', text: JSON.stringify(fallbackCall.result, null, 2) }] };
    }

    return {
      content: [{ type: 'text', text: `Failed to parse menu items result: ${error.message}` }],
      isError: true,
    };
  }
}

async function handleAssetImportSetTextureType(unityHttpUrl, args, timeoutMs) {
  const assetPath =
    typeof args?.assetPath === 'string'
      ? args.assetPath.trim()
      : typeof args?.path === 'string'
        ? args.path.trim()
        : '';
  const textureType = typeof args?.textureType === 'string' ? args.textureType.trim() : '';
  const reimport = args?.reimport ?? true;

  if (assetPath.length === 0 || textureType.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text:
            `unity.assetImport.setTextureType requires:\n` +
            `- assetPath: "Assets/..." (or path)\n` +
            `- textureType: "Sprite" | "Default" | ...\n` +
            `- (optional) reimport: true/false`,
        },
      ],
      isError: true,
    };
  }

  const invokeArgs = {
    typeName: ASSET_IMPORT_TYPE,
    methodName: ASSET_IMPORT_SET_TEXTURE_TYPE_METHOD,
    parameters: [assetPath, textureType, String(reimport)],
  };

  const invokeCall = await tryCallUnityTool(unityHttpUrl, 'unity.editor.invokeStaticMethod', invokeArgs, timeoutMs);
  if (!invokeCall.ok) {
    const message = invokeCall.error?.message || 'Unknown JSON-RPC error';
    const code = invokeCall.error?.code;
    const details = code ? ` (code: ${code})` : '';
    return { content: [{ type: 'text', text: `Unity JSON-RPC error${details}: ${message}` }], isError: true };
  }

  try {
    const parsed = parseInvokeStaticMethodBase64Payload(invokeCall, 'asset import helper');

    return {
      content: [{ type: 'text', text: JSON.stringify(parsed.payload, null, 2) }],
      isError: parsed.isError,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Failed to parse asset import result: ${error.message}` }],
      isError: true,
    };
  }
}

async function handleAssetImportListSprites(unityHttpUrl, args, timeoutMs) {
  const assetPath =
    typeof args?.assetPath === 'string'
      ? args.assetPath.trim()
      : typeof args?.path === 'string'
        ? args.path.trim()
        : '';

  if (assetPath.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `unity.assetImport.listSprites requires:\n- assetPath: "Assets/..." (texture/sprite asset path)`,
        },
      ],
      isError: true,
    };
  }

  const invokeArgs = {
    typeName: ASSET_IMPORT_TYPE,
    methodName: ASSET_IMPORT_LIST_SPRITES_METHOD,
    parameters: [assetPath],
  };

  const invokeCall = await tryCallUnityTool(unityHttpUrl, 'unity.editor.invokeStaticMethod', invokeArgs, timeoutMs);
  if (!invokeCall.ok) {
    const message = invokeCall.error?.message || 'Unknown JSON-RPC error';
    const code = invokeCall.error?.code;
    const details = code ? ` (code: ${code})` : '';
    return { content: [{ type: 'text', text: `Unity JSON-RPC error${details}: ${message}` }], isError: true };
  }

  try {
    const parsed = parseInvokeStaticMethodBase64Payload(invokeCall, 'list sprites helper');
    return {
      content: [{ type: 'text', text: JSON.stringify(parsed.payload, null, 2) }],
      isError: parsed.isError,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Failed to parse listSprites result: ${error.message}` }],
      isError: true,
    };
  }
}

async function handleComponentSetSpriteReference(unityHttpUrl, args, timeoutMs) {
  const gameObjectPath =
    typeof args?.path === 'string'
      ? args.path.trim()
      : typeof args?.gameObjectPath === 'string'
        ? args.gameObjectPath.trim()
        : typeof args?.hierarchyPath === 'string'
          ? args.hierarchyPath.trim()
          : '';

  const componentType =
    typeof args?.componentType === 'string'
      ? args.componentType.trim()
      : typeof args?.type === 'string'
        ? args.type.trim()
        : '';

  const fieldName =
    typeof args?.fieldName === 'string'
      ? args.fieldName.trim()
      : typeof args?.propertyName === 'string'
        ? args.propertyName.trim()
        : '';

  const assetPath =
    typeof args?.assetPath === 'string'
      ? args.assetPath.trim()
      : typeof args?.referencePath === 'string'
        ? args.referencePath.trim()
        : '';

  const spriteName = typeof args?.spriteName === 'string' ? args.spriteName.trim() : '';

  if (gameObjectPath.length === 0 || componentType.length === 0 || fieldName.length === 0 || assetPath.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text:
            `unity.component.setSpriteReference requires:\n` +
            `- path: "Root/Child" (GameObject path)\n` +
            `- componentType: "SpriteRenderer" or "MyComponent"\n` +
            `- fieldName: "sprite" (or your Sprite field)\n` +
            `- assetPath: "Assets/Foo.png"\n` +
            `- (optional) spriteName: when multiple sprites exist, specify one (use unity.assetImport.listSprites)`,
        },
      ],
      isError: true,
    };
  }

  const invokeArgs = {
    typeName: ASSET_IMPORT_TYPE,
    methodName: ASSET_IMPORT_SET_SPRITE_REFERENCE_METHOD,
    parameters: [gameObjectPath, componentType, fieldName, assetPath, spriteName],
  };

  const invokeCall = await tryCallUnityTool(unityHttpUrl, 'unity.editor.invokeStaticMethod', invokeArgs, timeoutMs);
  if (!invokeCall.ok) {
    const message = invokeCall.error?.message || 'Unknown JSON-RPC error';
    const code = invokeCall.error?.code;
    const details = code ? ` (code: ${code})` : '';
    return { content: [{ type: 'text', text: `Unity JSON-RPC error${details}: ${message}` }], isError: true };
  }

  try {
    const parsed = parseInvokeStaticMethodBase64Payload(invokeCall, 'set sprite reference helper');
    return {
      content: [{ type: 'text', text: JSON.stringify(parsed.payload, null, 2) }],
      isError: parsed.isError,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Failed to parse setSpriteReference result: ${error.message}` }],
      isError: true,
    };
  }
}

async function handleUnityLogHistory(unityHttpUrl, args, timeoutMs) {
  const maxMessageChars = args?.__maxMessageChars ?? args?.__max_message_chars;
  const maxStackTraceChars = args?.__maxStackTraceChars ?? args?.__max_stack_trace_chars;
  const shouldTruncate = maxMessageChars !== undefined || maxStackTraceChars !== undefined;

  const callArgs = {};
  if (args?.limit !== undefined) {
    callArgs.limit = args.limit;
  }
  if (args?.level !== undefined) {
    callArgs.level = args.level;
  }

  const historyCall = await tryCallUnityTool(unityHttpUrl, 'unity.log.history', callArgs, timeoutMs);
  if (!historyCall.ok) {
    const message = historyCall.error?.message || 'Unknown JSON-RPC error';
    const code = historyCall.error?.code;
    const details = code ? ` (code: ${code})` : '';
    return { content: [{ type: 'text', text: `Unity JSON-RPC error${details}: ${message}` }], isError: true };
  }

  const outer = historyCall.result || {};
  if (!shouldTruncate) {
    return { content: [{ type: 'text', text: JSON.stringify(outer, null, 2) }] };
  }

  try {
    const messageJson = outer?.message;
    if (typeof messageJson !== 'string' || messageJson.trim().length === 0) {
      throw new Error('Missing message in unity.log.history response');
    }

    const payload = JSON.parse(messageJson);
    const truncated = truncateUnityLogHistoryPayload(payload, { maxMessageChars, maxStackTraceChars });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...outer, message: JSON.stringify(truncated) }, null, 2) }],
    };
  } catch {
    return { content: [{ type: 'text', text: JSON.stringify(outer, null, 2) }] };
  }
}

async function handleAssetFindByFilter(unityHttpUrl, args, timeoutMs) {
  const filter = typeof args?.filter === 'string' ? args.filter : '';
  const parsed = parseUnityAssetFilter(filter);

  // Allow direct identifiers encoded in the filter string (e.g. "guid:...").
  if (typeof parsed.guid === 'string' && parsed.guid.trim().length > 0) {
    const findCall = await tryCallUnityTool(unityHttpUrl, 'unity.asset.find', { guid: parsed.guid.trim() }, timeoutMs);
    if (!findCall.ok) {
      const message = findCall.error?.message || 'Unknown JSON-RPC error';
      const code = findCall.error?.code;
      const details = code ? ` (code: ${code})` : '';
      return { content: [{ type: 'text', text: `Unity JSON-RPC error${details}: ${message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(findCall.result, null, 2) }] };
  }

  if (typeof parsed.path === 'string' && parsed.path.trim().length > 0) {
    const findCall = await tryCallUnityTool(unityHttpUrl, 'unity.asset.find', { path: parsed.path.trim() }, timeoutMs);
    if (!findCall.ok) {
      const message = findCall.error?.message || 'Unknown JSON-RPC error';
      const code = findCall.error?.code;
      const details = code ? ` (code: ${code})` : '';
      return { content: [{ type: 'text', text: `Unity JSON-RPC error${details}: ${message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(findCall.result, null, 2) }] };
  }

  const folders = normalizeSearchInFolders(args?.searchInFolders);
  const searchFolders = folders.length > 0 ? folders : ['Assets'];

  const assetType = typeof parsed.assetType === 'string' && parsed.assetType.trim().length > 0 ? parsed.assetType.trim() : 'Object';
  const listTimeoutMs = clampTimeoutMs(Math.max(timeoutMs, HEAVY_TOOL_TIMEOUT_MS), BRIDGE_CONFIG);

  const seen = new Map();
  const folderErrors = [];

  for (const folder of searchFolders) {
    const listArgs = { path: folder, recursive: true, assetType };
    const listCall = await tryCallUnityTool(unityHttpUrl, 'unity.asset.list', listArgs, listTimeoutMs);
    if (!listCall.ok) {
      folderErrors.push({
        folder,
        error: listCall.error?.message || 'Unknown JSON-RPC error',
        code: listCall.error?.code ?? null,
      });
      continue;
    }

    const assets = Array.isArray(listCall.result?.assets) ? listCall.result.assets : [];
    for (const asset of assets) {
      const guid = typeof asset?.guid === 'string' ? asset.guid : '';
      const key = guid.trim().length > 0 ? `guid:${guid}` : `path:${String(asset?.path ?? '')}`;
      if (!seen.has(key)) {
        seen.set(key, asset);
      }
    }
  }

  if (seen.size === 0 && folderErrors.length > 0) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ...buildEmptyAssetResult(),
              filter,
              assetType,
              searchInFolders: searchFolders,
              errors: folderErrors,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  const allAssets = Array.from(seen.values());
  const matches = filterAssetCandidates(allAssets, parsed);

  if (matches.length === 1) {
    const match = matches[0];
    const guid = typeof match?.guid === 'string' ? match.guid.trim() : '';
    const pathValue = typeof match?.path === 'string' ? match.path.trim() : '';
    const findArgs = guid.length > 0 ? { guid } : { path: pathValue };

    const findCall = await tryCallUnityTool(unityHttpUrl, 'unity.asset.find', findArgs, timeoutMs);
    if (!findCall.ok) {
      const message = findCall.error?.message || 'Unknown JSON-RPC error';
      const code = findCall.error?.code;
      const details = code ? ` (code: ${code})` : '';
      return { content: [{ type: 'text', text: `Unity JSON-RPC error${details}: ${message}` }], isError: true };
    }

    return { content: [{ type: 'text', text: JSON.stringify(findCall.result, null, 2) }] };
  }

  const shown = matches.slice(0, AMBIGUOUS_CANDIDATE_LIMIT);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            ...buildEmptyAssetResult(),
            filter,
            assetType,
            searchInFolders: searchFolders,
            matchCount: matches.length,
            matches: shown,
            truncated: matches.length > shown.length,
            folderErrors: folderErrors.length > 0 ? folderErrors : undefined,
            note:
              matches.length === 0
                ? 'No assets matched the filter.'
                : 'Multiple assets matched the filter. Refine the filter (e.g. add name:...) or use an exact path/guid.',
          },
          null,
          2
        ),
      },
    ],
  };
}

async function fetchSceneList(unityHttpUrl, maxDepth, timeoutMs) {
  const response = await httpPost(
    `${unityHttpUrl}/api/mcp`,
    {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'unity.scene.list',
        arguments: maxDepth ? { maxDepth } : {},
      },
      id: 99,
    },
    timeoutMs
  );

  if (response?.error) {
    const message = response.error?.message || 'Unknown JSON-RPC error';
    const code = response.error?.code;
    const details = code ? ` (code: ${code})` : '';
    throw new Error(`Unity JSON-RPC error${details}: ${message}`);
  }

  return response?.result || null;
}

async function resolveUnambiguousGameObjectTarget(unityHttpUrl, toolName, args) {
  const queryInfo = extractGameObjectQuery(args);
  if (!queryInfo) {
    return {
      ok: false,
      response: {
        content: [
          {
            type: 'text',
            text:
              `Unambiguous target required for tool: ${toolName}\n` +
              `No target identifier was provided.\n` +
              `Provide a GameObject identifier (path/gameObjectPath) and retry, or set __allowAmbiguous: true (not recommended).`,
          },
        ],
        isError: true,
      },
    };
  }

  const query = queryInfo.query;
  const matchMode = queryInfo.forceNameMatch ? 'name' : query.includes('/') ? 'path' : 'name';
  const queryDepth = matchMode === 'path' ? query.split('/').length - 1 : 0;
  const maxDepth = Math.min(Math.max(SCENE_LIST_MAX_DEPTH, queryDepth), 100);

  const sceneListResult = await fetchSceneList(unityHttpUrl, maxDepth, PREFLIGHT_SCENE_LIST_TIMEOUT_MS);
  const { matches, suggestions } = findSceneMatches(sceneListResult?.rootObjects, query, matchMode, AMBIGUOUS_CANDIDATE_LIMIT);

  if (matches.length !== 1) {
    return {
      ok: false,
      response: buildTargetResolutionError({
        toolName,
        query,
        matchMode,
        maxDepth,
        matches,
        suggestions,
        candidateLimit: AMBIGUOUS_CANDIDATE_LIMIT,
        confirmRequired: isConfirmationRequiredToolName(toolName, BRIDGE_CONFIG),
      }),
    };
  }

  const resolvedPath = typeof matches[0]?.path === 'string' ? matches[0].path : null;
  if (!resolvedPath) {
    return {
      ok: false,
      response: {
        content: [{ type: 'text', text: `Failed to resolve a stable path for tool: ${toolName}` }],
        isError: true,
      },
    };
  }

  const resolvedArgs = { ...args, gameObjectPath: resolvedPath };
  if (typeof args.path === 'string') {
    resolvedArgs.path = resolvedPath;
  }
  if (typeof args.hierarchyPath === 'string') {
    resolvedArgs.hierarchyPath = resolvedPath;
  }

  return { ok: true, args: resolvedArgs, resolvedPath, query };
}

function tryReadRuntimeConfig(runtimeConfigPath) {
  if (!fs.existsSync(runtimeConfigPath)) {
    return { config: null, url: null };
  }

  try {
    const raw = fs.readFileSync(runtimeConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    const httpPort = Number(parsed.httpPort);
    if (!Number.isFinite(httpPort) || httpPort <= 0) {
      throw new Error(`Invalid httpPort in ${RUNTIME_CONFIG_FILENAME}`);
    }
    const url = `http://localhost:${httpPort}`;
    return { config: parsed, url };
  } catch (error) {
    return { config: null, url: null, error };
  }
}

// Verbose logging control (set via environment variable)
const VERBOSE_LOGGING = process.env.MCP_VERBOSE === 'true';

function log(message) {
  console.error(message);
}

function verboseLog(message) {
  if (VERBOSE_LOGGING) {
    console.error(message);
  }
}

/**
 * HTTP request helper using native fetch (Node.js 18+)
 */
async function httpPost(url, data, timeout = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    throw error;
  }
}

/**
 * HTTP GET request helper
 */
async function httpGet(url, timeout = 3000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    throw error;
  }
}

class UnityMCPServer {
  constructor() {
    this.runtimeConfigPath = path.join(process.cwd(), RUNTIME_CONFIG_FILENAME);
    this.unityHttpUrl = null;
    this.unityHttpUrlSource = null;
    this.runtimeConfig = null;
    this.lastRuntimeConfigError = null;

    this.server = new Server(
      {
        name: 'unity-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.isUnityConnected = false;
    this.lastHealthCheck = null;
    this.healthCheckInterval = null;
    this.connectionWarningShown = false;

    this.reloadUnityHttpUrl({ silent: false, reason: 'startup' });

    this.setupHandlers();
    this.setupErrorHandling();
  }

  reloadUnityHttpUrl({ silent = false, reason = 'manual' } = {}) {
    const previousUrl = this.unityHttpUrl;

    const runtime = tryReadRuntimeConfig(this.runtimeConfigPath);
    this.lastRuntimeConfigError = runtime.error ? runtime.error.message : null;
    if (runtime.url) {
      this.unityHttpUrl = runtime.url;
      this.unityHttpUrlSource = 'runtime-config';
      this.runtimeConfig = runtime.config;
    } else {
      const fallbackUrl = process.env.UNITY_HTTP_URL || DEFAULT_UNITY_HTTP_URL;
      this.unityHttpUrl = fallbackUrl;
      this.unityHttpUrlSource = process.env.UNITY_HTTP_URL ? 'env:UNITY_HTTP_URL' : 'default';
      this.runtimeConfig = null;
    }

    const changed = previousUrl !== null && previousUrl !== this.unityHttpUrl;
    const shouldLog = !silent && (previousUrl === null || changed);
    if (shouldLog) {
      if (this.unityHttpUrlSource === 'runtime-config') {
        const projectName = this.runtimeConfig?.projectName;
        const projectInfo = projectName ? ` (Project: ${projectName})` : '';
        log(`[MCP Bridge] Using runtime config: ${this.unityHttpUrl}${projectInfo}`);
      } else {
        log(`[MCP Bridge] Using fallback URL: ${this.unityHttpUrl}`);
      }
      verboseLog(`[MCP Bridge] URL reload reason: ${reason}`);
    }

    // If runtime config exists but failed to parse, surface the error for debugging.
    if (!silent && runtime.error) {
      log(`[MCP Bridge] Failed to read runtime config: ${runtime.error.message}`);
    }

    return { url: this.unityHttpUrl, changed, source: this.unityHttpUrlSource };
  }

  setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      this.stopHealthCheck();
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * Checks if Unity Editor is running and responding
   */
  async checkUnityHealth(silent = false) {
    const tryHealth = async () => {
      const data = await httpGet(`${this.unityHttpUrl}/health`, 3000);
      return data;
    };

    try {
      let data = await tryHealth();
      if (data?.status !== 'ok') {
        throw new Error('Unity health check did not return status=ok');
      }

      const wasDisconnected = !this.isUnityConnected;
      this.isUnityConnected = true;
      this.lastHealthCheck = Date.now();
      this.connectionWarningShown = false;

      // Always log on state change (initial connection or reconnection)
      if (wasDisconnected) {
        log(`[MCP Bridge] Connected to Unity Editor`);
        if (data.projectName) {
          log(`[MCP Bridge]   Project: ${data.projectName}`);
        }
        if (data.unityVersion) {
          log(`[MCP Bridge]   Unity Version: ${data.unityVersion}`);
        }
        log(`[MCP Bridge]   URL: ${this.unityHttpUrl}`);
      }

      return true;
    } catch (error) {
      // On connection failure, reload runtime config so the next attempt can use the updated port.
      const { changed } = this.reloadUnityHttpUrl({ silent: true, reason: 'health-check-failure' });
      if (changed) {
        try {
          const data = await tryHealth();
          if (data?.status === 'ok') {
            const wasDisconnected = !this.isUnityConnected;
            this.isUnityConnected = true;
            this.lastHealthCheck = Date.now();
            this.connectionWarningShown = false;

            if (wasDisconnected) {
              log(`[MCP Bridge] Connected to Unity Editor`);
              if (data.projectName) {
                log(`[MCP Bridge]   Project: ${data.projectName}`);
              }
              if (data.unityVersion) {
                log(`[MCP Bridge]   Unity Version: ${data.unityVersion}`);
              }
              log(`[MCP Bridge]   URL: ${this.unityHttpUrl}`);
            }

            return true;
          }
        } catch (retryError) {
          // Prefer the retry error message if we changed URLs and still failed.
          error = retryError;
        }
      }

      const wasConnected = this.isUnityConnected;
      this.isUnityConnected = false;

      // Always show warning when connection is lost or not established
      if ((wasConnected || this.lastHealthCheck === null) && !this.connectionWarningShown) {
        if (wasConnected) {
          // Connection was lost - always show
          log(`\n[MCP Bridge] Lost connection to Unity Editor`);
          log(`[MCP Bridge]   Error: ${error.message}`);
          log(`[MCP Bridge]   Unity Editor may have been closed`);
          log(`[MCP Bridge]   Waiting for reconnection...\n`);
        } else {
          // Initial connection failed - show once
          log(`[MCP Bridge] Unity Editor is not running`);
          log(`[MCP Bridge]   Error: ${error.message}`);
          log(`[MCP Bridge]   Please start Unity Editor`);
        }
        this.connectionWarningShown = true;
      }

      return false;
    }
  }

  getBridgeTools() {
    return [
      {
        name: 'bridge.status',
        description: 'Show bridge and Unity connection status',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
        },
      },
      {
        name: 'bridge.reload_config',
        description: `Reload ${RUNTIME_CONFIG_FILENAME} and update the Unity HTTP URL`,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
        },
      },
      {
        name: 'bridge.ping',
        description: 'Ping Unity /health endpoint and return its response',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
        },
      },
      {
        name: 'unity.assetImport.setTextureType',
        description:
          "Set TextureImporter.textureType via an allowlisted UnityEditor helper (works even if LocalMcp.UnityServer.AssetImport.Editor is not installed).",
        inputSchema: {
          type: 'object',
          properties: {
            assetPath: {
              type: 'string',
              description: 'Texture asset path (e.g. Assets/Foo.png)',
            },
            textureType: {
              type: 'string',
              description: 'TextureImporter type (e.g. Sprite, Default, NormalMap, GUI, Cursor, Cookie, Lightmap, SingleChannel)',
            },
            reimport: {
              type: 'boolean',
              description: 'If true (default), SaveAndReimport() is called.',
            },
          },
          required: ['assetPath', 'textureType'],
          additionalProperties: false,
        },
      },
      {
        name: 'unity.assetImport.listSprites',
        description:
          'List Sprite sub-assets at a texture path (useful for sprite sheets; returns spriteNames candidates).',
        inputSchema: {
          type: 'object',
          properties: {
            assetPath: {
              type: 'string',
              description: 'Texture asset path (e.g. Assets/Foo.png)',
            },
          },
          required: ['assetPath'],
          additionalProperties: false,
        },
      },
      {
        name: 'unity.component.setSpriteReference',
        description:
          'Set a Sprite reference explicitly (avoids Texture2D main-asset mismatch and does not silently choose among multiple sprites).',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'GameObject path (e.g. Root/Child)',
            },
            componentType: {
              type: 'string',
              description: 'Component type name (e.g. SpriteRenderer, MyComponent)',
            },
            fieldName: {
              type: 'string',
              description: 'Sprite field/property name (e.g. sprite)',
            },
            assetPath: {
              type: 'string',
              description: 'Texture path containing sprites (e.g. Assets/Foo.png)',
            },
            spriteName: {
              type: 'string',
              description: 'Sprite name to assign (required when multiple sprites exist; see unity.assetImport.listSprites).',
            },
          },
          required: ['path', 'componentType', 'fieldName', 'assetPath'],
          additionalProperties: false,
        },
      },
    ];
  }

  mergeTools(unityTools, bridgeTools) {
    const safeUnityTools = (unityTools || []).filter((tool) => tool && typeof tool.name === 'string');
    const safeBridgeTools = (bridgeTools || []).filter((tool) => tool && typeof tool.name === 'string');

    const seen = new Set(safeUnityTools.map((tool) => tool.name));
    const extras = safeBridgeTools.filter((tool) => !seen.has(tool.name));
    return [...safeUnityTools, ...extras];
  }

  async handleBridgeToolCall(name) {
    if (name === 'bridge.status') {
      const status = {
        unityHttpUrl: this.unityHttpUrl,
        unityHttpUrlSource: this.unityHttpUrlSource,
        runtimeConfigPath: this.runtimeConfigPath,
        runtimeConfigExists: fs.existsSync(this.runtimeConfigPath),
        lastRuntimeConfigError: this.lastRuntimeConfigError,
        isUnityConnected: this.isUnityConnected,
        lastHealthCheck: this.lastHealthCheck ? new Date(this.lastHealthCheck).toISOString() : null,
        timeouts: {
          defaultMs: DEFAULT_TOOL_TIMEOUT_MS,
          heavyMs: HEAVY_TOOL_TIMEOUT_MS,
          maxMs: MAX_TOOL_TIMEOUT_MS,
        },
        safety: {
          requireConfirmation: REQUIRE_CONFIRMATION,
          requireUnambiguousTargets: REQUIRE_UNAMBIGUOUS_TARGETS,
        },
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
      };
    }

    if (name === 'bridge.reload_config') {
      const result = this.reloadUnityHttpUrl({ silent: false, reason: 'bridge.reload_config' });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (name === 'bridge.ping') {
      try {
        const data = await httpGet(`${this.unityHttpUrl}/health`, 3000);
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }

    return {
      content: [{ type: 'text', text: `Unknown bridge tool: ${name}` }],
      isError: true,
    };
  }

  /**
   * Starts periodic health check
   */
  async startHealthCheck() {
    // Initial health check (verbose)
    await this.checkUnityHealth(false);

    // Check every 10 seconds (silent unless state changes)
    this.healthCheckInterval = setInterval(() => {
      this.checkUnityHealth(true);
    }, 10000);
  }

  /**
   * Stops periodic health check
   */
  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Returns a user-friendly error message when Unity is not connected
   */
  getDisconnectedErrorMessage() {
    return {
      content: [
        {
          type: 'text',
          text:
            `Unity Editor is not running or not responding (often during recompilation / domain reload)\n\n` +
            `Next steps:\n` +
            `1) Confirm Unity is open\n` +
            `2) In Unity, run menu: MCP/Server/Start\n` +
            `3) Check bridge.status (URL / runtime config path / last error)\n` +
            `4) If Unity was restarted and the port changed, run bridge.reload_config\n` +
            `5) Check logs:\n` +
            `   - Unity Console\n` +
            `   - unity.log.history (optional: __maxMessageChars / __maxStackTraceChars)\n\n` +
            `Project cwd: ${process.cwd()}\n` +
            `Current Unity HTTP URL: ${this.unityHttpUrl}\n`,
        },
      ],
      isError: true,
    };
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const bridgeTools = this.getBridgeTools();
      try {
        // Check connection before making request
        if (!this.isUnityConnected) {
          verboseLog('[MCP Bridge] Unity not connected, attempting to connect...');
          const isConnected = await this.checkUnityHealth();
          if (!isConnected) {
            verboseLog('[MCP Bridge] Failed to connect to Unity Editor');
            // Return bridge tools with warning
            return {
              tools: bridgeTools,
              _meta: {
                warning: 'Unity Editor is not connected. Please start Unity Editor and ensure MCP Server is installed.'
              }
            };
          }
        }

        const response = await httpPost(`${this.unityHttpUrl}/api/mcp`, {
          jsonrpc: '2.0',
          method: 'tools/list',
          params: {},
          id: 1,
        }, 10000);

        if (response?.error) {
          const message = response.error?.message || 'Unknown JSON-RPC error';
          throw new Error(`Unity JSON-RPC error: ${message}`);
        }

        const result = response.result || {};
        let unityTools = patchUnityToolSchemas(result.tools || []);
        if (!ENABLE_UNSAFE_EDITOR_INVOKE) {
          unityTools = unityTools.filter((tool) => tool?.name !== 'unity.editor.invokeStaticMethod');
        }
        return { tools: this.mergeTools(unityTools, bridgeTools) };
      } catch (error) {
        verboseLog('[MCP Bridge] Failed to list tools: ' + error.message);

        // Mark as disconnected
        this.isUnityConnected = false;
        // Reload runtime config so the next attempt can use the updated port.
        this.reloadUnityHttpUrl({ silent: true, reason: 'tools/list-failure' });

        return {
          tools: bridgeTools,
          _meta: {
            error: `Failed to connect to Unity: ${error.message}`
          }
        };
      }
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        // Check connection before making request
        const { name, arguments: rawArgs } = request.params;
        if (name.startsWith('bridge.')) {
          return await this.handleBridgeToolCall(name, rawArgs);
        }

        if (name === 'unity.editor.invokeStaticMethod' && !ENABLE_UNSAFE_EDITOR_INVOKE) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `Tool is disabled by default for safety: ${name}\n` +
                  `This tool can execute arbitrary public static methods inside Unity Editor.\n\n` +
                  `To enable it, set environment variable:\n` +
                  `  MCP_ENABLE_UNSAFE_EDITOR_INVOKE=true\n` +
                  `Then re-run the tool with:\n` +
                  `  __confirm: true`,
              },
            ],
            isError: true,
          };
        }

        if (!this.isUnityConnected) {
          verboseLog('[MCP Bridge] Unity not connected, attempting to connect...');
          const isConnected = await this.checkUnityHealth();
          if (!isConnected) {
            verboseLog('[MCP Bridge] Failed to connect to Unity Editor');
            return this.getDisconnectedErrorMessage();
          }
        }

        const args = rawArgs || {};
        const { confirm, confirmNote, allowAmbiguous } = getConfirmFlags(args);

        const overrideTimeoutMs = args.__timeoutMs ?? args.__timeout_ms ?? args.__timeout;
        const timeoutMs = clampTimeoutMs(
          overrideTimeoutMs !== undefined ? Number(overrideTimeoutMs) : getToolTimeoutMs(name, BRIDGE_CONFIG),
          BRIDGE_CONFIG
        );

        // Normalize known Unity-side argument aliases.
        let forwardedArgs = normalizeUnityArguments(name, args);

        // Resolve ambiguous targets (preflight) before requiring confirmation, so agents can fetch candidates safely.
        if (isUnambiguousTargetRequiredToolName(name, BRIDGE_CONFIG) && !allowAmbiguous) {
          if (isLikelyGameObjectTargetToolName(name)) {
            const resolution = await resolveUnambiguousGameObjectTarget(this.unityHttpUrl, name, forwardedArgs);
            if (!resolution.ok) {
              return resolution.response;
            }
            forwardedArgs = resolution.args;
          } else {
            const identifier = findTargetIdentifier(forwardedArgs);
            const ambiguousName = findAmbiguousName(forwardedArgs);
            if (!identifier && ambiguousName) {
              return {
                content: [
                  {
                    type: 'text',
                    text:
                      `Ambiguous target for tool: ${name}\n` +
                      `Target specified by ${ambiguousName.key}="${ambiguousName.value}" may match multiple objects.\n` +
                      `Please resolve to a unique identifier (e.g. path/guid/instanceId) and retry.\n` +
                      `If you really want to bypass this safety check, set __allowAmbiguous: true (and __confirm: true if required).`,
                  },
                ],
                isError: true,
              };
            }
          }
        }

        if (isConfirmationRequiredToolName(name, BRIDGE_CONFIG) && !confirm) {
          const note = confirmNote ? `\nNote: ${String(confirmNote)}` : '';
          return {
            content: [
              {
                type: 'text',
                text:
                  `Confirmation required for potentially destructive tool: ${name}\n` +
                  `Re-run the same tool call with an explicit confirmation flag:\n` +
                  `  - __confirm: true\n` +
                  `  - (optional) __confirmNote: "why this is safe"\n` +
                  note,
              },
            ],
            isError: true,
          };
        }

        if (name === 'unity.log.history') {
          return await handleUnityLogHistory(this.unityHttpUrl, args, timeoutMs);
        }

        // Internal override keys (not forwarded to Unity, to avoid schema validation errors)
        delete forwardedArgs.__timeoutMs;
        delete forwardedArgs.__timeout_ms;
        delete forwardedArgs.__timeout;
        delete forwardedArgs.__confirm;
        delete forwardedArgs.__confirmed;
        delete forwardedArgs.__confirmDangerous;
        delete forwardedArgs.__confirm_dangerous;
        delete forwardedArgs.__confirmNote;
        delete forwardedArgs.__confirm_note;
        delete forwardedArgs.__allowAmbiguous;
        delete forwardedArgs.__allow_ambiguous;
        delete forwardedArgs.__allowAmbiguousTarget;
        delete forwardedArgs.__allow_ambiguous_target;
        delete forwardedArgs.__maxMessageChars;
        delete forwardedArgs.__max_message_chars;
        delete forwardedArgs.__maxStackTraceChars;
        delete forwardedArgs.__max_stack_trace_chars;

        if (name === 'unity.editor.listMenuItems') {
          return await handleEditorListMenuItems(this.unityHttpUrl, forwardedArgs, timeoutMs);
        }

        if (name === 'unity.assetImport.setTextureType') {
          return await handleAssetImportSetTextureType(this.unityHttpUrl, forwardedArgs, timeoutMs);
        }

        if (name === 'unity.assetImport.listSprites') {
          return await handleAssetImportListSprites(this.unityHttpUrl, forwardedArgs, timeoutMs);
        }

        if (name === 'unity.component.setSpriteReference') {
          return await handleComponentSetSpriteReference(this.unityHttpUrl, forwardedArgs, timeoutMs);
        }

        if (
          name === 'unity.asset.find' &&
          typeof forwardedArgs?.filter === 'string' &&
          (!forwardedArgs.path || typeof forwardedArgs.path !== 'string') &&
          (!forwardedArgs.guid || typeof forwardedArgs.guid !== 'string')
        ) {
          return await handleAssetFindByFilter(this.unityHttpUrl, forwardedArgs, timeoutMs);
        }

        if (name === 'unity.component.setReference') {
          const warning = getNonDestructiveAmbiguousTargetWarning(name, forwardedArgs, BRIDGE_CONFIG);
          const result = await handleComponentSetReference(this.unityHttpUrl, forwardedArgs, timeoutMs, {
            userProvidedReferenceType:
              (typeof args?.referenceType === 'string' && args.referenceType.trim().length > 0) ||
              (typeof args?.reference_type === 'string' && args.reference_type.trim().length > 0),
          });

          return {
            content: [
              ...(warning ? [warning] : []),
              ...(result.content || [{ type: 'text', text: JSON.stringify(result, null, 2) }]),
            ],
            isError: result.isError === true,
          };
        }

        const requestBody = {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name,
            arguments: forwardedArgs,
          },
          id: 2,
        };

        let response;
        try {
          response = await httpPost(`${this.unityHttpUrl}/api/mcp`, requestBody, timeoutMs);
        } catch (error) {
          if (!isReadOnlyToolName(name)) {
            throw error;
          }

          verboseLog(`[MCP Bridge] Read-only tool call failed, retrying once: ${name}`);
          await this.checkUnityHealth(true);
          if (!this.isUnityConnected) {
            throw error;
          }

          response = await httpPost(`${this.unityHttpUrl}/api/mcp`, requestBody, timeoutMs);
        }

        if (response?.error) {
          const message = response.error?.message || 'Unknown JSON-RPC error';
          const code = response.error?.code;
          const details = code ? ` (code: ${code})` : '';
          const hint = getTilemapRendererPitfallHint(name, forwardedArgs);
          return {
            content: [
              {
                type: 'text',
                text: hint
                  ? `Unity JSON-RPC error${details}: ${message}\n\n${hint}`
                  : `Unity JSON-RPC error${details}: ${message}`,
              },
            ],
            isError: true,
          };
        }

        const result = response.result || {};
        const warning = getNonDestructiveAmbiguousTargetWarning(name, forwardedArgs, BRIDGE_CONFIG);
        const hint = result.isError === true ? getTilemapRendererPitfallHint(name, forwardedArgs) : null;

        return {
          content: [
            ...(warning ? [warning] : []),
            ...(result.content || [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ]),
            ...(hint ? [{ type: 'text', text: hint }] : []),
          ],
          isError: result.isError === true,
        };
      } catch (error) {
        // Mark as disconnected on error
        const wasConnected = this.isUnityConnected;
        this.isUnityConnected = false;
        // Reload runtime config so the next attempt can use the updated port.
        this.reloadUnityHttpUrl({ silent: true, reason: 'tools/call-failure' });

        const errorMessage = error.message;

        // If we just lost connection, provide detailed error
        if (wasConnected) {
          log('[MCP Bridge] Connection lost during API call: ' + errorMessage);
          return this.getDisconnectedErrorMessage();
        }

        return {
          content: [
            {
              type: 'text',
              text: `Error: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    log('[MCP Bridge] Unity MCP Bridge server running on stdio');
    if (VERBOSE_LOGGING) {
      log('[MCP Bridge] Verbose logging enabled (MCP_VERBOSE=true)');
    }

    // Start health monitoring
    log('[MCP Bridge] Starting connection monitoring...');
    await this.startHealthCheck();
  }
}

const server = new UnityMCPServer();
server.run().catch(console.error);
