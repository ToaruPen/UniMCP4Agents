# 見積もり: UnityMCPServer 分割（core）

### 0. 前提確認
- 実施順: core→test の 1/5
- 参照した一次情報: `.Plans/2026/01/refactor-bridge-unitymcpserver-split.md:1`
- 参照した一次情報: `Server~/mcp-bridge/lib/UnityMCPServer.js:83`, `Server~/mcp-bridge/lib/UnityMCPServer.js:238`, `Server~/mcp-bridge/lib/UnityMCPServer.js:483`, `Server~/mcp-bridge/lib/UnityMCPServer.js:946`, `Server~/mcp-bridge/lib/UnityMCPServer.js:1352`, `Server~/mcp-bridge/lib/UnityMCPServer.js:1472`, `Server~/mcp-bridge/lib/UnityMCPServer.js:1526`, `Server~/mcp-bridge/lib/UnityMCPServer.js:1809`
- 不足/矛盾: 新規モジュール名の確定（`unityRpc.js` / `unityToolHandlers.js` の採用可否）

### 1. 依頼内容の解釈（引用）
- 「コア部分→テストの流れ」「上流から下流へ」「具体的なリファクタに関する見積もり」

### 2. 変更対象（ファイル:行）
- `Server~/mcp-bridge/lib/UnityMCPServer.js:83`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:238`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:319`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:483`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:548`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:593`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:672`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:714`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:842`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:867`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:946`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:1352`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:1472`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:1526`
- `Server~/mcp-bridge/lib/UnityMCPServer.js:1809`
- `Server~/mcp-bridge/lib/unityRpc.js:1 (新規)`
- `Server~/mcp-bridge/lib/unityToolHandlers.js:1 (新規)`

### 3. 作業項目と工数（コーディングエージェント作業のみ）
- RPC/ユーティリティ関数の抽出（`buildEmptyAssetResult`, `tryCallUnityTool`, `stringifyToolCallResult` など）: 60分
- tool ハンドラ群の抽出（`handle*` 関数群）: 120分
- `UnityMCPServer` から新モジュールへ配線・import 整理: 30分
- テスト/起動確認（`node --check`, `node --test`）: 30分

### 4. DB 影響
- N/A（DBなし）

### 5. ログ出力
- N/A（ログ変更なし）

### 6. I/O 一覧
- ファイル読み込み/書き込み: N/A（I/O変更なし）
- ネットワーク通信: N/A（既存HTTP呼び出しの移動のみ）
- DB I/O: N/A
- 外部プロセス/CLI: N/A
- ユーザー入力: N/A
- クリップボード/OS連携: N/A

### 7. リファクタ候補（必須）
- 候補なし（本チケットの分割のみ）

### 8. フェイズ分割
- フェイズ分割: 2フェイズ（リスク低減のため）
- フェイズ1: RPC/ユーティリティ抽出 → テスト `node --check Server~/mcp-bridge/index.js`, `cd Server~/mcp-bridge && npm test`
- フェイズ2: tool ハンドラ抽出 → テスト `node --check Server~/mcp-bridge/index.js`, `cd Server~/mcp-bridge && npm test`

### 9. テスト計画
- `node --check Server~/mcp-bridge/index.js`
- `cd Server~/mcp-bridge && npm test`
- `cd Server~/mcp-bridge && npm run test:coverage`

### 10. 矛盾点/不明点/確認事項
- 新規モジュール名の確定（`unityRpc.js` / `unityToolHandlers.js`）
- ハンドラ分割の粒度（単一モジュール or 機能別モジュール）

### 11. 変更しないこと
- tool 名・入出力スキーマ・エラー文言の変更はしない
- 環境変数/設定の意味は変更しない
- 既存ログの文言/頻度は変更しない
