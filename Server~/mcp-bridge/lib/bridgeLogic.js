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

function escapeRegex(source) {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesToolPattern(pattern, toolName) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return false;
  }
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return false;
  }

  if (pattern === '*') {
    return true;
  }

  const escaped = escapeRegex(pattern).replace(/\\\*/g, '.*');
  const regex = new RegExp(`^${escaped}$`, 'i');
  return regex.test(toolName);
}

function matchesAnyToolPattern(patterns, toolName) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }
  return patterns.some((pattern) => matchesToolPattern(pattern, toolName));
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

export function isConfirmationRequiredToolName(toolName, config) {
  if (toolName === 'unity.editor.invokeStaticMethod') {
    return true;
  }
  // Bridge tools are always allowed.
  if (toolName.startsWith('bridge.')) {
    return false;
  }

  if (matchesAnyToolPattern(config?.confirmDenylist, toolName)) {
    return true;
  }

  if (matchesAnyToolPattern(config?.confirmAllowlist, toolName)) {
    return false;
  }

  if (!config?.requireConfirmation) {
    return false;
  }

  // Bridge override that changes importer settings (+ optional reimport).
  if (toolName === 'unity.assetImport.setTextureType') {
    return true;
  }

  const action = toolName.split(/[.:/]/).pop() || toolName;
  const readOnlyActionPrefixes = [
    /^get/i,
    /^list/i,
    /^find/i,
    /^analy[sz]e/i,
    /^validate/i,
    /^status/i,
    /^ping/i,
  ];
  if (readOnlyActionPrefixes.some((pattern) => pattern.test(action))) {
    return false;
  }

  const dangerousActionPatterns = [
    /^destroy/i,
    /^delete/i,
    /^remove/i,
    /^build/i,
    /^import/i,
    /^export/i,
    /^pack/i,
    /^embed/i,
    /^execute/i,
    /^set(?:Build|Player|Quality|Physics|Platform|Profile|Time)Settings/i,
    /^set(?:Entitlements|Manifest|Plist|XcodeSettings|GradleProperties|Keystore|BundleVersionCode|BuildNumber)/i,
  ];

  return dangerousActionPatterns.some((pattern) => pattern.test(action));
}

export function getConfirmFlags(args) {
  const confirm =
    args?.__confirm ??
    args?.__confirmed ??
    args?.__confirmDangerous ??
    args?.__confirm_dangerous ??
    false;

  const allowAmbiguous =
    args?.__allowAmbiguous ??
    args?.__allow_ambiguous ??
    args?.__allowAmbiguousTarget ??
    args?.__allow_ambiguous_target ??
    false;

  return {
    confirm: parseBoolean(confirm, false),
    confirmNote: args?.__confirmNote ?? args?.__confirm_note ?? null,
    allowAmbiguous: parseBoolean(allowAmbiguous, false),
  };
}

export function isUnambiguousTargetRequiredToolName(toolName, config) {
  if (!config?.requireUnambiguousTargets) {
    return false;
  }
  if (toolName.startsWith('bridge.')) {
    return false;
  }

  if (/(destroy|delete)/i.test(toolName)) {
    return true;
  }

  // Remove operations vary widely (e.g., removing packages is not ambiguous), so scope this
  // to likely Unity object removals.
  if (/remove/i.test(toolName) && /(gameobject|asset|component|prefab|listener|light|camera)/i.test(toolName)) {
    return true;
  }

  return false;
}

function hasMeaningfulValue(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'object') {
    return true;
  }
  return true;
}

export function findTargetIdentifier(args) {
  if (!args || typeof args !== 'object') {
    return null;
  }

  const identifierKeys = [
    'path',
    'assetPath',
    'gameObjectPath',
    'hierarchyPath',
    'guid',
    'instanceId',
    'instanceID',
    'id',
  ];

  for (const key of identifierKeys) {
    if (hasMeaningfulValue(args[key])) {
      return { key, value: args[key] };
    }
  }

  // Common nested patterns: { target: { ... } } / { object: { ... } }
  for (const containerKey of ['target', 'object']) {
    const container = args[containerKey];
    if (container && typeof container === 'object') {
      for (const key of identifierKeys) {
        if (hasMeaningfulValue(container[key])) {
          return { key: `${containerKey}.${key}`, value: container[key] };
        }
      }
    }
  }

  return null;
}

