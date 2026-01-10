import {
  clampTimeoutMs,
  filterAssetCandidates,
  normalizeSearchInFolders,
  parseBoolean,
  parseUnityAssetFilter,
  truncateUnityLogHistoryPayload,
} from './bridgeLogic.js';
import { parseInvokeStaticMethodBase64Payload, stringifyToolCallResult, tryCallUnityTool } from './unityRpc.js';

const MENU_ITEM_LISTER_TYPE = 'UniMCP4CC.Editor.McpMenuItemLister';
const MENU_ITEM_LISTER_METHOD = 'ListMenuItemsBase64';
const ASSET_IMPORT_TYPE = 'UniMCP4CC.Editor.McpAssetImport';
const ASSET_IMPORT_SET_TEXTURE_TYPE_METHOD = 'SetTextureTypeBase64';
const ASSET_IMPORT_SET_SPRITE_PPU_METHOD = 'SetSpritePixelsPerUnitBase64';
const ASSET_IMPORT_SET_SPRITE_REFERENCE_METHOD = 'SetSpriteReferenceBase64';
const ASSET_IMPORT_LIST_SPRITES_METHOD = 'ListSpritesBase64';
const COMPONENT_TOOLS_TYPE = 'UniMCP4CC.Editor.McpComponentTools';
const COMPONENT_ADD_METHOD = 'AddComponentBase64V2';
const GAMEOBJECT_TOOLS_TYPE = 'UniMCP4CC.Editor.McpGameObjectTools';
const GAMEOBJECT_CREATE_EMPTY_SAFE_METHOD = 'CreateEmptySafeBase64';
const TILEMAP_TOOLS_TYPE = 'UniMCP4CC.Editor.McpTilemapTools';
const TILEMAP_SET_TILE_METHOD = 'SetTileBase64';
const TILEMAP_CLEAR_TILE_METHOD = 'ClearTileBase64';

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

