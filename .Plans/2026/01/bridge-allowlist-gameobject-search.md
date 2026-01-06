# 実装計画: Bridge 確認ゲートのJSON化 + 非アクティブ探索

日付: 2026-01-06
ブランチ: plan/bridge-safety-config

## 目的
- 破壊的操作の確認ゲートを allowlist/denylist で明示的に制御できるようにする。
- `unity.component.setSpriteReference` の GameObject 探索を、開いているシーン内のアクティブ/非アクティブまで拡張する。
- 曖昧な対象は候補一覧を返して停止し、ユーザー確認後に再実行できるようにする。

## スコープ
- Bridge: JSON 設定読み込み、toolName の glob マッチ、優先度ルール追加。
- Unity Editor 側: `SetSpriteReferenceBase64` の探索方式を変更。

## 方針（確定事項）
- JSON 設定ファイル: `cwd/mcp-bridge.config.json`
- 環境変数で上書き: `MCP_BRIDGE_CONFIG_PATH`
- マッチ対象: toolName 全体（例: `unity.scene.list`）
- マッチ方式: glob (`*`)
- 優先度: `denylist` > `unity.editor.invokeStaticMethod` 固定 > `allowlist` > 既存判定
- `unity.editor.invokeStaticMethod` は常に `__confirm` 必須
- GameObject 探索範囲: 開いているシーン内のアクティブ/非アクティブのみ（アセット/プレハブは除外）
- 曖昧時の確認フロー: 候補一覧を返して停止し、`path` 指定で再実行

## JSON 仕様（案）
```json
{
  "requireConfirmation": true,
  "confirm": {
    "allowlist": ["unity.scene.list", "unity.log.*"],
    "denylist": ["unity.asset.delete", "unity.*.destroy"]
  }
}
```

### JSON スキーマ（確定）
- ルート
  - `requireConfirmation`: boolean (optional)
  - `confirm`: object (optional)
    - `allowlist`: string[] (optional)
    - `denylist`: string[] (optional)
### 読み込み順（確定）
- `cwd/mcp-bridge.config.json` を読み込む
- `MCP_BRIDGE_CONFIG_PATH` があればそのパスを優先
- `MCP_REQUIRE_CONFIRMATION` が設定されている場合は env を優先
### glob 仕様（確定）
- 対象: toolName 全体（例: `unity.scene.list`）
- 方式: `*` のみサポート（`?` / `[]` / 正規表現は非対応）
- 大文字小文字: 無視（case-insensitive）
### 優先度（確定）
- `denylist` > `unity.editor.invokeStaticMethod` 固定 > `allowlist` > 既存判定
- `denylist` は常に強制（`requireConfirmation=false` でも確認必須）
- `bridge.*` は従来通り確認不要（例外扱い）

## 実装ステップ
1) Bridge 設定の読み込み
   - `lib/bridgeConfig.js` を新設し、JSON を読み込んで検証。
   - `createBridgeConfig` に allow/deny を統合。
2) 確認判定ロジックの更新
   - `isConfirmationRequiredToolName` に allow/deny と glob マッチを追加。
3) Unity 側の探索改善
   - `McpAssetImport.SetSpriteReferenceBase64` で GameObject 探索を差し替え。
   - `Resources.FindObjectsOfTypeAll<GameObject>()` + `EditorUtility.IsPersistent` + `scene.IsValid && scene.isLoaded` でシーン内のみ抽出。
   - `HierarchyPath` で一致判定し、複数候補は一覧を返して停止。
4) ドキュメント更新
   - `Server~/mcp-bridge/README.md` と `docs/wiki/MCP-Bridge.md` に JSON 設定を追記。
5) テスト更新
   - `Server~/mcp-bridge/test/bridgeLogic.test.js` に allow/deny 判定のテストを追加。

## テスト計画
- `cd Server~/mcp-bridge && npm test`
- `cd Server~/mcp-bridge && npm run test:coverage`
- `cd Server~/mcp-bridge && node scripts/e2e-setreference.js --project "<UnityProject>"`
- `cd Server~/mcp-bridge && node scripts/e2e-asset-import-reference.js --project "<UnityProject>"`

## リスク/注意
- glob の設定ミスで意図しない確認省略が起こり得るため、`denylist` を強く優先する。
- `Resources.FindObjectsOfTypeAll` の対象が広いため、必ず `scene.IsValid` と `EditorUtility.IsPersistent` で絞り込む。

## アウトオブスコープ
- アセット/プレハブを GameObject 探索に混在させる対応
- `unity.editor.invokeStaticMethod` の confirm 解除
