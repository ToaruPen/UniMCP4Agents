# リファクタ計画ドキュメント: フォーク後の変更ファイル棚卸し

日付: 2026-01-07
基点: `merge-base upstream/main origin/main` = `559fa45615ec9c5bcd4766d7449755bbd33554cf`

## 目的
- フォーク後に変更されたファイルを全て把握する。
- 変更ファイルごとに、リファクタリング要否の初期判定を行う。

## 対象範囲
- `upstream/main` との差分（全ブランチ横断）
- コミット済みの変更を対象

## 収集方法
- `git merge-base upstream/main origin/main`
- `git log --name-only --pretty=format: <base>.. --all`

## 判定基準（初期スクリーニング）
- **コード（C#/JS）**: 300行超は要検討、400行超は要リファクタ候補
- **ドキュメント/設定/Unity .meta/バイナリ**: リファクタ対象外

## コードファイル一覧（C#/JS）
| ファイル | 行数 | 判定 | 理由 |
| --- | ---: | --- | --- |
| `Editor/McpAssetImport.cs` | 885 | 要リファクタ候補 | 400行超の肥大化（Editor C#） |
| `Editor/McpComponentTools.cs` | 607 | 要リファクタ候補 | 400行超の肥大化（Editor C#） |
| `Editor/McpGameObjectTools.cs` | 387 | 要検討 | 300行超（Editor C#） |
| `Editor/McpMenuItemLister.cs` | 65 | 現時点不要 | 300行未満（Editor C#） |
| `Editor/McpServerAutoStart.cs` | 214 | 現時点不要 | 300行未満（Editor C#） |
| `Server~/mcp-bridge/index.js` | 14 | 現時点不要 | 300行未満（Bridge） |
| `Server~/mcp-bridge/lib/UnityMCPServer.js` | 1820 | 要リファクタ候補 | 400行超の肥大化（Bridge本体） |
| `Server~/mcp-bridge/lib/bridgeConfig.js` | 106 | 現時点不要 | 300行未満（Bridge本体） |
| `Server~/mcp-bridge/lib/bridgeLogic.js` | 973 | 要リファクタ候補 | 400行超の肥大化（Bridge本体） |
| `Server~/mcp-bridge/lib/http.js` | 58 | 現時点不要 | 300行未満（Bridge本体） |
| `Server~/mcp-bridge/lib/runtimeConfig.js` | 23 | 現時点不要 | 300行未満（Bridge本体） |
| `Server~/mcp-bridge/lib/toolSchemaPatch.js` | 271 | 現時点不要 | 300行未満（Bridge本体） |
| `Server~/mcp-bridge/scripts/_e2eUtil.js` | 182 | 現時点不要 | 300行未満（E2Eスクリプト） |
| `Server~/mcp-bridge/scripts/e2e-ambiguous-destroy.js` | 224 | 現時点不要 | 300行未満（E2Eスクリプト） |
| `Server~/mcp-bridge/scripts/e2e-asset-import-reference.js` | 360 | 要検討 | 300行超（E2Eスクリプト） |
| `Server~/mcp-bridge/scripts/e2e-invoke-safety.js` | 184 | 現時点不要 | 300行未満（E2Eスクリプト） |
| `Server~/mcp-bridge/scripts/e2e-manual-ops.js` | 517 | 要リファクタ候補 | 400行超の肥大化（E2Eスクリプト） |
| `Server~/mcp-bridge/scripts/e2e-prefab.js` | 379 | 要検討 | 300行超（E2Eスクリプト） |
| `Server~/mcp-bridge/scripts/e2e-recompile-jitter.js` | 266 | 現時点不要 | 300行未満（E2Eスクリプト） |
| `Server~/mcp-bridge/scripts/e2e-scene-save.js` | 217 | 現時点不要 | 300行未満（E2Eスクリプト） |
| `Server~/mcp-bridge/scripts/e2e-setreference.js` | 282 | 現時点不要 | 300行未満（E2Eスクリプト） |
| `Server~/mcp-bridge/scripts/e2e-smoke.js` | 171 | 現時点不要 | 300行未満（E2Eスクリプト） |
| `Server~/mcp-bridge/scripts/e2e-tilemap.js` | 308 | 要検討 | 300行超（E2Eスクリプト） |
| `Server~/mcp-bridge/scripts/e2e-uitoolkit.js` | 332 | 要検討 | 300行超（E2Eスクリプト） |
| `Server~/mcp-bridge/scripts/playmode-ab.js` | 363 | 要検討 | 300行超（E2Eスクリプト） |
| `Server~/mcp-bridge/test/bridgeConfig.test.js` | 77 | 現時点不要 | 300行未満（テスト） |
| `Server~/mcp-bridge/test/bridgeLogic.test.js` | 1004 | 要リファクタ候補 | 400行超の肥大化（テスト） |

## 詳細調査（要リファクタ候補）

### `Editor/McpAssetImport.cs`
- 役割: TextureImporter 操作・Sprite 一覧/参照設定・GameObject/Component 解決。
- 膨張要因: `SetSpriteReferenceBase64` が長大、エラーペイロード生成の重複。
- 重複: `FindSceneGameObjectsBy*`, `BuildCandidatePaths`, `ResolveType*` が他 Editor ツールと重複。
- リファクタ方向: Scene 検索/型解決/ペイロード生成を共有ヘルパへ抽出（挙動互換を維持）。

