# リファクタ マスター・チェックリスト

目的: 全リファクタ計画の進捗を一望し、作業ごとに更新する。
更新ルール: 作業開始/完了/検証/コミット時に該当チェックを更新する。

## 0. 全体方針
- [ ] core→test の順で進める
- [ ] ついで改修はしない
- [ ] 変更前後で挙動互換を維持

## 1. UnityMCPServer 分割（core）
- [x] スコープ確認（`UnityMCPServer.js` のみ）
- [x] 新規モジュール名確定（`unityRpc.js`, `unityToolHandlers.js`）
- [x] RPC/ユーティリティ抽出
- [x] tool ハンドラ抽出
- [x] import/配線の整理
- [x] `node --check Server~/mcp-bridge/index.js`
- [x] `cd Server~/mcp-bridge && npm test`
- [x] `cd Server~/mcp-bridge && npm run test:coverage`
- [ ] コミット

## 2. bridgeLogic 分割（core）
- [x] スコープ確認（`bridgeLogic.js`）
- [x] `lib/bridgeLogic/*` の構成確定
- [x] 関数移動（config/toolName/args/scene/asset/timeout/log）
- [x] `bridgeLogic.js` を re-export 化
- [x] `cd Server~/mcp-bridge && npm test`
- [x] `cd Server~/mcp-bridge && npm run test:coverage`
- [ ] コミット

## 3. Editor 共有ヘルパ抽出（core）
- [ ] スコープ確認（`McpAssetImport.cs`, `McpComponentTools.cs`, `McpGameObjectTools.cs`）
- [ ] 新規クラス名確定（`McpEditorSceneQuery`, `McpEditorTypeResolver`）
- [ ] Scene 検索ヘルパ抽出
- [ ] Type 解決ヘルパ抽出
- [ ] Unity Editor でコンパイル確認
- [ ] `unity.component.add` の動作確認（手動）
- [ ] `unity.component.setSpriteReference` の動作確認（手動）
- [ ] `unity.gameObject.createEmptySafe` の動作確認（手動）
- [ ] コミット

## 4. e2e-manual-ops 整理（test）
- [ ] スコープ確認（`e2e-manual-ops.js`）
- [ ] 手順の関数分割
- [ ] tool 選択/操作ロジック分離
- [ ] `node --check Server~/mcp-bridge/scripts/e2e-manual-ops.js`
- [ ] `cd Server~/mcp-bridge && node scripts/e2e-manual-ops.js --project "<UnityProject>"`
- [ ] コミット

## 5. bridgeLogic テスト分割（test）
- [ ] スコープ確認（`bridgeLogic.test.js`）
- [ ] テストファイル分割
- [ ] `cd Server~/mcp-bridge && npm test`
- [ ] `cd Server~/mcp-bridge && npm run test:coverage`
- [ ] コミット
