# UniMCP4CC - Unity MCP Server for Claude Code

Unity Editor を Claude Code から操作するための MCP (Model Context Protocol) サーバーです。

> **Note**: このパッケージは **Claude Code 専用** に設計・テストされています。

## 動作環境

| 項目 | バージョン |
|-----|-----------|
| **Unity** | 6000.0.0 以降 (Unity 6) |
| **Node.js** | 18 以降 |
| **AI Client** | Claude Code (Anthropic) |

> **Important**: このパッケージは Unity 6 (6000.x) 向けにビルドされています。Unity 2021/2022 では動作しない可能性があります。

## 機能

Claude Code から Unity Editor を直接操作できます：

- **シーン操作**: GameObject の作成・削除・検索
- **コンポーネント操作**: コンポーネントの追加・削除・プロパティ変更
- **アセット操作**: アセットの検索・インポート・作成
- **プレハブ操作**: プレハブの作成・インスタンス化
- **オーディオ操作**: AudioSource の作成・再生制御

## インストール

### Unity Package Manager からインストール

Unity Editor で `Window > Package Manager` を開き、`+` > `Add package from git URL...` を選択:

```
https://github.com/dsgarage/UniMCP4CC.git
```

### Claude Code の設定

パッケージインストール後、Unity Editor で:

`Window > Unity MCP > Setup Claude Code`

表示されるウィンドウで「Setup Claude Code」ボタンをクリックすると、自動的に設定が行われます。

## 使用方法

1. Unity Editor を起動（MCP Server が自動起動します）
2. Claude Code を起動
3. Unity プロジェクトについて Claude Code に質問・指示

### 使用例

```
"Main Camera の位置を (0, 5, -10) に移動して"
"新しい Cube を作成して Player という名前をつけて"
"Player に Rigidbody コンポーネントを追加して"
```

> Note: 安全のため、削除/ビルド/インポート等の破壊的操作は `__confirm: true` を要求します（Bridge側）。
> さらに、破壊的操作で GameObject ターゲットが曖昧な場合は実行せずに失敗し、候補一覧（パス）を返します（Bridge側）。

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

詳細な API リファレンスは [Wiki](https://github.com/dsgarage/UniMCP4CC/wiki) を参照してください。

## アーキテクチャ

```
Claude Code → MCP Bridge (Node.js) → Unity MCP Server → Unity Editor
```

## トラブルシューティング

### 接続できない場合

1. Unity Editor が起動しているか確認
2. Console に `[MCP] HTTP Server started on port 5051` が表示されているか確認
3. Claude Code を再起動
4. Claude Code 側で `bridge.status` を実行し、接続状態と使用URLを確認

### Unity バージョンの互換性

このパッケージは Unity 6 (6000.x) 向けにビルドされています。
他のバージョンで問題が発生した場合は Issue を作成してください。

## ライセンス

MIT License

## 関連リンク

- [Claude Code](https://claude.ai/download)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [API Reference (Wiki)](https://github.com/dsgarage/UniMCP4CC/wiki)

---

Made with Claude Code by dsgarage