export function findAmbiguousName(args) {
  if (!args || typeof args !== 'object') {
    return null;
  }

  const nameKeys = ['name', 'objectName', 'gameObjectName', 'assetName', 'componentName', 'prefabName'];
  for (const key of nameKeys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { key, value };
    }
  }

  return null;
}

export function normalizeUnityArguments(toolName, args) {
  if (!args || typeof args !== 'object') {
    return {};
  }

  const normalized = { ...args };

  if (toolName === 'unity.component.setReference') {
    const referenceTypeString = typeof normalized.referenceType === 'string' ? normalized.referenceType.trim() : '';
    if (typeof normalized.referenceType === 'string') {
      normalized.referenceType = referenceTypeString;
    }

    const alias = typeof normalized.reference_type === 'string' ? normalized.reference_type.trim() : '';
    if (referenceTypeString.length === 0 && alias.length > 0) {
      normalized.referenceType = alias;
      delete normalized.reference_type;
    }

    const hasReferenceType = typeof normalized.referenceType === 'string' && normalized.referenceType.trim().length > 0;
    const referencePathCandidate = typeof normalized.referencePath === 'string' ? normalized.referencePath.trim() : '';
    if (!hasReferenceType) {
      if (/^(Assets|Packages)\//.test(referencePathCandidate)) {
        normalized.referenceType = 'asset';
      } else {
        const fieldName = typeof normalized.fieldName === 'string' ? normalized.fieldName.trim().toLowerCase() : '';
        const preferComponent = /(transform|component|renderer|collider|rigidbody|camera|light|animator|audio)/.test(
          fieldName
        );

        normalized.referenceType = preferComponent ? 'component' : 'gameObject';
      }
    }

    const referenceType = normalized.referenceType;
    const referencePath = referencePathCandidate;
    const referenceGameObjectPath =
      typeof normalized.referenceGameObjectPath === 'string' ? normalized.referenceGameObjectPath.trim() : '';
    const referenceAssetPath =
      typeof normalized.referenceAssetPath === 'string' ? normalized.referenceAssetPath.trim() : '';

    // Unity-side validation expects specialized keys for non-asset references.
    // Map the schema-exposed `referencePath` into the expected keys.
    if (referencePath.length > 0) {
      switch (referenceType) {
        case 'gameObject':
        case 'component':
          if (referenceGameObjectPath.length === 0) {
            normalized.referenceGameObjectPath = referencePath;
          }
          break;
        case 'asset':
          if (referenceAssetPath.length === 0) {
            normalized.referenceAssetPath = referencePath;
          }
          break;
        default:
          break;
      }
    }
  }

  if (toolName === 'unity.prefab.apply' || toolName === 'unity.prefab.revert' || toolName === 'unity.prefab.unpack') {
    const instancePath = typeof normalized.instancePath === 'string' ? normalized.instancePath.trim() : '';
    const gameObjectPath = typeof normalized.gameObjectPath === 'string' ? normalized.gameObjectPath.trim() : '';

    // Unity-side prefab APIs sometimes validate `gameObjectPath`, while the tool schema exposes `instancePath`.
    if (instancePath.length > 0 && gameObjectPath.length === 0) {
      normalized.gameObjectPath = instancePath;
    }
  }

  if (toolName.startsWith('unity.uitoolkit.')) {
    const gameObject = typeof normalized.gameObject === 'string' ? normalized.gameObject.trim() : '';
    const gameObjectPath = typeof normalized.gameObjectPath === 'string' ? normalized.gameObjectPath.trim() : '';
    const gameObjectName = typeof normalized.gameObjectName === 'string' ? normalized.gameObjectName.trim() : '';

    const hasGameObject = gameObject.length > 0;
    const hasGameObjectPath = gameObjectPath.length > 0;

    // Unity-side UIToolkit APIs require `gameObject`, while the tool schema exposes `gameObjectPath`
    // (and `createUIDocument` uses `gameObjectName`). Add aliases for better UX.
    if (!hasGameObject) {
      const fallback = hasGameObjectPath ? gameObjectPath : gameObjectName;
      if (typeof fallback === 'string' && fallback.trim().length > 0) {
        normalized.gameObject = fallback.trim();
      }
    }

    if (!hasGameObjectPath) {
      const aliasSource = typeof normalized.gameObject === 'string' ? normalized.gameObject.trim() : '';
      if (aliasSource.length > 0) {
        normalized.gameObjectPath = aliasSource;
      }
    }

    // Some runtime UIToolkit tools use `selector` on the Unity side, while the tool schema exposes
    // `query` or `elementName`. Normalize into a `selector` argument.
    if (toolName.startsWith('unity.uitoolkit.runtime.')) {
      const selector = typeof normalized.selector === 'string' ? normalized.selector.trim() : '';
      if (selector.length > 0) {
        normalized.selector = selector;
        if (Object.prototype.hasOwnProperty.call(normalized, 'query')) {
          delete normalized.query;
        }
        if (Object.prototype.hasOwnProperty.call(normalized, 'elementName')) {
          delete normalized.elementName;
        }
      } else {
        const query = typeof normalized.query === 'string' ? normalized.query.trim() : '';
        if (query.length > 0) {
          normalized.selector = query;
          delete normalized.query;
        }

        const selectorAfterQuery = typeof normalized.selector === 'string' ? normalized.selector.trim() : '';
        if (selectorAfterQuery.length === 0) {
          const elementName = typeof normalized.elementName === 'string' ? normalized.elementName.trim() : '';
          if (elementName.length > 0) {
            const looksLikeSelector = /^[#.[*:]/.test(elementName) || elementName.includes(' ') || elementName.includes('>');
            normalized.selector = looksLikeSelector ? elementName : `#${elementName}`;
            delete normalized.elementName;
          }
        }
      }
    }
  }

  if (
    toolName === 'unity.create' &&
    typeof normalized.type === 'string' &&
    normalized.type.trim().length > 0 &&
    (typeof normalized.primitiveType !== 'string' || normalized.primitiveType.trim().length === 0)
  ) {
    normalized.primitiveType = normalized.type;
  }

  if (toolName === 'unity.asset.createFolder') {
    const hasPath = typeof normalized.path === 'string' && normalized.path.trim().length > 0;
    if (!hasPath) {
      const parentFolderRaw = typeof normalized.parentFolder === 'string' ? normalized.parentFolder.trim() : '';
      const newFolderNameRaw = typeof normalized.newFolderName === 'string' ? normalized.newFolderName.trim() : '';

      if (parentFolderRaw.length > 0 && newFolderNameRaw.length > 0) {
        const parentFolder = parentFolderRaw.replace(/\/+$/, '');
        const newFolderName = newFolderNameRaw.replace(/^\/+/, '');
        normalized.path = `${parentFolder}/${newFolderName}`;
      }
    }
  }

  if (toolName === 'unity.asset.list') {
    const hasAssetType = typeof normalized.assetType === 'string' && normalized.assetType.trim().length > 0;
    if (!hasAssetType) {
      const filterRaw = typeof normalized.filter === 'string' ? normalized.filter.trim() : '';
      const match = /^t\s*:\s*([A-Za-z0-9_]+)/i.exec(filterRaw);
      if (match?.[1]) {
        normalized.assetType = match[1];
      }
    }
  }

  if (typeof normalized.path === 'string' && normalized.path.trim().length > 0) {
    if (typeof normalized.gameObjectPath !== 'string' || normalized.gameObjectPath.trim().length === 0) {
      normalized.gameObjectPath = normalized.path;
    }

    if (
      toolName === 'unity.asset.delete' &&
      (typeof normalized.assetPath !== 'string' || normalized.assetPath.trim().length === 0)
    ) {
      normalized.assetPath = normalized.path;
    }
  }

  return normalized;
}

export function isLikelyGameObjectTargetToolName(toolName) {
  return /^unity\.(gameObject|gameobject|transform|rectTransform|component)\./i.test(toolName);
}

export function isReadOnlyToolName(toolName) {
  const action = toolName.split(/[.:/]/).pop() || toolName;
  const readOnlyActionPrefixes = [
    /^get/i,
    /^list/i,
    /^find/i,
    /^analy[sz]e/i,
    /^validate/i,
    /^status/i,
    /^ping/i,
  ];

  return readOnlyActionPrefixes.some((pattern) => pattern.test(action));
}

export function extractGameObjectQuery(args) {
  if (!args || typeof args !== 'object') {
    return null;
  }

  const candidates = [
    { key: 'gameObjectPath', value: args.gameObjectPath },
    { key: 'path', value: args.path },
    { key: 'hierarchyPath', value: args.hierarchyPath },
  ];

  for (const candidate of candidates) {
    if (typeof candidate.value === 'string') {
      const trimmed = candidate.value.trim();
      if (trimmed.length > 0) {
        return { query: trimmed, sourceKey: candidate.key, forceNameMatch: false };
      }
    }
  }

  const ambiguousName = findAmbiguousName(args);
  if (ambiguousName) {
    return { query: ambiguousName.value.trim(), sourceKey: ambiguousName.key, forceNameMatch: true };
  }

  return null;
}

export function summarizeSceneCandidate(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  const position = node?.transform?.position;
  const rotation = node?.transform?.rotation;
  const scale = node?.transform?.scale;

  return {
    name: typeof node.name === 'string' ? node.name : null,
    path: typeof node.path === 'string' ? node.path : null,
    active: typeof node.active === 'boolean' ? node.active : null,
    childCount: Number.isFinite(node.childCount) ? node.childCount : null,
    position: position && typeof position === 'object' ? position : null,
    rotation: rotation && typeof rotation === 'object' ? rotation : null,
    scale: scale && typeof scale === 'object' ? scale : null,
    components: Array.isArray(node.components) ? node.components : null,
  };
}

export function buildTargetResolutionError({
  toolName,
  query,
  matchMode,
  maxDepth,
  matches,
  suggestions,
  candidateLimit,
  confirmRequired,
}) {
  const shownMatches = (matches || []).slice(0, candidateLimit).map(summarizeSceneCandidate).filter(Boolean);
  const shownSuggestions = (suggestions || []).slice(0, candidateLimit).map(summarizeSceneCandidate).filter(Boolean);

  const payload = {
    error: 'unambiguous_target_required',
    tool: toolName,
    query,
    matchMode,
    sceneListMaxDepth: maxDepth,
    matchesFound: matches?.length ?? 0,
    candidates: shownMatches,
    suggestions: shownSuggestions,
    truncated:
      (matches?.length ?? 0) > candidateLimit || (suggestions?.length ?? 0) > candidateLimit,
    retry: {
      path: '<one of candidates[].path>',
      __confirm: confirmRequired ? true : undefined,
    },
    note:
      'If multiple objects share the same full path, rename them in Unity so hierarchy paths become unique.',
  };

  let headline = `Unambiguous target required for tool: ${toolName}\n`;
  headline += `Query (${matchMode}): "${query}"\n`;

  if ((matches?.length ?? 0) === 0) {
    headline += `No matching GameObject found in the current scene (searched up to maxDepth=${maxDepth}).\n`;
  } else {
    headline += `Matched ${matches.length} objects (must be exactly 1).\n`;
  }

  headline += `Pick an exact path from candidates and retry.\n`;
  headline += `To bypass (not recommended), set __allowAmbiguous: true.\n`;

  if (confirmRequired) {
    headline += `This tool also requires __confirm: true to execute.\n`;
  }

  return {
    content: [{ type: 'text', text: `${headline}\n${JSON.stringify(payload, null, 2)}` }],
    isError: true,
  };
}

export function findSceneMatches(rootObjects, query, matchMode, candidateLimit) {
  const matches = [];
  const suggestions = [];

  const normalizedQuery = String(query);
  const queryLower = normalizedQuery.toLowerCase();

  const stack = Array.isArray(rootObjects) ? [...rootObjects] : [];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') {
      continue;
    }

    const nodeName = typeof node.name === 'string' ? node.name : '';
    const nodePath = typeof node.path === 'string' ? node.path : '';

    const isMatch = matchMode === 'path' ? nodePath === normalizedQuery : nodeName === normalizedQuery;
    if (isMatch) {
      matches.push(node);
      if (matches.length > candidateLimit) {
        // We have enough to prove ambiguity and show a truncated candidate list.
        break;
      }
    } else if (queryLower.length > 0) {
      const nameLower = nodeName.toLowerCase();
      const pathLower = nodePath.toLowerCase();
      if (
        (nameLower.includes(queryLower) || pathLower.includes(queryLower)) &&
        suggestions.length <= candidateLimit
      ) {
        suggestions.push(node);
      }
    }

    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      stack.push(child);
    }
  }

  return { matches, suggestions };
}

