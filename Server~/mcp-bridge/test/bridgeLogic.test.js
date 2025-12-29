import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAmbiguousTargetWarning,
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
  parsePositiveInt,
  summarizeSceneCandidate,
} from '../lib/bridgeLogic.js';

test('parsePositiveInt', () => {
  assert.equal(parsePositiveInt('123', 5), 123);
  assert.equal(parsePositiveInt('0', 5), 5);
  assert.equal(parsePositiveInt('-1', 5), 5);
  assert.equal(parsePositiveInt('abc', 5), 5);
  assert.equal(parsePositiveInt(undefined, 5), 5);
  assert.equal(parsePositiveInt('10.5', 5), 10);
});

test('parseBoolean', () => {
  assert.equal(parseBoolean(undefined, true), true);
  assert.equal(parseBoolean(null, false), false);
  assert.equal(parseBoolean(true, false), true);
  assert.equal(parseBoolean(false, true), false);
  assert.equal(parseBoolean('YES', false), true);
  assert.equal(parseBoolean('no', true), false);
  assert.equal(parseBoolean('maybe', true), true);
  assert.equal(parseBoolean('maybe', false), false);
});

test('createBridgeConfig', () => {
  const defaults = createBridgeConfig({});
  assert.equal(defaults.defaultToolTimeoutMs, 60_000);
  assert.equal(defaults.heavyToolTimeoutMs, 300_000);
  assert.equal(defaults.maxToolTimeoutMs, 600_000);
  assert.equal(defaults.requireConfirmation, true);
  assert.equal(defaults.requireUnambiguousTargets, true);
  assert.equal(defaults.sceneListMaxDepth, 20);
  assert.equal(defaults.ambiguousCandidateLimit, 25);
  assert.equal(defaults.preflightSceneListTimeoutMs, 60_000);
  assert.ok(Object.isFrozen(defaults));

  const fromNull = createBridgeConfig(null);
  assert.equal(fromNull.defaultToolTimeoutMs, 60_000);

  const custom = createBridgeConfig({
    MCP_TOOL_TIMEOUT_MS: '1000',
    MCP_HEAVY_TOOL_TIMEOUT_MS: '5000',
    MCP_MAX_TOOL_TIMEOUT_MS: '4000',
    MCP_REQUIRE_CONFIRMATION: '0',
    MCP_REQUIRE_UNAMBIGUOUS_TARGETS: 'false',
    MCP_SCENE_LIST_MAX_DEPTH: '999',
    MCP_AMBIGUOUS_CANDIDATE_LIMIT: '999',
    MCP_PREFLIGHT_SCENE_LIST_TIMEOUT_MS: '9999',
  });
  assert.equal(custom.defaultToolTimeoutMs, 1000);
  assert.equal(custom.heavyToolTimeoutMs, 5000);
  assert.equal(custom.maxToolTimeoutMs, 4000);
  assert.equal(custom.requireConfirmation, false);
  assert.equal(custom.requireUnambiguousTargets, false);
  assert.equal(custom.sceneListMaxDepth, 100);
  assert.equal(custom.ambiguousCandidateLimit, 200);
  assert.equal(custom.preflightSceneListTimeoutMs, 4000);
});

test('isConfirmationRequiredToolName', () => {
  const config = createBridgeConfig({});
  assert.equal(isConfirmationRequiredToolName('unity.asset.delete', undefined), false);
  assert.equal(isConfirmationRequiredToolName('bridge.status', config), false);
  assert.equal(isConfirmationRequiredToolName('unity.scene.list', config), false);
  assert.equal(isConfirmationRequiredToolName('unity.asset.delete', config), true);
  assert.equal(isConfirmationRequiredToolName('unity.editor.setPlayerSettings', config), true);
  assert.equal(isConfirmationRequiredToolName('unity.gameObject.setActive', config), false);
  assert.equal(isConfirmationRequiredToolName('unity.', config), false);

  const disabled = { ...config, requireConfirmation: false };
  assert.equal(isConfirmationRequiredToolName('unity.asset.delete', disabled), false);
});

