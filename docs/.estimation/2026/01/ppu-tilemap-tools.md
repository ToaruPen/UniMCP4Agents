# Estimation: PPU + Tilemap Tools

## 0. 前提確認
- 参照した一次情報: docs/wiki/MCP-Bridge.md:1, docs/wiki/Tools.md:47, Server~/mcp-bridge/README.md:155, Editor/McpAssetImport.cs:10, Server~/mcp-bridge/lib/unityToolHandlers.js:11, Server~/mcp-bridge/lib/UnityMCPServer.js:417, Server~/mcp-bridge/lib/bridgeLogic/toolNames.js:29
- 不足/矛盾: Tilemap アセンブリ未導入時はエラー返却で合意

## 1. 依頼内容の解釈（引用）
- 引用: "PPU変更ツール追加" / "TilemapのSet/Clearツール追加" / "エージェントが探し、自分で変更できるように"
- 解釈: Bridge override + Editorヘルパーを追加し、MCPツール経由でPPU変更とTilemapのSet/Clearを実行可能にする

## 2. 変更対象（ファイル:行）
- Editor/McpAssetImport.cs:12
- Editor/McpAssetImport.cs:30
- Editor/McpAssetImport.cs:454
- Editor/McpTilemapTools.cs:1 (新規)
- Server~/mcp-bridge/lib/unityToolHandlers.js:11
- Server~/mcp-bridge/lib/unityToolHandlers.js:263
- Server~/mcp-bridge/lib/UnityMCPServer.js:444
- Server~/mcp-bridge/lib/UnityMCPServer.js:906
- Server~/mcp-bridge/lib/bridgeLogic/toolNames.js:29
- docs/wiki/Tools.md:47
- Server~/mcp-bridge/README.md:155

## 3. 作業項目と工数（コーディングエージェント作業のみ）
- PPU変更ツールのEditor実装（ヘルパー/パース/結果拡張）: 45分
- Tilemap Set/Clear のEditor実装（新規ファイル/反射/エラーハンドリング）: 90分
- Bridge側のツール追加（ハンドラ/スキーマ/確認必須判定）: 75分
- ドキュメント更新: 20分

## 4. DB 影響
- N/A（DBなし）

## 5. ログ出力
- N/A（ログ変更なし）

## 6. I/O 一覧
- ファイル読み込み: Editor/McpAssetImport.cs:53（TextureImporter取得）, Editor/McpTilemapTools.cs:1（TileアセットLoad）
- ファイル書き込み: Editor/McpAssetImport.cs:76（SaveAndReimportでimport設定反映）
- ネットワーク通信: Bridge→Unity JSON-RPC（既存経路）
- DB I/O: N/A
- 外部プロセス/CLI: N/A
- ユーザー入力: MCPツール引数
- クリップボード/OS連携: N/A

## 7. リファクタ候補（必須）
- 候補なし。既存の Editorヘルパー + Bridge override パターンに揃えて最小変更に留めるため。

## 8. フェイズ分割
- 分割なし（1フェイズ）。理由: 追加ツールがBridge側で同時に登録/配線されるため分割メリットが小さい。
- テスト全緑計画: Server~/mcp-bridge で npm test 実行。
- カバレッジ100%計画: npm run test:coverage は lib/bridgeLogic.js のみ対象で新規コードに適用不可。100%達成にはテスト対象拡張が必要（スコープ外）。

## 9. テスト計画
- Node: cd Server~/mcp-bridge && npm test
- Unity: MCPクライアントから unity.assetImport.setSpritePixelsPerUnit / unity.tilemap.setTile / unity.tilemap.clearTile を実行し、unity.log.history で Error/Warning 確認
- 実行できない場合: Unity Editor が必要（手元環境で実施）

## 10. 矛盾点/不明点/確認事項
- なし

## 11. 変更しないこと
- Editor/LocalMcp.UnityServer.Editor.dll は変更しない
- unity.editor.invokeStaticMethod の公開設定や安全ゲート挙動は変更しない
- 追加パッケージ導入やUI改修は行わない

## Implementation Plan
1) Editor側: PPU変更ヘルパーを追加し、Sprite以外はエラー返却
2) Editor側: Tilemap Set/Clear ヘルパーを追加（反射でTilemap/TileBaseを解決、未導入はエラー返却）
3) Bridge側: 新ツールのスキーマ/ハンドラ/確認必須判定を追加
4) ドキュメント更新: Tools/Bridge README の Tool Overrides に追記
