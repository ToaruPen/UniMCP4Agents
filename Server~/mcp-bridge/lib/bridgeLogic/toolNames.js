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
