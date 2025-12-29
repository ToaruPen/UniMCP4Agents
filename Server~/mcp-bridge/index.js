#!/usr/bin/env node
/**
 * Unity MCP Bridge Server
 *
 * This server bridges Claude Code and Unity Editor via MCP protocol.
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
  findAmbiguousName,
  findSceneMatches,
  findTargetIdentifier,
  getConfirmFlags,
  getNonDestructiveAmbiguousTargetWarning,
  getToolTimeoutMs,
  isConfirmationRequiredToolName,
  isLikelyGameObjectTargetToolName,
  isUnambiguousTargetRequiredToolName,
  normalizeUnityArguments,
} from './lib/bridgeLogic.js';

/**
 * Loads Unity HTTP port from .unity-mcp-runtime.json
 * Falls back to environment variable or default port
 */
const RUNTIME_CONFIG_FILENAME = '.unity-mcp-runtime.json';
const DEFAULT_UNITY_HTTP_URL = 'http://localhost:5051';

const BRIDGE_CONFIG = createBridgeConfig(process.env);
const DEFAULT_TOOL_TIMEOUT_MS = BRIDGE_CONFIG.defaultToolTimeoutMs;
const HEAVY_TOOL_TIMEOUT_MS = BRIDGE_CONFIG.heavyToolTimeoutMs;
const MAX_TOOL_TIMEOUT_MS = BRIDGE_CONFIG.maxToolTimeoutMs;
const REQUIRE_CONFIRMATION = BRIDGE_CONFIG.requireConfirmation;
const REQUIRE_UNAMBIGUOUS_TARGETS = BRIDGE_CONFIG.requireUnambiguousTargets;
const SCENE_LIST_MAX_DEPTH = BRIDGE_CONFIG.sceneListMaxDepth;
const AMBIGUOUS_CANDIDATE_LIMIT = BRIDGE_CONFIG.ambiguousCandidateLimit;
const PREFLIGHT_SCENE_LIST_TIMEOUT_MS = BRIDGE_CONFIG.preflightSceneListTimeoutMs;

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
  const matchMode = queryInfo.forceNameMatch ? 'name' : 'path';
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
    ];
  }

  mergeTools(unityTools, bridgeTools) {
    const seen = new Set((unityTools || []).map((tool) => tool.name));
    const extras = (bridgeTools || []).filter((tool) => !seen.has(tool.name));
    return [...(unityTools || []), ...extras];
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
          text: `Unity Editor is not running or not responding

Please ensure:
1. Unity Editor is open
2. Unity MCP Server package is installed in your project
3. The Unity project is located at: ${process.cwd()}
4. HTTP server is running at: ${this.unityHttpUrl}

Check Unity Console for error messages.`,
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
        return { tools: this.mergeTools(result.tools || [], bridgeTools) };
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

        const response = await httpPost(`${this.unityHttpUrl}/api/mcp`, {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name,
            arguments: forwardedArgs,
          },
          id: 2,
        }, timeoutMs);

        if (response?.error) {
          const message = response.error?.message || 'Unknown JSON-RPC error';
          const code = response.error?.code;
          const details = code ? ` (code: ${code})` : '';
          return {
            content: [{ type: 'text', text: `Unity JSON-RPC error${details}: ${message}` }],
            isError: true,
          };
        }

        const result = response.result || {};
        const warning = getNonDestructiveAmbiguousTargetWarning(name, forwardedArgs, BRIDGE_CONFIG);

        return {
          content: [
            ...(warning ? [warning] : []),
            ...(result.content || [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ]),
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
