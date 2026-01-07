# リファクタチケット: bridgeLogic のモジュール分割

## [Goal]
- `bridgeLogic.js` をドメイン別に分割し、責務境界を明確化する。

## [Scope / Constraints]
- 編集対象: `Server~/mcp-bridge/lib/bridgeLogic.js`
- 新規候補: `Server~/mcp-bridge/lib/bridgeLogic/*`（config / toolName / args / scene / asset / log 等）
- 既存の export API を維持（`bridgeLogic.js` は re-export のバレルにする）
- ついで修正は禁止

## [分割方針]
- 設定系: `createBridgeConfig`, `parseBoolean`, `parsePositiveInt`
- toolName ルール: `isConfirmationRequiredToolName`, `isReadOnlyToolName`, `isLikelyGameObjectTargetToolName`
- 引数/ターゲット解決: `normalizeUnityArguments`, `findTargetIdentifier`, `findAmbiguousName`, `extractGameObjectQuery`
- シーン探索/曖昧解決: `findSceneMatches`, `summarizeSceneCandidate`, `buildTargetResolutionError`
- Asset フィルタ: `parseUnityAssetFilter`, `filterAssetCandidates`, `normalizeSearchInFolders`
- ログ/タイムアウト: `truncateUnityLogHistoryPayload`, `getToolTimeoutMs`, `clampTimeoutMs`

## [AcceptanceCriteria]
- [ ] `node --test` が通る
- [ ] `node --test --experimental-test-coverage ...` の条件を維持（必要なら対象ファイルを調整）
- [ ] `UnityMCPServer.js` からの import が動作する
- [ ] API 互換（export 名は変更しない）
