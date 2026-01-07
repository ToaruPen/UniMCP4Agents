import { parseBoolean } from './config.js';

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
            const looksLikeSelector =
              /^[#.[*:]/.test(elementName) || elementName.includes(' ') || elementName.includes('>');
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
