export function parsePositiveInt(value, fallback) {
  const numberValue = Number.parseInt(String(value), 10);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return fallback;
  }
  return numberValue;
}

export function parseBoolean(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeToolPatterns(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function createBridgeConfig(env, fileConfig = null) {
  const defaultToolTimeoutMs = parsePositiveInt(env?.MCP_TOOL_TIMEOUT_MS, 60_000);
  const heavyToolTimeoutMs = parsePositiveInt(env?.MCP_HEAVY_TOOL_TIMEOUT_MS, 300_000);
  const maxToolTimeoutMs = parsePositiveInt(env?.MCP_MAX_TOOL_TIMEOUT_MS, 600_000);

  const requireConfirmation = parseBoolean(
    env?.MCP_REQUIRE_CONFIRMATION !== undefined ? env?.MCP_REQUIRE_CONFIRMATION : fileConfig?.requireConfirmation,
    true
  );
  const requireUnambiguousTargets = parseBoolean(env?.MCP_REQUIRE_UNAMBIGUOUS_TARGETS, true);
  const enableUnsafeEditorInvoke = parseBoolean(env?.MCP_ENABLE_UNSAFE_EDITOR_INVOKE, false);
  const allowRemoteUnityHttpUrl = parseBoolean(env?.MCP_ALLOW_REMOTE_UNITY_HTTP_URL, false);
  const strictLocalUnityHttpUrl = parseBoolean(env?.MCP_STRICT_LOCAL_UNITY_HTTP_URL, false);
  const sceneListMaxDepth = Math.min(parsePositiveInt(env?.MCP_SCENE_LIST_MAX_DEPTH, 20), 100);
  const ambiguousCandidateLimit = Math.min(parsePositiveInt(env?.MCP_AMBIGUOUS_CANDIDATE_LIMIT, 25), 200);
  const preflightSceneListTimeoutMs = Math.min(
    parsePositiveInt(env?.MCP_PREFLIGHT_SCENE_LIST_TIMEOUT_MS, defaultToolTimeoutMs),
    maxToolTimeoutMs
  );
  const confirmAllowlist = normalizeToolPatterns(fileConfig?.confirm?.allowlist);
  const confirmDenylist = normalizeToolPatterns(fileConfig?.confirm?.denylist);

  return Object.freeze({
    defaultToolTimeoutMs,
    heavyToolTimeoutMs,
    maxToolTimeoutMs,
    requireConfirmation,
    requireUnambiguousTargets,
    enableUnsafeEditorInvoke,
    allowRemoteUnityHttpUrl,
    strictLocalUnityHttpUrl,
    sceneListMaxDepth,
    ambiguousCandidateLimit,
    preflightSceneListTimeoutMs,
    confirmAllowlist,
    confirmDenylist,
  });
}

export function analyzeUnityHttpUrl(unityHttpUrl) {
  const raw = typeof unityHttpUrl === 'string' ? unityHttpUrl.trim() : '';
  if (raw.length === 0) {
    return { ok: false, error: 'Unity HTTP URL is empty' };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid URL: ${message}` };
  }

  const protocol = parsed.protocol;
  const hostname = parsed.hostname;
  const hostnameLower = hostname.toLowerCase();
  const isHttp = protocol === 'http:' || protocol === 'https:';
  const isLocalhostName =
    hostnameLower === 'localhost' ||
    hostnameLower === 'localhost.' ||
    hostnameLower.endsWith('.localhost') ||
    hostnameLower.endsWith('.localhost.');

  const isLoopbackIpv4 = (() => {
    const parts = hostnameLower.split('.');
    if (parts.length !== 4) {
      return false;
    }
    const octets = [];
    for (const part of parts) {
      if (part.length === 0) {
        return false;
      }
      const value = Number.parseInt(part, 10);
      if (!Number.isFinite(value) || value < 0 || value > 255) {
        return false;
      }
      octets.push(value);
    }
    return octets[0] === 127;
  })();

  const isLoopbackIpv6 = hostnameLower === '::1' || hostnameLower === '[::1]';
  const isLoopback = isLocalhostName || isLoopbackIpv4 || isLoopbackIpv6;

  return {
    ok: true,
    isHttp,
    protocol,
    hostname,
    port: parsed.port,
    origin: parsed.origin,
    isLoopback,
  };
}
