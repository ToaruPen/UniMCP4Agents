# UniMCP4CC - Unity MCP Server (MCP)

Unity Editor を MCP (Model Context Protocol) 対応クライアントから操作するためのサーバーです。

> **Note**: 本家 UniMCP4CC（Claude Code 向け）をベースにしていますが、README は **MCP クライアント一般**で使う前提で記載しています。
> Claude Code 向けのセットアップ UI も同梱しています（後述）。他クライアントでも Bridge を手動設定すれば利用できます。

## できること（概要）

Unity Editor を “状態取得 → 判断 → 変更 → 検証” のループで操作できます。

- **ヒエラルキー / シーン**: GameObject の作成・検索・階層の取得・親子付け替え・Active 切替、Scene の作成/保存/オープン
- **Transform / コンポーネント**: Transform（位置/回転/スケール）変更、Component の追加・削除・プロパティ変更
- **アセット / インポート**: アセットの作成・一覧・削除、各種インポート操作
- **エディタ / プロジェクト**: パッケージ・テスト・ログ取得など（導入済みパッケージに応じて拡張）

> **補足**: `unity.*` ツールには、導入されていない Unity パッケージ向けのものも含まれます。該当パッケージが未導入の場合、呼び出し時にエラーになります。
> ツール一覧は MCP クライアントの `tools/list` で取得できます（例: Unity 6 環境で合計 778 ツールを確認。プロジェクト/導入パッケージにより変動）。

## 動作環境

| 項目 | バージョン |
|-----|-----------|
| **Unity** | 6000.0.0 以降 (Unity 6) |
| **Node.js** | 18 以降 |
| **MCP Client** | MCP tools（stdio）対応のクライアント |

> **Important**: このパッケージは Unity 6 (6000.x) 向けにビルドされています。Unity 2021/2022 では動作しない可能性があります。

## 機能

MCP クライアントから Unity Editor を直接操作できます：

- **シーン操作**: GameObject の作成・削除・検索
- **コンポーネント操作**: コンポーネントの追加・削除・プロパティ変更
- **アセット操作**: アセットの検索・インポート・作成
- **プレハブ操作**: プレハブの作成・インスタンス化
- **オーディオ操作**: AudioSource の作成・再生制御
- **エディタ操作**: パッケージ / テスト / ログ取得など（導入状況に依存）

## インストール

### Unity Package Manager からインストール

Unity Editor で `Window > Package Manager` を開き、`+` > `Add package from git URL...` を選択:

```
https://github.com/ToaruPen/UniMCP4CC.git
```

### MCP クライアントの設定

このパッケージは Unity 側で HTTP サーバーを起動し、`Server~/mcp-bridge` が MCP（stdio）⇔ Unity HTTP をブリッジします。

#### Claude Code（自動）

パッケージインストール後、Unity Editor で:

`Window > Unity MCP > Setup Claude Code`

表示されるウィンドウで設定生成ボタンをクリックすると、自動的に設定が行われます。

#### その他の MCP クライアント（手動）

お使いの MCP クライアントで、`Server~/mcp-bridge/index.js` を **stdio サーバーとして起動**するよう設定してください。

- `cwd` は Unity プロジェクトルート（`.unity-mcp-runtime.json` がある場所）に設定
- もしくは `UNITY_HTTP_URL=http://localhost:5051` を環境変数で指定

詳細は `Server~/mcp-bridge/README.md` を参照してください。

## 使用方法

1. Unity Editor を起動（MCP Server が自動起動します）
2. MCP クライアントを起動
3. Unity プロジェクトについて指示（ツール呼び出し）

### 使用例

```
"Main Camera の位置を (0, 5, -10) に移動して"
"新しい Cube を作成して Player という名前をつけて"
"Player に Rigidbody コンポーネントを追加して"
```

> Note: 安全のため、削除/ビルド/インポート等の破壊的操作は `__confirm: true` を要求します（Bridge側）。
> さらに、破壊的操作で GameObject ターゲットが曖昧な場合は実行せずに失敗し、候補一覧（パス）を返します（Bridge側）。

## 安全機構（Bridge）

`Server~/mcp-bridge` は MCP クライアントと Unity HTTP サーバーの間に入り、誤操作を減らすためのガードを提供します。

- **確認フラグ**: 破壊的操作は `__confirm: true` が必須（任意で `__confirmNote`）
- **曖昧ターゲットの拒否**: 破壊的操作で target が曖昧な場合、`unity.scene.list` を使って候補一覧（パス）を返して停止
- **タイムアウト制御**: `__timeoutMs`（または `__timeout_ms` / `__timeout`）で 1 回の呼び出しだけ延長可能
- **Bridge 付属ツール**: `bridge.status` / `bridge.ping` / `bridge.reload_config`

## UI Toolkit について

`unity.uitoolkit.*` ツール群は一覧に表示されますが、利用には追加の拡張が必要です。

- **必要な拡張**: `LocalMcp.UnityServer.UIToolkit.Editor`
- **症状**: 未導入だと `unity.uitoolkit.*` の呼び出しが「必要なパッケージが未インストール」というエラーで失敗します

### 導入（任意）

このパッケージには、UI Toolkit 拡張 DLL を **Samples** として同梱しています（既定では読み込まれません）。

1. Unity Editor で `Window > Package Manager` を開く
2. `UniMCP4CC`（`com.dsgarage.unimcp4cc`）を選択
3. **Samples** の `UIToolkit Extension` を **Import** する

> `com.unity.ui.test-framework`（UI Test Framework）は上記拡張の代替ではありません。

## API カテゴリ

| カテゴリ | 説明 |
|---------|------|
| scene | シーン操作 |
| gameObject | GameObject 操作 |
| component | コンポーネント操作 |
| transform | Transform 操作 |
| asset | アセット操作 |
| prefab | プレハブ操作 |
| audio | オーディオ操作 |
| editor | エディタ操作 |
| log | ログ操作 |

詳細な API リファレンスは [Wiki](https://github.com/ToaruPen/UniMCP4CC/wiki) を参照してください。
Bridge（Node）の詳細は `Server~/mcp-bridge/README.md` を参照してください。

## アーキテクチャ

```
MCP Client → MCP Bridge (Node.js/stdio) → Unity MCP Server (HTTP) → Unity Editor
```

## テスト（Bridge）

Unity Editor を起動した状態で、`Server~/mcp-bridge` の E2E スモークテストを実行できます。

```bash
cd Server~/mcp-bridge
npm install
npm run smoke -- --project "/path/to/your/unity/project"
```

## トラブルシューティング

### 接続できない場合

1. Unity Editor が起動しているか確認
2. Console に `[MCP] HTTP Server started on port 5051` が表示されているか確認
3. MCP クライアントを再起動
4. `bridge.status` を実行し、接続状態と使用URLを確認

### Unity バージョンの互換性

このパッケージは Unity 6 (6000.x) 向けにビルドされています。
他のバージョンで問題が発生した場合は Issue を作成してください。

## ライセンス

MIT License

## 関連リンク

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [API Reference (Wiki)](https://github.com/ToaruPen/UniMCP4CC/wiki)