### `Editor/McpComponentTools.cs`
- 役割: Component 追加・競合 Renderer 除去・曖昧解決。
- 膨張要因: 失敗メッセージ構築と探索ロジックが肥大化。
- 重複: Scene 検索/型解決が `McpAssetImport` と重複。
- リファクタ方向: 共有ヘルパ化 + AddComponent の責務分割（競合除去/結果エンコード）。

### `Server~/mcp-bridge/lib/UnityMCPServer.js`
- 役割: ツール定義/ハンドラ、Unity RPC、サーバー初期化/配線まで単一ファイル。
- 膨張要因: ツール固有ハンドラと共通ユーティリティが混在。
- リファクタ方向: ハンドラ群をモジュール分割、RPC/サーバー配線を独立。

### `Server~/mcp-bridge/lib/bridgeLogic.js`
- 役割: 設定解析、toolName ルール、引数正規化、対象解決、資産フィルタ等。
- 膨張要因: ドメインの異なる関数が 1 ファイルに集約。
- リファクタ方向: 機能別モジュールに分割し、互換性維持のため集約 re-export を残す。

### `Server~/mcp-bridge/test/bridgeLogic.test.js`
- 役割: bridgeLogic の全関数テスト。
- 膨張要因: 1ファイルに全テストが集中。
- リファクタ方向: 機能別 test ファイルに分割（config / toolName / scene / asset / timeout など）。

### `Server~/mcp-bridge/scripts/e2e-manual-ops.js`
- 役割: 手動E2Eの総合シナリオ。
- 膨張要因: 1関数内に大量の手順が直列で並ぶ。
- リファクタ方向: ステップ関数化、ツール選択と操作の分離。

## 詳細調査（要検討・保留）
- `Editor/McpGameObjectTools.cs`: Scene 検索/パス生成が他と重複。共有ヘルパ化時に同時整理。
- `Server~/mcp-bridge/scripts/e2e-asset-import-reference.js`: 手続き的に長いが、現状は動作追跡が容易。
- `Server~/mcp-bridge/scripts/e2e-prefab.js`: 同上。
- `Server~/mcp-bridge/scripts/e2e-tilemap.js`: 同上。
- `Server~/mcp-bridge/scripts/e2e-uitoolkit.js`: 同上。
- `Server~/mcp-bridge/scripts/playmode-ab.js`: 同上。

## チケット化（要リファクタ候補）
- `.Plans/2026/01/refactor-editor-shared-helpers.md`
- `.Plans/2026/01/refactor-bridge-unitymcpserver-split.md`
- `.Plans/2026/01/refactor-bridge-logic-modules.md`
- `.Plans/2026/01/refactor-bridge-tests-split.md`
- `.Plans/2026/01/refactor-e2e-manual-ops.md`

## ドキュメント/設定（リファクタ対象外）
- `.Plans/2026/01/bridge-allowlist-gameobject-search.md` (82 lines)
- `.Plans/2026/01/bridge-component-add-safe-tools-estimate.md` (72 lines)
- `.gitignore` (34 lines)
- `CHANGELOG.md` (71 lines)
- `README.md` (209 lines)
- `Samples~/UIToolkit Extension/README.md` (5 lines)
- `Server~/mcp-bridge/README.md` (196 lines)
- `Server~/mcp-bridge/package.json` (31 lines)
- `docs/wiki/Getting-Started.md` (63 lines)
- `docs/wiki/Home.md` (24 lines)
- `docs/wiki/MCP-Bridge.md` (99 lines)
- `docs/wiki/Tools.md` (64 lines)
- `docs/wiki/Troubleshooting.md` (82 lines)
- `docs/wiki/UI-Toolkit.md` (28 lines)
- `docs/wiki/_Sidebar.md` (7 lines)
- `package.json` (38 lines)
- `test/pitfalls-dod-plan.md` (405 lines)
- `test/realworld-report.md` (108 lines)
- `test/refactoring-phased-plan.md` (138 lines)
- `test/scenario.md` (346 lines)

## Unity .meta（対象外）
- `.Plans/2026.meta`
- `.Plans/2026/01.meta`
- `.Plans/2026/01/bridge-allowlist-gameobject-search.md.meta`
- `.Plans/2026/01/bridge-component-add-safe-tools-estimate.md.meta`
- `Editor/McpAssetImport.cs.meta`
- `Editor/McpComponentTools.cs.meta`
- `Editor/McpGameObjectTools.cs.meta`
- `Editor/McpMenuItemLister.cs.meta`
- `Editor/McpServerAutoStart.cs.meta`
- `Plans.meta`
- `Samples~/UIToolkit Extension/Editor/LocalMcp.UnityServer.UIToolkit.Editor.dll.meta`
- `docs.meta`
- `docs/wiki.meta`
- `docs/wiki/Getting-Started.md.meta`
- `docs/wiki/Home.md.meta`
- `docs/wiki/MCP-Bridge.md.meta`
- `docs/wiki/Tools.md.meta`
- `docs/wiki/Troubleshooting.md.meta`
- `docs/wiki/UI-Toolkit.md.meta`
- `docs/wiki/_Sidebar.md.meta`
- `test.meta`
- `test/pitfalls-dod-plan.md.meta`
- `test/realworld-report.md.meta`
- `test/refactoring-phased-plan.md.meta`
- `test/scenario.md.meta`

## バイナリ（対象外）
- `Editor/LocalMcp.UnityServer.Editor.dll`
- `Samples~/UIToolkit Extension/Editor/LocalMcp.UnityServer.UIToolkit.Editor.dll`
