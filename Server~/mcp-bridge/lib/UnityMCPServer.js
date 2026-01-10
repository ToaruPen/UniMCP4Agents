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
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import { httpGet, httpPost } from './http.js';
import { loadBridgeConfig } from './bridgeConfig.js';
import { tryReadRuntimeConfig } from './runtimeConfig.js';
import { patchUnityToolSchemas } from './toolSchemaPatch.js';
import {
  analyzeUnityHttpUrl,
  buildTargetResolutionError,
  clampTimeoutMs,
  createBridgeConfig,
  extractGameObjectQuery,
  findAmbiguousName,
  findSceneMatches,
  findTargetIdentifier,
  getConfirmFlags,
  getNonDestructiveAmbiguousTargetWarning,
  getToolTimeoutMs,
  isConfirmationRequiredToolName,
  isLikelyGameObjectTargetToolName,
  isReadOnlyToolName,
  isUnambiguousTargetRequiredToolName,
  normalizeUnityArguments,
  parseBoolean,
} from './bridgeLogic.js';
import {
  getTilemapRendererPitfallHint,
  handleAssetFindByFilter,
  handleAssetImportListSprites,
  handleAssetImportSetSpritePixelsPerUnit,
  handleAssetImportSetTextureType,
  handleComponentAdd,
  handleComponentSetReference,
  handleComponentSetSpriteReference,
  handleEditorListMenuItems,
  handleGameObjectCreateEmptySafe,
  handleTilemapClearTile,
  handleTilemapSetTile,
  handleUnityLogHistory,
} from './unityToolHandlers.js';

/**
 * Loads Unity HTTP port from .unity-mcp-runtime.json
 * Falls back to environment variable or default port
 */
const RUNTIME_CONFIG_FILENAME = '.unity-mcp-runtime.json';
const DEFAULT_UNITY_HTTP_URL = 'http://localhost:5051';
const BRIDGE_FILE_CONFIG = loadBridgeConfig(process.env);
const BRIDGE_CONFIG = createBridgeConfig(process.env, BRIDGE_FILE_CONFIG.config);
const DEFAULT_TOOL_TIMEOUT_MS = BRIDGE_CONFIG.defaultToolTimeoutMs;
const HEAVY_TOOL_TIMEOUT_MS = BRIDGE_CONFIG.heavyToolTimeoutMs;
const MAX_TOOL_TIMEOUT_MS = BRIDGE_CONFIG.maxToolTimeoutMs;
const REQUIRE_CONFIRMATION = BRIDGE_CONFIG.requireConfirmation;
const REQUIRE_UNAMBIGUOUS_TARGETS = BRIDGE_CONFIG.requireUnambiguousTargets;
const ALLOW_REMOTE_UNITY_HTTP_URL = BRIDGE_CONFIG.allowRemoteUnityHttpUrl;
const STRICT_LOCAL_UNITY_HTTP_URL = BRIDGE_CONFIG.strictLocalUnityHttpUrl;
const SCENE_LIST_MAX_DEPTH = BRIDGE_CONFIG.sceneListMaxDepth;
const AMBIGUOUS_CANDIDATE_LIMIT = BRIDGE_CONFIG.ambiguousCandidateLimit;
const PREFLIGHT_SCENE_LIST_TIMEOUT_MS = BRIDGE_CONFIG.preflightSceneListTimeoutMs;
const ENABLE_UNSAFE_EDITOR_INVOKE = BRIDGE_CONFIG.enableUnsafeEditorInvoke;

