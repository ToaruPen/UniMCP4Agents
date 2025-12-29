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

export function createBridgeConfig(env) {
  const defaultToolTimeoutMs = parsePositiveInt(env?.MCP_TOOL_TIMEOUT_MS, 60_000);
  const heavyToolTimeoutMs = parsePositiveInt(env?.MCP_HEAVY_TOOL_TIMEOUT_MS, 300_000);
  const maxToolTimeoutMs = parsePositiveInt(env?.MCP_MAX_TOOL_TIMEOUT_MS, 600_000);

  const requireConfirmation = parseBoolean(env?.MCP_REQUIRE_CONFIRMATION, true);
  const requireUnambiguousTargets = parseBoolean(env?.MCP_REQUIRE_UNAMBIGUOUS_TARGETS, true);
  const sceneListMaxDepth = Math.min(parsePositiveInt(env?.MCP_SCENE_LIST_MAX_DEPTH, 20), 100);
  const ambiguousCandidateLimit = Math.min(parsePositiveInt(env?.MCP_AMBIGUOUS_CANDIDATE_LIMIT, 25), 200);
  const preflightSceneListTimeoutMs = Math.min(
    parsePositiveInt(env?.MCP_PREFLIGHT_SCENE_LIST_TIMEOUT_MS, defaultToolTimeoutMs),
    maxToolTimeoutMs
  );

  return Object.freeze({
    defaultToolTimeoutMs,
    heavyToolTimeoutMs,
    maxToolTimeoutMs,
    requireConfirmation,
    requireUnambiguousTargets,
    sceneListMaxDepth,
    ambiguousCandidateLimit,
    preflightSceneListTimeoutMs,
  });
}

export function isConfirmationRequiredToolName(toolName, config) {
  if (!config?.requireConfirmation) {
    return false;
  }
  // Bridge tools are always allowed.
  if (toolName.startsWith('bridge.')) {
    return false;
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

  if (
    toolName === 'unity.create' &&
    typeof normalized.type === 'string' &&
    normalized.type.trim().length > 0 &&
    (typeof normalized.primitiveType !== 'string' || normalized.primitiveType.trim().length === 0)
  ) {
    normalized.primitiveType = normalized.type;
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
