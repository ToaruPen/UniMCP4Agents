# リファクタチケット: e2e-manual-ops の手順整理

## [Goal]
- `e2e-manual-ops.js` の直列手順を分割し、読みやすさと保守性を上げる。

## [Scope / Constraints]
- 編集対象: `Server~/mcp-bridge/scripts/e2e-manual-ops.js`
- 必要なら `Server~/mcp-bridge/scripts/_e2eUtil.js` に共通ヘルパを追加
- CLI オプション互換を維持（`--project`, `--unity-http-url`, `--verbose`）
- ついで修正は禁止

## [分割方針]
- 手順をステップ関数に分割（フォルダ作成 / シーン作成 / 階層構築 / コンポーネント追加 / 参照設定 / 破棄）。
- tool 選択ロジックと操作ロジックを分離。

## [AcceptanceCriteria]
- [ ] `node --check Server~/mcp-bridge/scripts/e2e-manual-ops.js` が通る
- [ ] 既存の E2E シナリオが最後まで実行できる（手動確認）
- [ ] 出力ログの要点が維持される
