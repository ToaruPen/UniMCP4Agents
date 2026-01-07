# 見積もり: e2e-manual-ops 手順整理（test）

### 0. 前提確認
- 実施順: core→test の 4/5
- 参照した一次情報: `.Plans/2026/01/refactor-e2e-manual-ops.md:1`
- 参照した一次情報: `Server~/mcp-bridge/scripts/e2e-manual-ops.js:20`, `Server~/mcp-bridge/scripts/e2e-manual-ops.js:57`, `Server~/mcp-bridge/scripts/e2e-manual-ops.js:106`, `Server~/mcp-bridge/scripts/e2e-manual-ops.js:127`, `Server~/mcp-bridge/scripts/e2e-manual-ops.js:263`, `Server~/mcp-bridge/scripts/e2e-manual-ops.js:280`
- 不足/矛盾: なし

### 1. 依頼内容の解釈（引用）
- 「コア部分→テストの流れ」「上流から下流へ」「具体的なリファクタに関する見積もり」

### 2. 変更対象（ファイル:行）
- `Server~/mcp-bridge/scripts/e2e-manual-ops.js:20`
- `Server~/mcp-bridge/scripts/e2e-manual-ops.js:57`
- `Server~/mcp-bridge/scripts/e2e-manual-ops.js:106`
- `Server~/mcp-bridge/scripts/e2e-manual-ops.js:127`
- `Server~/mcp-bridge/scripts/e2e-manual-ops.js:263`
- `Server~/mcp-bridge/scripts/e2e-manual-ops.js:280`
- `Server~/mcp-bridge/scripts/_e2eUtil.js:1` (必要時)

### 3. 作業項目と工数（コーディングエージェント作業のみ）
- ステップ関数の分割（フォルダ/シーン/階層/参照/破棄）: 60分
- tool 選択と操作ロジックの分離・ヘルパ化: 45分
- `node --check` と手動 E2E 実行準備: 30分

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
- テスト: `node --check Server~/mcp-bridge/scripts/e2e-manual-ops.js`

### 9. テスト計画
- `node --check Server~/mcp-bridge/scripts/e2e-manual-ops.js`
- `cd Server~/mcp-bridge && node scripts/e2e-manual-ops.js --project "<UnityProject>"`

### 10. 矛盾点/不明点/確認事項
- なし

### 11. 変更しないこと
- CLI 引数仕様（`--project`, `--unity-http-url`, `--verbose`）は変更しない
- ログ文言の要点は維持する