if (BRIDGE_FILE_CONFIG.error) {
  console.error(`[MCP Bridge] ${BRIDGE_FILE_CONFIG.error}`);
}
if (Array.isArray(BRIDGE_FILE_CONFIG.warnings) && BRIDGE_FILE_CONFIG.warnings.length > 0) {
  for (const warning of BRIDGE_FILE_CONFIG.warnings) {
    console.error(`[MCP Bridge] Config warning: ${warning}`);
  }
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

export class UnityMCPServer {
  constructor() {
    this.runtimeConfigPath = path.join(process.cwd(), RUNTIME_CONFIG_FILENAME);
    this.unityHttpUrl = null;
    this.unityHttpUrlSource = null;
    this.runtimeConfig = null;
    this.lastRuntimeConfigError = null;
    this.lastUnityHttpUrlWarning = null;
    this.lastUnityHttpUrlError = null;
    this.blockedUnityHttpUrl = null;

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

    if (ENABLE_UNSAFE_EDITOR_INVOKE) {
      log(
        `[MCP Bridge] WARNING: MCP_ENABLE_UNSAFE_EDITOR_INVOKE=true; unity.editor.invokeStaticMethod will be exposed (still requires __confirm: true).`
      );
    }
  }

  reloadUnityHttpUrl({ silent = false, reason = 'manual' } = {}) {
    const previousUrl = this.unityHttpUrl;

    const runtime = tryReadRuntimeConfig(this.runtimeConfigPath, RUNTIME_CONFIG_FILENAME);
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

    const initialChanged = previousUrl !== null && previousUrl !== this.unityHttpUrl;
    const shouldLog = !silent && (previousUrl === null || initialChanged);
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

    this.lastUnityHttpUrlWarning = null;
    this.lastUnityHttpUrlError = null;
    this.blockedUnityHttpUrl = null;

    const urlAnalysis = analyzeUnityHttpUrl(this.unityHttpUrl);
    if (!urlAnalysis.ok) {
      this.lastUnityHttpUrlError = urlAnalysis.error || 'Invalid Unity HTTP URL';
      if (!silent) {
        log(`[MCP Bridge] Invalid Unity HTTP URL: ${this.lastUnityHttpUrlError}`);
      }
      const changed = previousUrl !== null && previousUrl !== this.unityHttpUrl;
      return { url: this.unityHttpUrl, changed, source: this.unityHttpUrlSource };
    }

    if (!urlAnalysis.isHttp) {
      this.lastUnityHttpUrlWarning =
        `Unity HTTP URL protocol is not http/https: ${urlAnalysis.protocol}\n` +
        `Current URL: ${this.unityHttpUrl}`;
      if (!silent) {
        log(`[MCP Bridge] WARNING: ${this.lastUnityHttpUrlWarning}`);
      }
    }

    if (!urlAnalysis.isLoopback) {
      const remoteBase =
        `Unity HTTP URL points to a non-local host: ${urlAnalysis.hostname}\n` +
        `Current URL: ${this.unityHttpUrl}`;

      if (STRICT_LOCAL_UNITY_HTTP_URL) {
        this.blockedUnityHttpUrl = this.unityHttpUrl;
        this.lastUnityHttpUrlError =
          `Refusing non-local Unity HTTP URL because MCP_STRICT_LOCAL_UNITY_HTTP_URL=true.\n` +
          `${remoteBase}\n` +
          `To intentionally use a remote Unity HTTP URL, set MCP_STRICT_LOCAL_UNITY_HTTP_URL=false and MCP_ALLOW_REMOTE_UNITY_HTTP_URL=true.`;

        const blockedPort = Number.parseInt(urlAnalysis.port, 10);
        const hasBlockedPort = Number.isFinite(blockedPort) && blockedPort > 0 && blockedPort <= 65535;

        this.unityHttpUrl = hasBlockedPort ? `http://localhost:${blockedPort}` : DEFAULT_UNITY_HTTP_URL;
        this.unityHttpUrlSource = hasBlockedPort ? 'localhost(blocked-remote)' : 'default(blocked-remote)';

        if (!silent) {
          log(`[MCP Bridge] ERROR: ${this.lastUnityHttpUrlError}`);
          log(`[MCP Bridge] Falling back to safe URL: ${this.unityHttpUrl}`);
        }
      } else if (!ALLOW_REMOTE_UNITY_HTTP_URL) {
        this.lastUnityHttpUrlWarning =
          `${remoteBase}\n` +
          `If this is intentional, set MCP_ALLOW_REMOTE_UNITY_HTTP_URL=true (or set MCP_STRICT_LOCAL_UNITY_HTTP_URL=true to refuse remote URLs).`;
        if (!silent) {
          log(`[MCP Bridge] WARNING: ${this.lastUnityHttpUrlWarning}`);
        }
      }
    }

    // If runtime config exists but failed to parse, surface the error for debugging.
    if (!silent && runtime.error) {
      log(`[MCP Bridge] Failed to read runtime config: ${runtime.error.message}`);
    }

    const changed = previousUrl !== null && previousUrl !== this.unityHttpUrl;
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
        name: 'unity.component.add',
        description:
          'Add a component via a guarded UnityEditor helper (better errors for ambiguous targets/types; removeConflictingRenderers requires __confirm).',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'GameObject path (e.g. Root/Child)',
            },
            componentType: {
              type: 'string',
              description: 'Component type name (e.g. SpriteRenderer, MyComponent; use Namespace.TypeName when ambiguous)',
            },
            removeConflictingRenderers: {
              type: 'boolean',
              description: 'If true, removes MeshFilter/MeshRenderer when adding SpriteRenderer (requires __confirm).',
            },
          },
          required: ['path', 'componentType'],
          additionalProperties: false,
        },
      },
      {
        name: 'unity.gameObject.createEmptySafe',
        description: 'Create an empty GameObject safely (supports optional parentPath and active flag).',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'New GameObject name.',
            },
            parentPath: {
              type: 'string',
              description: 'Optional parent GameObject path (e.g. Root/Child).',
            },
            active: {
              type: 'boolean',
              description: 'Whether the new GameObject starts active (default: true).',
            },
          },
          required: ['name'],
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
        name: 'unity.assetImport.setSpritePixelsPerUnit',
        description:
          'Set TextureImporter.spritePixelsPerUnit (Sprite textures only; requires __confirm: true).',
        inputSchema: {
          type: 'object',
          properties: {
            assetPath: {
              type: 'string',
              description: 'Texture asset path (e.g. Assets/Foo.png)',
            },
            pixelsPerUnit: {
              type: 'number',
              description: 'Sprite pixels per unit (must be > 0).',
            },
            reimport: {
              type: 'boolean',
              description: 'If true (default), SaveAndReimport() is called.',
            },
          },
          required: ['assetPath', 'pixelsPerUnit'],
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
        name: 'unity.tilemap.setTile',
        description:
          '[Optional] Requires package: com.unity.2d.tilemap (Tilemap). Calls fail if not installed.\n\n' +
          'Set a tile on a Tilemap at grid coordinates (requires __confirm: true).',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Tilemap GameObject path (e.g. Root/Tilemap).',
            },
            x: {
              type: 'integer',
              description: 'Tilemap cell X coordinate.',
            },
            y: {
              type: 'integer',
              description: 'Tilemap cell Y coordinate.',
            },
            z: {
              type: 'integer',
              description: 'Tilemap cell Z coordinate (optional, default 0).',
            },
            tileAssetPath: {
              type: 'string',
              description: 'TileBase asset path (e.g. Assets/Tiles/Grass.asset).',
            },
          },
          required: ['path', 'x', 'y', 'tileAssetPath'],
          additionalProperties: false,
        },
      },
      {
        name: 'unity.tilemap.clearTile',
        description:
          '[Optional] Requires package: com.unity.2d.tilemap (Tilemap). Calls fail if not installed.\n\n' +
          'Clear a tile on a Tilemap at grid coordinates (requires __confirm: true).',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Tilemap GameObject path (e.g. Root/Tilemap).',
            },
            x: {
              type: 'integer',
              description: 'Tilemap cell X coordinate.',
            },
            y: {
              type: 'integer',
              description: 'Tilemap cell Y coordinate.',
            },
            z: {
              type: 'integer',
              description: 'Tilemap cell Z coordinate (optional, default 0).',
            },
          },
          required: ['path', 'x', 'y'],
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
              description: 'Component type name (e.g. SpriteRenderer, MyComponent; use Namespace.TypeName when ambiguous)',
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

    const toolByName = new Map();
    const orderedNames = [];

    for (const tool of safeUnityTools) {
      if (!toolByName.has(tool.name)) {
        orderedNames.push(tool.name);
      }
      toolByName.set(tool.name, tool);
    }

    for (const tool of safeBridgeTools) {
      if (!toolByName.has(tool.name)) {
        orderedNames.push(tool.name);
      }
      // Bridge wins when a tool name collides so tools/list reflects overrides.
      toolByName.set(tool.name, tool);
    }

    return orderedNames.map((name) => toolByName.get(name));
  }

  async handleBridgeToolCall(name) {
    if (name === 'bridge.status') {
      const status = {
        unityHttpUrl: this.unityHttpUrl,
        unityHttpUrlSource: this.unityHttpUrlSource,
        runtimeConfigPath: this.runtimeConfigPath,
        runtimeConfigExists: fs.existsSync(this.runtimeConfigPath),
        lastRuntimeConfigError: this.lastRuntimeConfigError,
        bridgeConfig: {
          path: BRIDGE_FILE_CONFIG.path,
          exists: BRIDGE_FILE_CONFIG.exists,
          error: BRIDGE_FILE_CONFIG.error,
          warnings: BRIDGE_FILE_CONFIG.warnings,
          requireConfirmation: BRIDGE_CONFIG.requireConfirmation,
          confirmAllowlist: BRIDGE_CONFIG.confirmAllowlist,
          confirmDenylist: BRIDGE_CONFIG.confirmDenylist,
        },
        lastUnityHttpUrlWarning: this.lastUnityHttpUrlWarning,
        lastUnityHttpUrlError: this.lastUnityHttpUrlError,
        blockedUnityHttpUrl: this.blockedUnityHttpUrl,
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
          enableUnsafeEditorInvoke: ENABLE_UNSAFE_EDITOR_INVOKE,
        },
        urlPolicy: {
          allowRemoteUnityHttpUrl: ALLOW_REMOTE_UNITY_HTTP_URL,
          strictLocalUnityHttpUrl: STRICT_LOCAL_UNITY_HTTP_URL,
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

        if (name === 'unity.component.add') {
          const removeConflictingRenderers = parseBoolean(
            forwardedArgs?.removeConflictingRenderers ?? forwardedArgs?.remove_conflicting_renderers,
            false
          );
          forwardedArgs.removeConflictingRenderers = removeConflictingRenderers;
          delete forwardedArgs.remove_conflicting_renderers;

          if (removeConflictingRenderers && !confirm) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `removeConflictingRenderers: true will remove MeshFilter/MeshRenderer when adding SpriteRenderer.\n` +
                    `Re-run the same tool call with an explicit confirmation flag:\n` +
                    `  - __confirm: true\n` +
                    `  - (optional) __confirmNote: "why this is safe"`,
                },
              ],
              isError: true,
            };
          }
        }

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

        if (name === 'unity.assetImport.setSpritePixelsPerUnit') {
          return await handleAssetImportSetSpritePixelsPerUnit(this.unityHttpUrl, forwardedArgs, timeoutMs);
        }

        if (name === 'unity.assetImport.listSprites') {
          return await handleAssetImportListSprites(this.unityHttpUrl, forwardedArgs, timeoutMs);
        }

        if (name === 'unity.component.add') {
          return await handleComponentAdd(this.unityHttpUrl, forwardedArgs, timeoutMs);
        }

        if (name === 'unity.gameObject.createEmptySafe') {
          return await handleGameObjectCreateEmptySafe(this.unityHttpUrl, forwardedArgs, timeoutMs);
        }

        if (name === 'unity.tilemap.setTile') {
          return await handleTilemapSetTile(this.unityHttpUrl, forwardedArgs, timeoutMs);
        }

        if (name === 'unity.tilemap.clearTile') {
          return await handleTilemapClearTile(this.unityHttpUrl, forwardedArgs, timeoutMs);
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
          return await handleAssetFindByFilter(this.unityHttpUrl, forwardedArgs, timeoutMs, {
            bridgeConfig: BRIDGE_CONFIG,
            heavyToolTimeoutMs: HEAVY_TOOL_TIMEOUT_MS,
            ambiguousCandidateLimit: AMBIGUOUS_CANDIDATE_LIMIT,
          });
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
