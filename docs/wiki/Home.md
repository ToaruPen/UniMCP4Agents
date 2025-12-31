# UniMCP4CC Docs (Wiki)

このドキュメントは UniMCP4CC の「Wiki 相当」をリポジトリ内に同梱したものです。
（現状、このリポジトリでは GitHub Wiki（`*.wiki.git`）が作成できないため、こちらを正本として整備します）

## Quick Start

1. Unity Package Manager でインストール（Git URL）
2. Unity プロジェクトを起動（Unity 側 HTTP サーバーが自動起動）
3. MCP クライアントから `Server~/mcp-bridge/index.js` を stdio サーバーとして起動
4. `bridge.status` / `bridge.ping` で接続確認
5. 作業中は `unity.log.history` で Unity Console の Error/Warning を確認（推奨）

## 目次

- [Getting Started](Getting-Started.md)
- [MCP Bridge](MCP-Bridge.md)
- [Tools Overview](Tools.md)
- [UI Toolkit Extension](UI-Toolkit.md)
- [Troubleshooting](Troubleshooting.md)
