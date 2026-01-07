# リファクタチケット: UnityMCPServer の責務分割

## [Goal]
- `UnityMCPServer.js` を機能別に分割し、変更容易性と見通しを向上させる。

## [Scope / Constraints]
- 編集対象: `Server~/mcp-bridge/lib/UnityMCPServer.js`
- 新規候補: `Server~/mcp-bridge/lib/unityToolHandlers.js`, `Server~/mcp-bridge/lib/unityRpc.js`（名称は実装時に確定）
- `UnityMCPServer` の export と public API を維持
- 既存のログ/エラー文言・tool 名の挙動を変えない
- ついで修正は禁止

## [分割方針]
- Unity RPC 呼び出し/レスポンス整形をユーティリティへ移動。
- tool 固有ハンドラ群をモジュール化（asset/component/scene 等で整理）。
- `UnityMCPServer` クラスは配線/ディスパッチ中心に寄せる。

## [AcceptanceCriteria]
- [ ] `node --check Server~/mcp-bridge/index.js` が通る
- [ ] `node --test` が通る
- [ ] `node Server~/mcp-bridge/index.js` が起動できる（手動確認）
- [ ] tool 挙動が従来通り（入出力スキーマ・エラー文言を維持）
