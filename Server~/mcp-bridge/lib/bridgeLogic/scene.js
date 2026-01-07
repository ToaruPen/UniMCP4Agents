import {
  isLikelyGameObjectTargetToolName,
  isReadOnlyToolName,
  isUnambiguousTargetRequiredToolName,
} from './toolNames.js';
import { extractGameObjectQuery, findTargetIdentifier } from './args.js';

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
