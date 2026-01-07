### 0. 前提確認
- 参照した一次情報: `docs/wiki/Tools.md:57`, `docs/wiki/Tools.md:59`, `docs/wiki/Tools.md:60`
- 参照した一次情報: `docs/wiki/MCP-Bridge.md:18`, `docs/wiki/MCP-Bridge.md:33`, `docs/wiki/MCP-Bridge.md:76`, `docs/wiki/MCP-Bridge.md:80`
- 参照した一次情報: `Server~/mcp-bridge/lib/UnityMCPServer.js:480`, `Server~/mcp-bridge/lib/UnityMCPServer.js:1153`, `Server~/mcp-bridge/lib/UnityMCPServer.js:1481`, `Server~/mcp-bridge/lib/UnityMCPServer.js:1574`
- 参照した一次情報: `Editor/McpComponentTools.cs:31`, `Editor/McpComponentTools.cs:124`, `Editor/McpComponentTools.cs:150`
- 参照した一次情報: `Server~/mcp-bridge/scripts/e2e-tilemap.js:80`
- 不足/矛盾: なし（オプション名/スキーマ/確認ゲート方針は決定済み）

### 1. 依頼内容の解釈（引用）
- 「SpriteRenderer 追加時に MeshFilter/MeshRenderer を自動で外す（__confirm 必須）オプション」
- 「空の GameObject を作る安全ツール（例: unity.gameObject.createEmptySafe）」
- 「その2点について、見積もりを行ってください」「Plans/2026/01ファイル内にドキュメントを配置してください」
- 解釈: 上記2機能の実装に必要な変更箇所/工数を見積もり、`Plans/2026/01` に記録する。
- 実装方針: `removeConflictingRenderers` を boolean 追加し、true 時は Bridge で `__confirm` 必須 + Unity 側で SpriteRenderer のみ MeshFilter/MeshRenderer を除去。`unity.gameObject.createEmptySafe` は `name` 必須・`parentPath`/`active` 任意（default true）で、親指定時は親のシーンへ作成。

### 2. 変更対象（ファイル:行）
- `Editor/McpComponentTools.cs:31`
- `Editor/McpComponentTools.cs:124`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:480`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:1153`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:1481`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:1574`
- `Editor/McpGameObjectTools.cs:1 (新規)`
- `Editor/McpGameObjectTools.cs.meta:1 (新規)`
- `docs/wiki/Tools.md:47`
- `Server~/mcp-bridge/README.md:154`
- `Server~/mcp-bridge/scripts/e2e-tilemap.js:80`

### 3. 作業項目と工数（コーディングエージェント作業のみ）
- `unity.component.add` の自動除去オプション: schema 追加/引数整形/`__confirm` 強制分岐追加（`Server~/mcp-bridge/lib/UnityMCPServer.js`）: 45分
- `SpriteRenderer` 追加前の MeshFilter/MeshRenderer 除去処理（Undo 経由）追加（`Editor/McpComponentTools.cs`）: 45分
- `unity.gameObject.createEmptySafe` の Editor ヘルパー追加（空 GameObject 作成・パス返却）: 45分
- Bridge 側の新ツール定義/ハンドラ追加（`Server~/mcp-bridge/lib/UnityMCPServer.js`）: 30分
- ドキュメント更新（`docs/wiki/Tools.md`, `Server~/mcp-bridge/README.md`）: 20分
- テスト/スクリプト更新（`Server~/mcp-bridge/scripts/e2e-tilemap.js`）: 30分

### 4. DB 影響
- N/A（DBなし）

### 5. ログ出力
- N/A（ログ変更なし）

### 6. I/O 一覧
- ファイル読み込み/書き込み: N/A
- ネットワーク通信: Bridge → Unity HTTP (`unity.editor.invokeStaticMethod` 呼び出し) (`Server~/mcp-bridge/lib/UnityMCPServer.js:480`)
- DB I/O: N/A
- 外部プロセス/CLI: N/A
- ユーザー入力: `unity.component.add` の新オプション、`unity.gameObject.createEmptySafe` の引数
- クリップボード/OS連携: N/A

### 7. リファクタ候補（必須）
- 候補なし。既存の Bridge/Editor ヘルパーに局所的な追加で対応可能で、検索/型解決の共通化などは本スコープ外。

### 8. フェイズ分割
- フェイズ分割あり（2フェイズ）。理由: SpriteRenderer 自動除去と新ツール追加を切り分けて影響範囲を限定するため。
- フェイズ1: 自動除去オプション + `__confirm` 強制 + ドキュメント追記。テストは `npm test` と `npm run test:coverage` で全緑/カバレッジ100%、Unity で SpriteRenderer 追加確認。
- フェイズ2: `unity.gameObject.createEmptySafe` 追加 + ドキュメント追記 + e2e 更新。テストは `npm test` と `npm run test:coverage` で全緑/カバレッジ100%、`node scripts/e2e-tilemap.js --project "<UnityProject>"` で動作確認。

### 9. テスト計画
- `cd Server~/mcp-bridge && npm test`
- `cd Server~/mcp-bridge && npm run test:coverage`
- `cd Server~/mcp-bridge && node scripts/e2e-tilemap.js --project "<UnityProject>"`
- Unity 手動: `unity.component.add`（SpriteRenderer）をオプション有無で実行し、競合除去と追加結果を確認
- Unity 手動: `unity.gameObject.createEmptySafe` で空 GameObject が作成されることを確認

### 10. 矛盾点/不明点/確認事項
- なし

### 11. 変更しないこと
- 自動除去オプション未指定時の `unity.component.add` の挙動は変更しない。
- `unity.editor.invokeStaticMethod` の公開/安全ゲートの方針は変更しない。
- GameObject 探索範囲（開いているシーン内のアクティブ/非アクティブまで）を拡張しない。
