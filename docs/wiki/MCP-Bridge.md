# MCP Bridge

`Server~/mcp-bridge` は MCP クライアント（stdio）と Unity HTTP サーバー（既定: `http://localhost:5051`）の間に入り、以下を提供します。

- 安全ゲート（破壊的操作の確認、曖昧ターゲットのブロック）
- タイムアウト制御（既定/重い処理/上限）
- 引数の互換（キー別名の付与など）
- Bridge 付属ツール（`bridge.status` / `bridge.ping` / `bridge.reload_config`）

## 設定の読み込み順

1. `.unity-mcp-runtime.json`（Unity が生成、HTTP ポート情報）
2. `mcp-bridge.config.json`（Bridge 設定: 確認ゲートの allow/deny など。`MCP_BRIDGE_CONFIG_PATH` があればそのパスを優先）
3. 環境変数（例: `UNITY_HTTP_URL`）

主要な環境変数は `Server~/mcp-bridge/README.md` を参照してください。

## 確認ゲートの allow/deny（任意）

Unity プロジェクトルートに `mcp-bridge.config.json` を置くと、確認ゲートを allowlist/denylist で制御できます。

例:
```json
{
  "requireConfirmation": true,
  "confirm": {
    "allowlist": ["unity.scene.list", "unity.log.*"],
    "denylist": ["unity.asset.delete", "unity.*.destroy"]
  }
}
```

ルール:
- 対象は toolName 全体（例: `unity.scene.list`）
- ワイルドカードは `*` のみ（大小文字は区別しない）
- 優先度: `denylist` > `unity.editor.invokeStaticMethod` 固定 > `allowlist` > 既存判定
- `bridge.*` は例外扱いで常に確認不要（allow/deny の対象外）
- `MCP_REQUIRE_CONFIRMATION=false` の場合でも `denylist` は常に強制
- JSON の変更は Bridge 再起動が必要

補足:

- `UNITY_HTTP_URL` が `localhost/127.0.0.1/::1` 以外を指す場合、Bridge は誤設定防止のため警告します
- 意図したリモート接続の場合は `MCP_ALLOW_REMOTE_UNITY_HTTP_URL=true` で警告を抑制できます
- 安全優先で非local を拒否したい場合は `MCP_STRICT_LOCAL_UNITY_HTTP_URL=true` を使用します

## Per-call Timeout Override

特定のツール呼び出しだけタイムアウトを延長したい場合、ツール引数に以下を指定できます（Bridge が剥がして転送します）。

- `__timeoutMs`
- `__timeout_ms`
- `__timeout`

## unity.log.history の任意切り詰め（Opt-in）

長大なログを扱いたいケースがあるため、`unity.log.history` のメッセージ/スタックトレース切り詰めは **任意**（指定時のみ）です。

- `__maxMessageChars` / `__max_message_chars`（メッセージ最大文字数）
- `__maxStackTraceChars` / `__max_stack_trace_chars`（スタックトレース最大文字数）

これらのキーは Bridge が剥がし、Unity には転送しません。

## 運用: 各ツール呼び出し後にログ確認（推奨）

制作中は「ツールの返り値は success だが、Unity Console に Warning/Error が出ていた」ケースが起きます。
見落としを減らすため、コーディングエージェント運用では **各 `unity.*` ツール呼び出しの直後に `unity.log.history` を必ず実行**することを推奨します。

- 推奨例: `unity.log.history({ limit: 200, level: "Error,Warning" })`
- Bridge 経由で長いログが必要な場合は `__maxMessageChars` / `__maxStackTraceChars` で切り詰め（Opt-in）

判断の目安:

- `[MCP]` / `LocalMcp` が含まれる Error/Warning は MCP 操作起因の可能性が高い
- 既知の注意（例: `[MCP Config] ... using defaults`）は、運用上問題なければ無視してよい

## 安全ゲート: unity.editor.invokeStaticMethod

`unity.editor.invokeStaticMethod` は Unity Editor 内の public static メソッドを任意実行できるため、Bridge では **既定で無効**（`tools/list` からも除外）です。

- 有効化: `MCP_ENABLE_UNSAFE_EDITOR_INVOKE=true`
- 有効化しても **常に** `__confirm: true` が必要です

なお `unity.editor.listMenuItems` は Bridge 側で安全な専用実装を呼び出すため、通常は `unity.editor.invokeStaticMethod` を有効化する必要はありません。
必要な機能が `invokeStaticMethod` にしか無い場合でも、まずは **allowlist 化した専用ツール（Bridge override / Editor拡張）** を追加する方針を推奨します（恒常的な unsafe ON を避ける）。

## Optional tools の注記

導入されていない Unity パッケージ/拡張に依存するツールは `tools/list` の description に `[Optional] ...` の注記を付与します。

## E2E Smoke Test

Unity Editor を起動した状態で、Bridge の簡易 E2E テストを実行できます。

```bash
cd Server~/mcp-bridge
npm install
npm run smoke -- --project "/path/to/your/unity/project"
```