export async function handleComponentSetReference(unityHttpUrl, args, timeoutMs, { userProvidedReferenceType } = {}) {
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

export function getTilemapRendererPitfallHint(toolName, args) {
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

export async function handleEditorListMenuItems(unityHttpUrl, args, timeoutMs) {
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

export async function handleAssetImportSetTextureType(unityHttpUrl, args, timeoutMs) {
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

export async function handleAssetImportSetSpritePixelsPerUnit(unityHttpUrl, args, timeoutMs) {
  const assetPath =
    typeof args?.assetPath === 'string'
      ? args.assetPath.trim()
      : typeof args?.path === 'string'
        ? args.path.trim()
        : '';

  const pixelsPerUnitRaw = args?.pixelsPerUnit;
  const pixelsPerUnit =
    typeof pixelsPerUnitRaw === 'number'
      ? String(pixelsPerUnitRaw)
      : typeof pixelsPerUnitRaw === 'string'
        ? pixelsPerUnitRaw.trim()
        : '';

  const reimport = args?.reimport ?? true;

  if (assetPath.length === 0 || pixelsPerUnit.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text:
            `unity.assetImport.setSpritePixelsPerUnit requires:\n` +
            `- assetPath: "Assets/..." (or path)\n` +
            `- pixelsPerUnit: number\n` +
            `- (optional) reimport: true/false`,
        },
      ],
      isError: true,
    };
  }

  const invokeArgs = {
    typeName: ASSET_IMPORT_TYPE,
    methodName: ASSET_IMPORT_SET_SPRITE_PPU_METHOD,
    parameters: [assetPath, pixelsPerUnit, String(reimport)],
  };

  const invokeCall = await tryCallUnityTool(unityHttpUrl, 'unity.editor.invokeStaticMethod', invokeArgs, timeoutMs);
  if (!invokeCall.ok) {
    const message = invokeCall.error?.message || 'Unknown JSON-RPC error';
    const code = invokeCall.error?.code;
    const details = code ? ` (code: ${code})` : '';
    return { content: [{ type: 'text', text: `Unity JSON-RPC error${details}: ${message}` }], isError: true };
  }

  try {
    const parsed = parseInvokeStaticMethodBase64Payload(invokeCall, 'sprite pixels per unit helper');
    return {
      content: [{ type: 'text', text: JSON.stringify(parsed.payload, null, 2) }],
      isError: parsed.isError,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Failed to parse sprite pixels per unit result: ${error.message}` }],
      isError: true,
    };
  }
}

export async function handleAssetImportListSprites(unityHttpUrl, args, timeoutMs) {
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

export async function handleTilemapSetTile(unityHttpUrl, args, timeoutMs) {
  const tilemapPath =
    typeof args?.path === 'string'
      ? args.path.trim()
      : typeof args?.tilemapPath === 'string'
        ? args.tilemapPath.trim()
        : typeof args?.gameObjectPath === 'string'
          ? args.gameObjectPath.trim()
          : '';

  const tileAssetPath =
    typeof args?.tileAssetPath === 'string'
      ? args.tileAssetPath.trim()
      : typeof args?.assetPath === 'string'
        ? args.assetPath.trim()
        : '';

  const x =
    typeof args?.x === 'number'
      ? String(args.x)
      : typeof args?.x === 'string'
        ? args.x.trim()
        : '';
  const y =
    typeof args?.y === 'number'
      ? String(args.y)
      : typeof args?.y === 'string'
        ? args.y.trim()
        : '';
  const z =
    typeof args?.z === 'number'
      ? String(args.z)
      : typeof args?.z === 'string'
        ? args.z.trim()
        : '';
  const zValue = z.length > 0 ? z : '0';

  if (tilemapPath.length === 0 || tileAssetPath.length === 0 || x.length === 0 || y.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text:
            `unity.tilemap.setTile requires:\n` +
            `- path: "Root/Tilemap" (or tilemapPath)\n` +
            `- x: number\n` +
            `- y: number\n` +
            `- (optional) z: number\n` +
            `- tileAssetPath: "Assets/Tiles/Grass.asset"`,
        },
      ],
      isError: true,
    };
  }

  const invokeArgs = {
    typeName: TILEMAP_TOOLS_TYPE,
    methodName: TILEMAP_SET_TILE_METHOD,
    parameters: [tilemapPath, x, y, zValue, tileAssetPath],
  };

  const invokeCall = await tryCallUnityTool(unityHttpUrl, 'unity.editor.invokeStaticMethod', invokeArgs, timeoutMs);
  if (!invokeCall.ok) {
    const message = invokeCall.error?.message || 'Unknown JSON-RPC error';
    const code = invokeCall.error?.code;
    const details = code ? ` (code: ${code})` : '';
    return { content: [{ type: 'text', text: `Unity JSON-RPC error${details}: ${message}` }], isError: true };
  }

  try {
    const parsed = parseInvokeStaticMethodBase64Payload(invokeCall, 'tilemap set tile helper');
    return {
      content: [{ type: 'text', text: JSON.stringify(parsed.payload, null, 2) }],
      isError: parsed.isError,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Failed to parse tilemap setTile result: ${error.message}` }],
      isError: true,
    };
  }
}