export function buildAmbiguousTargetWarning({ toolName, sourceKey, query, matchMode }) {
  const headline = `[Warning] Possible ambiguous GameObject target for tool: ${toolName}\n`;
  const detail =
    `Target specified by ${sourceKey}="${query}" is treated as a ${matchMode} match.\n` +
    `If multiple objects share the same name, Unity may act on an unexpected object.\n` +
    `Prefer a unique hierarchy path (e.g. "Root/Child") from unity.scene.list.`;
  return { type: 'text', text: `${headline}${detail}` };
}

export function getNonDestructiveAmbiguousTargetWarning(toolName, args, config) {
  if (!isLikelyGameObjectTargetToolName(toolName)) {
    return null;
  }
  if (isUnambiguousTargetRequiredToolName(toolName, config)) {
    // Destructive calls are handled by strict preflight.
    return null;
  }
  if (isReadOnlyToolName(toolName)) {
    return null;
  }

  const identifier = findTargetIdentifier(args);
  if (identifier) {
    const keyLower = identifier.key.toLowerCase();
    const value = identifier.value;
    if (
      typeof value === 'string' &&
      (keyLower === 'path' || keyLower.endsWith('.path') || keyLower.endsWith('path')) &&
      !value.includes('/')
    ) {
      return buildAmbiguousTargetWarning({
        toolName,
        sourceKey: identifier.key,
        query: value,
        matchMode: 'name',
      });
    }

    // Non-path identifiers (instanceId/guid) are treated as unambiguous.
    return null;
  }

  const queryInfo = extractGameObjectQuery(args);
  if (!queryInfo) {
    return null;
  }

  const query = queryInfo.query;
  const matchMode = 'name';

  return buildAmbiguousTargetWarning({
    toolName,
    sourceKey: queryInfo.sourceKey,
    query,
    matchMode,
  });
}

