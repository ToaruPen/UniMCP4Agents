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