export async function handleTilemapClearTile(unityHttpUrl, args, timeoutMs) {
  const tilemapPath =
    typeof args?.path === 'string'
      ? args.path.trim()
      : typeof args?.tilemapPath === 'string'
        ? args.tilemapPath.trim()
        : typeof args?.gameObjectPath === 'string'
          ? args.gameObjectPath.trim()
          : '';

  const x =
    typeof args?.x === 'number'
      ? String(args.x)
      : typeof args?.x === 'string'
        ? args.x.trim()
        : '';
  const y =
    typeof args?.y === 'number'
      ? String(args.y)
      : typeof args?.y === 'string'
        ? args.y.trim()
        : '';
  const z =
    typeof args?.z === 'number'
      ? String(args.z)
      : typeof args?.z === 'string'
        ? args.z.trim()
        : '';
  const zValue = z.length > 0 ? z : '0';

  if (tilemapPath.length === 0 || x.length === 0 || y.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text:
            `unity.tilemap.clearTile requires:\n` +
            `- path: "Root/Tilemap" (or tilemapPath)\n` +
            `- x: number\n` +
            `- y: number\n` +
            `- (optional) z: number`,
        },
      ],
      isError: true,
    };
  }

  const invokeArgs = {
    typeName: TILEMAP_TOOLS_TYPE,
    methodName: TILEMAP_CLEAR_TILE_METHOD,
    parameters: [tilemapPath, x, y, zValue],
  };

  const invokeCall = await tryCallUnityTool(unityHttpUrl, 'unity.editor.invokeStaticMethod', invokeArgs, timeoutMs);
  if (!invokeCall.ok) {
    const message = invokeCall.error?.message || 'Unknown JSON-RPC error';
    const code = invokeCall.error?.code;
    const details = code ? ` (code: ${code})` : '';
    return { content: [{ type: 'text', text: `Unity JSON-RPC error${details}: ${message}` }], isError: true };
  }

  try {
    const parsed = parseInvokeStaticMethodBase64Payload(invokeCall, 'tilemap clear tile helper');
    return {
      content: [{ type: 'text', text: JSON.stringify(parsed.payload, null, 2) }],
      isError: parsed.isError,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Failed to parse tilemap clearTile result: ${error.message}` }],
      isError: true,
    };
  }
}

export async function handleComponentAdd(unityHttpUrl, args, timeoutMs) {
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

  const removeConflictingRenderers = parseBoolean(
    args?.removeConflictingRenderers ?? args?.remove_conflicting_renderers,
    false
  );

  if (gameObjectPath.length === 0 || componentType.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text:
            `unity.component.add requires:\n` +
            `- path: "Root/Child" (GameObject path)\n` +
            `- componentType: "SpriteRenderer" or "MyComponent"`,
        },
      ],
      isError: true,
    };
  }

  const invokeArgs = {
    typeName: COMPONENT_TOOLS_TYPE,
    methodName: COMPONENT_ADD_METHOD,
    parameters: [gameObjectPath, componentType, removeConflictingRenderers],
  };

  const invokeCall = await tryCallUnityTool(unityHttpUrl, 'unity.editor.invokeStaticMethod', invokeArgs, timeoutMs);
  if (!invokeCall.ok) {
    const message = invokeCall.error?.message || 'Unknown JSON-RPC error';
    const code = invokeCall.error?.code;
    const details = code ? ` (code: ${code})` : '';
    return { content: [{ type: 'text', text: `Unity JSON-RPC error${details}: ${message}` }], isError: true };
  }

  try {
    const parsed = parseInvokeStaticMethodBase64Payload(invokeCall, 'component add helper');
    return {
      content: [{ type: 'text', text: JSON.stringify(parsed.payload, null, 2) }],
      isError: parsed.isError,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Failed to parse component.add result: ${error.message}` }],
      isError: true,
    };
  }
}

export async function handleGameObjectCreateEmptySafe(unityHttpUrl, args, timeoutMs) {
  const name = typeof args?.name === 'string' ? args.name.trim() : '';
  const parentPath = typeof args?.parentPath === 'string' ? args.parentPath.trim() : '';
  const active = parseBoolean(args?.active, true);

  if (name.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `unity.gameObject.createEmptySafe requires:\n- name: "GameObjectName"\n- (optional) parentPath: "Root/Child"\n- (optional) active: true/false`,
        },
      ],
      isError: true,
    };
  }

  const invokeArgs = {
    typeName: GAMEOBJECT_TOOLS_TYPE,
    methodName: GAMEOBJECT_CREATE_EMPTY_SAFE_METHOD,
    parameters: [name, parentPath, active],
  };

  const invokeCall = await tryCallUnityTool(unityHttpUrl, 'unity.editor.invokeStaticMethod', invokeArgs, timeoutMs);
  if (!invokeCall.ok) {
    const message = invokeCall.error?.message || 'Unknown JSON-RPC error';
    const code = invokeCall.error?.code;
    const details = code ? ` (code: ${code})` : '';
    return { content: [{ type: 'text', text: `Unity JSON-RPC error${details}: ${message}` }], isError: true };
  }

  try {
    const parsed = parseInvokeStaticMethodBase64Payload(invokeCall, 'create empty safe helper');
    return {
      content: [{ type: 'text', text: JSON.stringify(parsed.payload, null, 2) }],
      isError: parsed.isError,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Failed to parse createEmptySafe result: ${error.message}` }],
      isError: true,
    };
  }
}

export async function handleComponentSetSpriteReference(unityHttpUrl, args, timeoutMs) {
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

export async function handleUnityLogHistory(unityHttpUrl, args, timeoutMs) {
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

export async function handleAssetFindByFilter(
  unityHttpUrl,
  args,
  timeoutMs,
  { bridgeConfig, heavyToolTimeoutMs, ambiguousCandidateLimit } = {}
) {
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
  const heavyTimeoutMs = Number.isFinite(heavyToolTimeoutMs) ? heavyToolTimeoutMs : timeoutMs;
  const listTimeoutMs = clampTimeoutMs(Math.max(timeoutMs, heavyTimeoutMs), bridgeConfig);

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
  const candidateLimit = Number.isFinite(ambiguousCandidateLimit) ? ambiguousCandidateLimit : 25;

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

  const shown = matches.slice(0, candidateLimit);
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