test('getConfirmFlags', () => {
  assert.deepEqual(getConfirmFlags({}), { confirm: false, confirmNote: null, allowAmbiguous: false });
  assert.deepEqual(getConfirmFlags({ __confirm: true }), { confirm: true, confirmNote: null, allowAmbiguous: false });
  assert.deepEqual(getConfirmFlags({ __confirmed: 'yes' }), { confirm: true, confirmNote: null, allowAmbiguous: false });
  assert.deepEqual(getConfirmFlags({ __confirmDangerous: '0' }), {
    confirm: false,
    confirmNote: null,
    allowAmbiguous: false,
  });
  assert.deepEqual(getConfirmFlags({ __confirm_dangerous: '1' }), {
    confirm: true,
    confirmNote: null,
    allowAmbiguous: false,
  });
  assert.deepEqual(getConfirmFlags({ __confirm: 'maybe', __confirmNote: 'because' }), {
    confirm: false,
    confirmNote: 'because',
    allowAmbiguous: false,
  });
  assert.deepEqual(getConfirmFlags({ __confirm_note: 'ok' }), {
    confirm: false,
    confirmNote: 'ok',
    allowAmbiguous: false,
  });
  assert.deepEqual(getConfirmFlags({ __allowAmbiguous: true }), {
    confirm: false,
    confirmNote: null,
    allowAmbiguous: true,
  });
  assert.deepEqual(getConfirmFlags({ __allow_ambiguous: '1' }), {
    confirm: false,
    confirmNote: null,
    allowAmbiguous: true,
  });
  assert.deepEqual(getConfirmFlags({ __allowAmbiguousTarget: 'yes' }), {
    confirm: false,
    confirmNote: null,
    allowAmbiguous: true,
  });
  assert.deepEqual(getConfirmFlags({ __allow_ambiguous_target: 1 }), {
    confirm: false,
    confirmNote: null,
    allowAmbiguous: true,
  });
});

test('isUnambiguousTargetRequiredToolName', () => {
  const config = createBridgeConfig({});
  assert.equal(isUnambiguousTargetRequiredToolName('unity.gameObject.destroy', undefined), false);
  assert.equal(isUnambiguousTargetRequiredToolName('bridge.ping', config), false);
  assert.equal(isUnambiguousTargetRequiredToolName('unity.gameObject.destroy', config), true);
  assert.equal(isUnambiguousTargetRequiredToolName('unity.asset.delete', config), true);
  assert.equal(isUnambiguousTargetRequiredToolName('unity.component.remove', config), true);
  assert.equal(isUnambiguousTargetRequiredToolName('unity.package.remove', config), false);

  const disabled = { ...config, requireUnambiguousTargets: false };
  assert.equal(isUnambiguousTargetRequiredToolName('unity.gameObject.destroy', disabled), false);
});

test('findTargetIdentifier', () => {
  assert.equal(findTargetIdentifier(null), null);
  assert.deepEqual(findTargetIdentifier({ path: 'Player' }), { key: 'path', value: 'Player' });
  assert.equal(findTargetIdentifier({ path: '   ' }), null);
  assert.equal(findTargetIdentifier({ target: {} }), null);
  assert.equal(findTargetIdentifier({ object: {} }), null);
  assert.equal(findTargetIdentifier({ target: 1 }), null);
  assert.deepEqual(findTargetIdentifier({ id: 123 }), { key: 'id', value: 123 });
  assert.equal(findTargetIdentifier({ id: Number.NaN }), null);
  assert.deepEqual(findTargetIdentifier({ guid: {} }), { key: 'guid', value: {} });
  assert.deepEqual(findTargetIdentifier({ id: true }), { key: 'id', value: true });
  assert.deepEqual(findTargetIdentifier({ target: { instanceId: 42 } }), {
    key: 'target.instanceId',
    value: 42,
  });
});

