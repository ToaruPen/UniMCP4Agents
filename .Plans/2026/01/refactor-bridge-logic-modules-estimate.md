# 見積もり: bridgeLogic モジュール分割（core）

### 0. 前提確認
- 実施順: core→test の 2/5
- 参照した一次情報: `.Plans/2026/01/refactor-bridge-logic-modules.md:1`
- 参照した一次情報: `Server~/mcp-bridge/lib/bridgeLogic.js:1`, `Server~/mcp-bridge/lib/bridgeLogic.js:64`, `Server~/mcp-bridge/lib/bridgeLogic.js:160`, `Server~/mcp-bridge/lib/bridgeLogic.js:329`, `Server~/mcp-bridge/lib/bridgeLogic.js:629`, `Server~/mcp-bridge/lib/bridgeLogic.js:862`, `Server~/mcp-bridge/lib/bridgeLogic.js:937`
- 参照した一次情報: `Server~/mcp-bridge/package.json:14`
- 不足/矛盾: `test:coverage` の include 対象を更新するかの方針

### 1. 依頼内容の解釈（引用）
- 「コア部分→テストの流れ」「上流から下流へ」「具体的なリファクタに関する見積もり」

### 2. 変更対象（ファイル:行）
- `Server~/mcp-bridge/lib/bridgeLogic.js:1`
- `Server~/mcp-bridge/lib/bridgeLogic.js:64`
- `Server~/mcp-bridge/lib/bridgeLogic.js:160`
- `Server~/mcp-bridge/lib/bridgeLogic.js:329`
- `Server~/mcp-bridge/lib/bridgeLogic.js:629`
- `Server~/mcp-bridge/lib/bridgeLogic.js:862`
- `Server~/mcp-bridge/lib/bridgeLogic.js:937`
- `Server~/mcp-bridge/lib/bridgeLogic/config.js:1 (新規)`
- `Server~/mcp-bridge/lib/bridgeLogic/toolName.js:1 (新規)`
- `Server~/mcp-bridge/lib/bridgeLogic/args.js:1 (新規)`
- `Server~/mcp-bridge/lib/bridgeLogic/scene.js:1 (新規)`
- `Server~/mcp-bridge/lib/bridgeLogic/asset.js:1 (新規)`
- `Server~/mcp-bridge/lib/bridgeLogic/timeout.js:1 (新規)`
- `Server~/mcp-bridge/lib/bridgeLogic/log.js:1 (新規)`
- `Server~/mcp-bridge/package.json:14` (必要時)

### 3. 作業項目と工数（コーディングエージェント作業のみ）
- 機能別モジュール作成と関数移動（config/toolName/args/scene/asset/timeout/log）: 150分
- `bridgeLogic.js` を re-export バレル化し、import 経路を維持: 30分
- テスト/カバレッジ確認と必要調整: 40分

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
- `test:coverage` の include 対象を `lib/bridgeLogic.js` 以外にも拡張するかの方針確認
- 新規モジュール名の確定（`config/toolName/args/scene/asset/timeout/log`）

### 11. 変更しないこと
- export 名や挙動の変更はしない
- 既存のエラー文言・確認ゲート判定の仕様は変えない