export function getToolTimeoutMs(toolName, config) {
  // Conservative: retrying tool calls can cause duplicate side effects, so prefer a longer timeout
  // for operations that are expected to take time.
  const heavyPatterns = [
    /build/i,
    /import/i,
    /export/i,
    /pack/i,
    /compile/i,
    /test/i,
    /bake/i,
    /lighting/i,
    /optimi[sz]e/i,
  ];

  const isHeavy = heavyPatterns.some((pattern) => pattern.test(toolName));
  return isHeavy ? config.heavyToolTimeoutMs : config.defaultToolTimeoutMs;
}

export function clampTimeoutMs(timeoutMs, config) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return config.defaultToolTimeoutMs;
  }
  return Math.min(timeoutMs, config.maxToolTimeoutMs);
}

function truncateString(value, limit) {
  if (value.length <= limit) {
    return value;
  }

  if (limit === 1) {
    return '…';
  }

  return `${value.slice(0, limit - 1)}…`;
}

export function truncateUnityLogHistoryPayload(payload, { maxMessageChars, maxStackTraceChars } = {}) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const logs = Array.isArray(payload.logs) ? payload.logs : null;
  if (!logs) {
    return payload;
  }

  const messageLimit = parsePositiveInt(maxMessageChars, null);
  const stackTraceLimit = parsePositiveInt(maxStackTraceChars, null);
  if (!Number.isFinite(messageLimit) && !Number.isFinite(stackTraceLimit)) {
    return payload;
  }

  let changed = false;
  const nextLogs = logs.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      return entry;
    }

    const nextEntry = { ...entry };

    if (Number.isFinite(messageLimit) && typeof nextEntry.message === 'string') {
      const truncated = truncateString(nextEntry.message, messageLimit);
      if (truncated !== nextEntry.message) {
        nextEntry.message = truncated;
        changed = true;
      }
    }

    if (Number.isFinite(stackTraceLimit) && typeof nextEntry.stackTrace === 'string') {
      const truncated = truncateString(nextEntry.stackTrace, stackTraceLimit);
      if (truncated !== nextEntry.stackTrace) {
        nextEntry.stackTrace = truncated;
        changed = true;
      }
    }

    return nextEntry;
  });

  if (!changed) {
    return payload;
  }

  return { ...payload, logs: nextLogs };
}

