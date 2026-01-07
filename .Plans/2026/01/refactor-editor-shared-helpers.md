# リファクタチケット: Editor 共有ヘルパ抽出

## [Goal]
- Scene/Hierarchy 検索と Type 解決の重複を削減し、Editor ツールの保守性を上げる。

## [Scope / Constraints]
- 編集対象: `Editor/McpAssetImport.cs`, `Editor/McpComponentTools.cs`, `Editor/McpGameObjectTools.cs`
- 新規: `Editor/McpEditorSceneQuery.cs` / `Editor/McpEditorTypeResolver.cs`（名称は実装時に確定）
- 既存 API とエラーメッセージを維持
- Editor 内の責務範囲を超えない（新しい Manager/Service は導入しない）
- ついで修正は禁止

## [分割方針]
- Scene 検索系（`FindSceneGameObjectsBy*`, `EnumerateLoadedScenes`, `BuildCandidatePaths`, `GetHierarchyPath`）を共有ヘルパへ抽出。
- Type 解決系（`ResolveType*`, `TypeCache`）を共有ヘルパへ抽出。
- ファイル固有の処理（SpriteRenderer の競合除去等）は元ファイルに残す。

## [AcceptanceCriteria]
- [ ] Unity Editor でコンパイルが通る
- [ ] `unity.component.add` が従来通り動作する
- [ ] `unity.component.setSpriteReference` が従来通り動作する
- [ ] `unity.gameObject.createEmptySafe` が従来通り動作する
- [ ] 挙動変更なし（候補順序・エラー文言を維持）
