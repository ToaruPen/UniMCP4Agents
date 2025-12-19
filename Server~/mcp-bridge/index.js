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

/**
 * Loads Unity HTTP port from .unity-mcp-runtime.json
 * Falls back to environment variable or default port
 */
function getUnityHttpUrl() {
  // First, try to read runtime config
  const runtimeConfigPath = path.join(process.cwd(), '.unity-mcp-runtime.json');

  if (fs.existsSync(runtimeConfigPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf8'));
      const url = `http://localhost:${config.httpPort}`;
      console.error(`[MCP Bridge] Using runtime config: ${url} (Project: ${config.projectName})`);
      return url;
    } catch (error) {
      console.error(`[MCP Bridge] Failed to read runtime config: ${error.message}`);
    }
  }

  // Fallback to environment variable or default
  const fallbackUrl = process.env.UNITY_HTTP_URL || 'http://localhost:5051';
  console.error(`[MCP Bridge] Using fallback URL: ${fallbackUrl}`);
  return fallbackUrl;
}

const UNITY_HTTP_URL = getUnityHttpUrl();

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

    this.setupHandlers();
    this.setupErrorHandling();
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
    try {
      const data = await httpGet(`${UNITY_HTTP_URL}/health`, 3000);

      if (data.status === 'ok') {
        const wasDisconnected = !this.isUnityConnected;
        this.isUnityConnected = true;
        this.lastHealthCheck = Date.now();
        this.connectionWarningShown = false;

        // Always log on state change (initial connection or reconnection)
        if (wasDisconnected) {
          log(`[MCP Bridge] Connected to Unity Editor`);
          log(`[MCP Bridge]   Project: ${data.projectName}`);
          log(`[MCP Bridge]   Unity Version: ${data.unityVersion}`);
        }

        return true;
      }
    } catch (error) {
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
4. HTTP server is running on port ${UNITY_HTTP_URL}

Check Unity Console for error messages.`,
        },
      ],
      isError: true,
    };
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        // Check connection before making request
        if (!this.isUnityConnected) {
          verboseLog('[MCP Bridge] Unity not connected, attempting to connect...');
          const isConnected = await this.checkUnityHealth();
          if (!isConnected) {
            verboseLog('[MCP Bridge] Failed to connect to Unity Editor');
            // Return empty tools list with warning
            return {
              tools: [],
              _meta: {
                warning: 'Unity Editor is not connected. Please start Unity Editor and ensure MCP Server is installed.'
              }
            };
          }
        }

        const response = await httpPost(`${UNITY_HTTP_URL}/api/mcp`, {
          jsonrpc: '2.0',
          method: 'tools/list',
          params: {},
          id: 1,
        }, 10000);

        const result = response.result || {};
        return { tools: result.tools || [] };
      } catch (error) {
        verboseLog('[MCP Bridge] Failed to list tools: ' + error.message);

        // Mark as disconnected
        this.isUnityConnected = false;

        return {
          tools: [],
          _meta: {
            error: `Failed to connect to Unity: ${error.message}`
          }
        };
      }
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        // Check connection before making request
        if (!this.isUnityConnected) {
          verboseLog('[MCP Bridge] Unity not connected, attempting to connect...');
          const isConnected = await this.checkUnityHealth();
          if (!isConnected) {
            verboseLog('[MCP Bridge] Failed to connect to Unity Editor');
            return this.getDisconnectedErrorMessage();
          }
        }

        const { name, arguments: args } = request.params;

        const response = await httpPost(`${UNITY_HTTP_URL}/api/mcp`, {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name,
            arguments: args || {},
          },
          id: 2,
        }, 30000);

        const result = response.result || {};

        return {
          content: result.content || [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        // Mark as disconnected on error
        const wasConnected = this.isUnityConnected;
        this.isUnityConnected = false;

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