test('findAmbiguousName', () => {
  assert.equal(findAmbiguousName(null), null);
  assert.equal(findAmbiguousName({ name: '   ' }), null);
  assert.deepEqual(findAmbiguousName({ name: 'Player' }), { key: 'name', value: 'Player' });
  assert.deepEqual(findAmbiguousName({ prefabName: 'Foo' }), { key: 'prefabName', value: 'Foo' });
});

test('normalizeUnityArguments', () => {
  assert.deepEqual(normalizeUnityArguments('unity.any', null), {});

  assert.deepEqual(
    normalizeUnityArguments('unity.create', { type: 'Cube', name: 'Box' }),
    { type: 'Cube', name: 'Box', primitiveType: 'Cube' }
  );
  assert.deepEqual(
    normalizeUnityArguments('unity.create', { type: 'Cube', primitiveType: '   ' }),
    { type: 'Cube', primitiveType: 'Cube' }
  );
  assert.deepEqual(
    normalizeUnityArguments('unity.create', { type: 'Cube', primitiveType: 'Sphere' }),
    { type: 'Cube', primitiveType: 'Sphere' }
  );
  assert.deepEqual(
    normalizeUnityArguments('unity.gameObject.setActive', { path: 'Root/Player' }),
    { path: 'Root/Player', gameObjectPath: 'Root/Player' }
  );
  assert.deepEqual(
    normalizeUnityArguments('unity.gameObject.setActive', { path: 'Root/Player', gameObjectPath: 'X' }),
    { path: 'Root/Player', gameObjectPath: 'X' }
  );
  assert.deepEqual(
    normalizeUnityArguments('unity.asset.delete', { path: 'Assets/foo.prefab' }),
    { path: 'Assets/foo.prefab', gameObjectPath: 'Assets/foo.prefab', assetPath: 'Assets/foo.prefab' }
  );
  assert.deepEqual(
    normalizeUnityArguments('unity.asset.delete', { path: 'Assets/foo.prefab', assetPath: 'Assets/bar.prefab' }),
    { path: 'Assets/foo.prefab', assetPath: 'Assets/bar.prefab', gameObjectPath: 'Assets/foo.prefab' }
  );
  assert.deepEqual(
    normalizeUnityArguments('unity.gameObject.setActive', { path: '   ' }),
    { path: '   ' }
  );
});

test('isLikelyGameObjectTargetToolName', () => {
  assert.equal(isLikelyGameObjectTargetToolName('unity.gameObject.setActive'), true);
  assert.equal(isLikelyGameObjectTargetToolName('unity.GameObject.setActive'), true);
  assert.equal(isLikelyGameObjectTargetToolName('unity.asset.delete'), false);
});

test('isReadOnlyToolName', () => {
  assert.equal(isReadOnlyToolName('unity.scene.list'), true);
  assert.equal(isReadOnlyToolName('unity.gameObject.get'), true);
  assert.equal(isReadOnlyToolName('unity.gameObject.setActive'), false);
  assert.equal(isReadOnlyToolName('list.'), true);
});

test('extractGameObjectQuery', () => {
  assert.equal(extractGameObjectQuery(null), null);
  assert.equal(extractGameObjectQuery({}), null);
  assert.deepEqual(extractGameObjectQuery({ gameObjectPath: ' Root/Child ' }), {
    query: 'Root/Child',
    sourceKey: 'gameObjectPath',
    forceNameMatch: false,
  });
  assert.deepEqual(extractGameObjectQuery({ path: 'Player' }), {
    query: 'Player',
    sourceKey: 'path',
    forceNameMatch: false,
  });
  assert.deepEqual(extractGameObjectQuery({ hierarchyPath: 'Root/Player' }), {
    query: 'Root/Player',
    sourceKey: 'hierarchyPath',
    forceNameMatch: false,
  });
  assert.deepEqual(extractGameObjectQuery({ name: 'Player' }), {
    query: 'Player',
    sourceKey: 'name',
    forceNameMatch: true,
  });
  assert.deepEqual(extractGameObjectQuery({ gameObjectPath: '   ', name: 'Player' }), {
    query: 'Player',
    sourceKey: 'name',
    forceNameMatch: true,
  });
});