function tokenizeFilterString(filter) {
  if (typeof filter !== 'string') {
    return [];
  }

  const tokens = [];
  let current = '';
  let quote = null;

  for (const char of filter.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

export function parseUnityAssetFilter(filter) {
  const tokens = tokenizeFilterString(filter);
  let assetType = null;
  let name = null;
  let guid = null;
  let assetPath = null;
  const textTokens = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const match = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(token);
    if (!match) {
      textTokens.push(token);
      continue;
    }

    const key = match[1].toLowerCase();
    let value = match[2];
    if (value.trim().length === 0 && i + 1 < tokens.length) {
      // Support filters with spaces like: "t: Material"
      value = tokens[i + 1];
      i++;
    }

    const normalizedValue = String(value).trim();
    if (normalizedValue.length === 0) {
      continue;
    }

    if (key === 't' && !assetType) {
      assetType = normalizedValue;
      continue;
    }
    if (key === 'name' && !name) {
      name = normalizedValue;
      continue;
    }
    if (key === 'guid' && !guid) {
      guid = normalizedValue;
      continue;
    }
    if (key === 'path' && !assetPath) {
      assetPath = normalizedValue;
      continue;
    }

    textTokens.push(token);
  }

  return {
    raw: typeof filter === 'string' ? filter : '',
    assetType,
    name,
    guid,
    path: assetPath,
    tokens: textTokens,
  };
}

export function normalizeSearchInFolders(searchInFolders) {
  if (Array.isArray(searchInFolders)) {
    return searchInFolders
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  if (typeof searchInFolders === 'string') {
    const trimmed = searchInFolders.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  return [];
}

export function filterAssetCandidates(assets, parsedFilter) {
  const nameNeedle = typeof parsedFilter?.name === 'string' ? parsedFilter.name.trim().toLowerCase() : '';
  const tokens = Array.isArray(parsedFilter?.tokens)
    ? parsedFilter.tokens.map((token) => String(token).trim().toLowerCase()).filter((token) => token.length > 0)
    : [];

  const result = [];
  for (const asset of Array.isArray(assets) ? assets : []) {
    if (!asset || typeof asset !== 'object') {
      continue;
    }

    const assetName = typeof asset.name === 'string' ? asset.name : '';
    const assetPath = typeof asset.path === 'string' ? asset.path : '';
    const nameLower = assetName.toLowerCase();
    const hayLower = `${assetName} ${assetPath}`.toLowerCase();

    if (nameNeedle.length > 0 && !nameLower.includes(nameNeedle)) {
      continue;
    }

    let ok = true;
    for (const token of tokens) {
      if (!hayLower.includes(token)) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      continue;
    }

    result.push(asset);
  }

  return result;
}
