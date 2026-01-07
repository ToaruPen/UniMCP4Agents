# リファクタチケット: bridgeLogic テスト分割

## [Goal]
- `bridgeLogic.test.js` を機能別に分割して可読性と保守性を上げる。

## [Scope / Constraints]
- 編集対象: `Server~/mcp-bridge/test/bridgeLogic.test.js`
- 新規候補: `Server~/mcp-bridge/test/bridgeLogic.*.test.js`
- テスト内容は同等（削除・仕様変更はしない）
- ついで修正は禁止

## [分割方針]
- config / env: `parseBoolean`, `parsePositiveInt`, `createBridgeConfig`
- toolName ルール: `isConfirmationRequiredToolName`, `isReadOnlyToolName`, `isLikelyGameObjectTargetToolName`
- scene/target: `findSceneMatches`, `summarizeSceneCandidate`, `buildTargetResolutionError`
- asset/filter: `parseUnityAssetFilter`, `filterAssetCandidates`, `normalizeSearchInFolders`
- timeout/log: `getToolTimeoutMs`, `clampTimeoutMs`, `truncateUnityLogHistoryPayload`

## [AcceptanceCriteria]
- [ ] `node --test` が通る
- [ ] `node --test --experimental-test-coverage ...` が通る
- [ ] テスト結果が既存と一致（期待値の変更なし）
