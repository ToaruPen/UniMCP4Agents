# Troubleshooting

## 接続できない / 応答がない

1. Unity Editor が起動しているか確認
2. Console に `[MCP] HTTP Server started on port 5051` が表示されているか確認
3. Unity プロジェクトルートに `.unity-mcp-runtime.json` が生成されているか確認
4. MCP クライアント側で `bridge.status` / `bridge.ping` を実行
5. 接続はできているのに挙動が怪しい場合は `unity.log.history` で Unity Console の Error/Warning を確認（例: `level: "Error,Warning"`）

## Unity の再コンパイル中に落ちる

Unity のコンパイル/アセットリフレッシュ中は、HTTP サーバーが一時的に停止することがあります。
少し待ってから再実行してください（Bridge は次の呼び出しで再接続を試みます）。

復帰しない場合は以下の順で確認します:

1. `bridge.status` で URL / runtime config / last error を確認
2. Unity のメニューから `MCP/Server/Start` を実行
3. Unity 再起動などでポートが変わった場合は `bridge.reload_config`
4. `Unity Console` / `unity.log.history` でエラーを確認
   - 例: `unity.log.history({ limit: 200, level: "Error,Warning" })`

> Editor の自動起動は Unity メニュー `MCP/Server/Auto Start` で切り替えできます（EditorPrefs: `UniMCP4CC.McpServerAutoStart.Enabled`、既定 ON）。
> BatchMode で自動起動させたい場合は `UNITY_MCP_AUTOSTART_IN_BATCHMODE=true` を設定してください。

## unity.component.setReference が失敗する（referenceType 必須など）

`unity.component.setReference` は Unity 側の実装によって `referenceType` が必須扱いになることがあります。
Bridge は `referenceType` を省略しても動くように補完/再試行しますが、失敗する場合は明示してください。

- `referenceType: "gameObject"`: GameObject を参照にセットする
- `referenceType: "component"`: Component（Transform/Rigidbody2D 等）を参照にセットする
- `referenceType: "asset"`: Asset（Prefab/ScriptableObject 等）を参照にセットする
- `referencePath`: 参照先の hierarchy path（例: `"Root/Child"`）。曖昧なら `unity.scene.list` で path を確認

Bridge が失敗時に返す guidance には、不足キーと再試行テンプレが含まれます。

## unity.cinemachine.* / unity.timeline.* が「未導入扱い」で失敗する

### 症状

- `com.unity.cinemachine` / `com.unity.timeline` を導入済みでも、`unity.cinemachine.*` / `unity.timeline.*` が  
  `This API requires the 'com.unity.cinemachine (Cinemachine)' package which is not installed...` のようなエラーで失敗します

### 原因

これらの API は Unity 側で追加の Editor 拡張アセンブリに処理を委譲する設計ですが、本リポジトリの配布物には該当拡張が同梱されていないためロードに失敗します。  
その結果、**パッケージが未導入であるかのような汎用エラー**が返ります（紛らわしい点に注意）。

### 代替案（汎用ツールでの運用）

- Cinemachine:
  - `unity.editor.executeMenuItem("GameObject/Cinemachine/...")` で生成し、`unity.component.inspect` で設定項目（field/property）を確認してから `unity.component.setField` / `unity.component.setReference` で設定します
- Timeline:
  - `PlayableDirector` の追加・再生/停止は `unity.component.*` で可能です
  - `TimelineAsset` は `unity.asset.createScriptableObject`（`typeName: "UnityEngine.Timeline.TimelineAsset"`）で作成できます
  - ただしトラック/クリップ/バインディング等の “編集” をツールだけで行うのは難度が高いため、現状は Unity Editor 上での手作業、または専用 Editor 拡張/自作ヘルパーを推奨します

### 注意事項（汎用ツール利用時）

- `unity.component.setField` / `unity.component.setSerializedProperty` は主に数値/文字列/enum/Vector/Quaternion 等向けです。参照（UnityEngine.Object）は `unity.component.setReference` を使ってください
- 変更直後に `unity.log.history({ limit: 200, level: "Error,Warning" })` を実行して Unity Console を確認してください（プロジェクト側スクリプト由来の例外と混ざるため）

## TilemapRenderer を追加できない（primitive 起点の罠）

`TilemapRenderer` は `MeshFilter` / `MeshRenderer` 等と競合するため、`unity.create` で作った primitive（Cube/Quad 等）に追加しようとすると失敗します。

回避策:

- 空の GameObject を作成し、そこに `Tilemap` + `TilemapRenderer` を追加する
- または `unity.editor.executeMenuItem("GameObject/2D Object/Tilemap/Rectangular")` を使う（`executeMenuItem` は `__confirm: true` が必要）

## 破壊的操作がブロックされる

- `__confirm: true` を付けて再実行してください
- ターゲットが曖昧な場合、Bridge が候補一覧（パス）を返します。候補の `path` を指定して再実行してください

## タイムアウトする

- 1 回だけ延長したい場合: `__timeoutMs` / `__timeout_ms` / `__timeout`
- 既定値を変えたい場合: `MCP_TOOL_TIMEOUT_MS` / `MCP_HEAVY_TOOL_TIMEOUT_MS` 等（`Server~/mcp-bridge/README.md`）
