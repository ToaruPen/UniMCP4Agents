# 見積もり: bridgeLogic テスト分割（test）

### 0. 前提確認
- 実施順: core→test の 5/5
- 参照した一次情報: `.Plans/2026/01/refactor-bridge-tests-split.md:1`
- 参照した一次情報: `Server~/mcp-bridge/test/bridgeLogic.test.js:1`
- 参照した一次情報: `Server~/mcp-bridge/package.json:14`
- 不足/矛盾: なし

### 1. 依頼内容の解釈（引用）
- 「コア部分→テストの流れ」「上流から下流へ」「具体的なリファクタに関する見積もり」

### 2. 変更対象（ファイル:行）
- `Server~/mcp-bridge/test/bridgeLogic.test.js:1`
- `Server~/mcp-bridge/test/bridgeLogic.config.test.js:1 (新規)`
- `Server~/mcp-bridge/test/bridgeLogic.toolname.test.js:1 (新規)`
- `Server~/mcp-bridge/test/bridgeLogic.scene.test.js:1 (新規)`
- `Server~/mcp-bridge/test/bridgeLogic.asset.test.js:1 (新規)`
- `Server~/mcp-bridge/test/bridgeLogic.timeout.test.js:1 (新規)`

### 3. 作業項目と工数（コーディングエージェント作業のみ）
- 既存テストを領域別に分割して移動: 60分
- テスト実行と整合確認（`node --test`, `npm run test:coverage`）: 30分

### 4. DB 影響
- N/A（DBなし）

### 5. ログ出力
- N/A（ログ変更なし）

### 6. I/O 一覧
- ファイル読み込み/書き込み: N/A（I/O変更なし）
- ネットワーク通信: N/A
- DB I/O: N/A
- 外部プロセス/CLI: N/A
- ユーザー入力: N/A
- クリップボード/OS連携: N/A

### 7. リファクタ候補（必須）
- 候補なし（本チケットの分割のみ）

### 8. フェイズ分割
- フェイズ分割: なし（1フェイズ）
- テスト: `cd Server~/mcp-bridge && npm test`, `cd Server~/mcp-bridge && npm run test:coverage`

### 9. テスト計画
- `cd Server~/mcp-bridge && npm test`
- `cd Server~/mcp-bridge && npm run test:coverage`

### 10. 矛盾点/不明点/確認事項
- なし

### 11. 変更しないこと
- テスト内容・期待値の変更はしない
- カバレッジ閾値は変更しない
