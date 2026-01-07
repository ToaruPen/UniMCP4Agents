# 見積もり: Editor 共有ヘルパ抽出（core）

### 0. 前提確認
- 実施順: core→test の 3/5
- 参照した一次情報: `.Plans/2026/01/refactor-editor-shared-helpers.md:1`
- 参照した一次情報: `Editor/McpAssetImport.cs:411`, `Editor/McpAssetImport.cs:456`, `Editor/McpAssetImport.cs:734`, `Editor/McpComponentTools.cs:228`, `Editor/McpComponentTools.cs:273`, `Editor/McpComponentTools.cs:448`, `Editor/McpGameObjectTools.cs:160`, `Editor/McpGameObjectTools.cs:205`
- 不足/矛盾: 新規ヘルパの正式クラス名の確定

### 1. 依頼内容の解釈（引用）
- 「コア部分→テストの流れ」「上流から下流へ」「具体的なリファクタに関する見積もり」

### 2. 変更対象（ファイル:行）
- `Editor/McpAssetImport.cs:411`
- `Editor/McpAssetImport.cs:456`
- `Editor/McpAssetImport.cs:734`
- `Editor/McpComponentTools.cs:228`
- `Editor/McpComponentTools.cs:273`
- `Editor/McpComponentTools.cs:448`
- `Editor/McpGameObjectTools.cs:160`
- `Editor/McpGameObjectTools.cs:205`
- `Editor/McpEditorSceneQuery.cs:1 (新規)`
- `Editor/McpEditorSceneQuery.cs.meta:1 (新規)`
- `Editor/McpEditorTypeResolver.cs:1 (新規)`
- `Editor/McpEditorTypeResolver.cs.meta:1 (新規)`

### 3. 作業項目と工数（コーディングエージェント作業のみ）
- Scene/Hierarchy 検索系ヘルパ抽出（`FindSceneGameObjectsBy*`, `BuildCandidatePaths`, `GetHierarchyPath`）: 90分
- Type 解決ヘルパ抽出（`ResolveType*`, `TypeCache`）: 60分
- 既存 3 ファイルの置き換え・動作確認準備: 60分

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
- フェイズ分割: 2フェイズ（Scene 検索系 / Type 解決系を分離）
- フェイズ1: Scene 検索ヘルパ抽出 → Unity Editor でコンパイル確認
- フェイズ2: Type 解決ヘルパ抽出 → Unity Editor でコンパイル確認

### 9. テスト計画
- Unity Editor でコンパイル確認（手動）
- `unity.component.add` / `unity.component.setSpriteReference` / `unity.gameObject.createEmptySafe` の簡易動作確認（手動）

### 10. 矛盾点/不明点/確認事項
- 新規ヘルパのクラス名確定（`McpEditorSceneQuery` / `McpEditorTypeResolver`）
- `.meta` の付与タイミング（Unity で生成するか手動追加するか）

### 11. 変更しないこと
- public API/エラーメッセージは変更しない
- 既存の探索結果順序や候補制限値は変更しない