test('summarizeSceneCandidate', () => {
  assert.equal(summarizeSceneCandidate(null), null);
  assert.deepEqual(
    summarizeSceneCandidate({
      name: 'Player',
      path: 'Root/Player',
      active: true,
      childCount: 2,
      transform: {
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      components: ['Transform'],
    }),
    {
      name: 'Player',
      path: 'Root/Player',
      active: true,
      childCount: 2,
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      components: ['Transform'],
    }
  );
  assert.deepEqual(
    summarizeSceneCandidate({
      name: 123,
      path: 456,
      active: 'true',
      childCount: Number.NaN,
      transform: { position: null, rotation: 0, scale: undefined },
      components: {},
    }),
    {
      name: null,
      path: null,
      active: null,
      childCount: null,
      position: null,
      rotation: null,
      scale: null,
      components: null,
    }
  );
});

test('buildTargetResolutionError', () => {
  const response = buildTargetResolutionError({
    toolName: 'unity.gameObject.destroy',
    query: 'Player',
    matchMode: 'name',
    maxDepth: 10,
    matches: [],
    suggestions: [],
    candidateLimit: 25,
    confirmRequired: true,
  });
  assert.equal(response.isError, true);
  assert.equal(response.content[0].type, 'text');

  const text = response.content[0].text;
  const jsonStart = text.indexOf('{');
  assert.ok(jsonStart > 0);
  const payload = JSON.parse(text.slice(jsonStart));
  assert.equal(payload.error, 'unambiguous_target_required');
  assert.equal(payload.tool, 'unity.gameObject.destroy');
  assert.equal(payload.matchesFound, 0);
  assert.equal(payload.retry.__confirm, true);

  const truncated = buildTargetResolutionError({
    toolName: 'unity.gameObject.destroy',
    query: 'Player',
    matchMode: 'name',
    maxDepth: 10,
    matches: new Array(3).fill({ name: 'Player', path: 'Player', children: [] }),
    suggestions: [],
    candidateLimit: 1,
    confirmRequired: false,
  });
  const truncatedPayload = JSON.parse(truncated.content[0].text.slice(truncated.content[0].text.indexOf('{')));
  assert.equal(truncatedPayload.truncated, true);
  assert.equal(truncatedPayload.retry.__confirm, undefined);

  const suggestionTruncated = buildTargetResolutionError({
    toolName: 'unity.gameObject.destroy',
    query: 'Player',
    matchMode: 'name',
    maxDepth: 10,
    matches: [],
    suggestions: new Array(3).fill({ name: 'Player', path: 'Player', children: [] }),
    candidateLimit: 1,
    confirmRequired: false,
  });
  const suggestionPayload = JSON.parse(
    suggestionTruncated.content[0].text.slice(suggestionTruncated.content[0].text.indexOf('{'))
  );
  assert.equal(suggestionPayload.truncated, true);

  const nullLists = buildTargetResolutionError({
    toolName: 'unity.gameObject.destroy',
    query: 'Player',
    matchMode: 'name',
    maxDepth: 10,
    matches: null,
    suggestions: null,
    candidateLimit: 1,
    confirmRequired: false,
  });
  const nullPayload = JSON.parse(nullLists.content[0].text.slice(nullLists.content[0].text.indexOf('{')));
  assert.equal(nullPayload.matchesFound, 0);
});

test('findSceneMatches', () => {
  const rootObjects = [
    null,
    { name: 123, path: 456, children: null },
    {
      name: 'Root',
      path: 'Root',
      children: [
        { name: 'Player', path: 'Root/Player', children: [] },
        { name: 'Enemy', path: 'Root/Enemy', children: [] },
      ],
    },
    { name: 'Player', path: 'Player', children: [] },
  ];

  const byPath = findSceneMatches(rootObjects, 'Root/Enemy', 'path', 25);
  assert.equal(byPath.matches.length, 1);
  assert.equal(byPath.matches[0].path, 'Root/Enemy');

  const ambiguousByName = findSceneMatches(rootObjects, 'Player', 'name', 1);
  assert.equal(ambiguousByName.matches.length, 2);

  const suggestions = findSceneMatches(rootObjects, 'Pla', 'name', 25);
  assert.ok(suggestions.suggestions.length >= 1);

  const emptyQuery = findSceneMatches(rootObjects, '', 'name', 25);
  assert.equal(emptyQuery.suggestions.length, 0);

  const limitedSuggestions = findSceneMatches(
    [
      { name: 'aa', path: 'aa', children: [] },
      { name: 'ab', path: 'ab', children: [] },
    ],
    'a',
    'name',
    0
  );
  assert.equal(limitedSuggestions.suggestions.length, 1);

  const pathSuggestionOnly = findSceneMatches(
    [{ name: 'x', path: 'Assets/Player', children: [] }],
    'assets',
    'name',
    25
  );
  assert.equal(pathSuggestionOnly.suggestions.length, 1);

  assert.deepEqual(findSceneMatches(null, 'Player', 'name', 1), { matches: [], suggestions: [] });
});

test('buildAmbiguousTargetWarning', () => {
  const warning = buildAmbiguousTargetWarning({
    toolName: 'unity.gameObject.setActive',
    sourceKey: 'name',
    query: 'Player',
    matchMode: 'name',
  });
  assert.deepEqual(Object.keys(warning).sort(), ['text', 'type']);
  assert.equal(warning.type, 'text');
  assert.ok(warning.text.includes('unity.gameObject.setActive'));
});

test('getNonDestructiveAmbiguousTargetWarning', () => {
  const config = createBridgeConfig({});

  assert.equal(getNonDestructiveAmbiguousTargetWarning('unity.asset.delete', { path: 'Assets/a' }, config), null);
  assert.equal(getNonDestructiveAmbiguousTargetWarning('unity.gameObject.destroy', { path: 'Player' }, config), null);
  assert.equal(getNonDestructiveAmbiguousTargetWarning('unity.gameObject.get', { path: 'Player' }, config), null);
  assert.equal(getNonDestructiveAmbiguousTargetWarning('unity.gameObject.setActive', {}, config), null);
  assert.equal(
    getNonDestructiveAmbiguousTargetWarning('unity.gameObject.setActive', { instanceId: 123 }, config),
    null
  );

  const byPathName = getNonDestructiveAmbiguousTargetWarning('unity.gameObject.setActive', { path: 'Player' }, config);
  assert.ok(byPathName?.text.includes('Possible ambiguous GameObject target'));

  assert.equal(
    getNonDestructiveAmbiguousTargetWarning('unity.gameObject.setActive', { path: 'Root/Player' }, config),
    null
  );

  const nestedPath = getNonDestructiveAmbiguousTargetWarning(
    'unity.gameObject.setActive',
    { target: { path: 'Player' } },
    config
  );
  assert.ok(nestedPath?.text.includes('target.path="Player"'));

  const byGameObjectPath = getNonDestructiveAmbiguousTargetWarning(
    'unity.gameObject.setActive',
    { gameObjectPath: 'Player' },
    config
  );
  assert.ok(byGameObjectPath?.text.includes('gameObjectPath="Player"'));

  const byName = getNonDestructiveAmbiguousTargetWarning('unity.gameObject.setActive', { name: 'Player' }, config);
  assert.ok(byName?.text.includes('name="Player"'));
});

test('getToolTimeoutMs and clampTimeoutMs', () => {
  const config = createBridgeConfig({
    MCP_TOOL_TIMEOUT_MS: '1000',
    MCP_HEAVY_TOOL_TIMEOUT_MS: '5000',
    MCP_MAX_TOOL_TIMEOUT_MS: '4000',
  });

  assert.equal(getToolTimeoutMs('unity.build.player', config), 5000);
  assert.equal(getToolTimeoutMs('unity.gameObject.setActive', config), 1000);

  assert.equal(clampTimeoutMs(-1, config), 1000);
  assert.equal(clampTimeoutMs(2000, config), 2000);
  assert.equal(clampTimeoutMs(9999, config), 4000);
});
