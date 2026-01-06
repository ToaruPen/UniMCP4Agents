# Tools Overview

## ツールの取得

ツール一覧は MCP クライアント側の `tools/list` で取得できます。

## 命名規約（例）

- `unity.*`: Unity Editor 操作（シーン / GameObject / アセット / エディタ等）
- `bridge.*`: Bridge 自身の補助ツール

## 依存パッケージについて

`unity.*` のツールには、導入されていない Unity パッケージ向けのものも含まれます。
該当パッケージが未導入の場合、呼び出し時にエラーになります。

Bridge は `tools/list` の description に `[Optional] ...` の注記を追加します（ツールは非表示にしません）。
注記があるツールは、必要な Unity パッケージ/拡張がプロジェクト側に導入されているか確認してください。

### 重要: 「パッケージ未導入」エラーでも本当の原因が別の場合があります

`unity.uitoolkit.*` / `unity.cinemachine.*` / `unity.timeline.*` のように、**Unity パッケージとは別に追加の Editor 拡張アセンブリが必要**なツール群があります。

- UI Toolkit: Samples の `UIToolkit Extension` を Import すると利用できます（`LocalMcp.UnityServer.UIToolkit.Editor`）
- Cinemachine / Timeline: `tools/list` には表示されますが、**本リポジトリの配布物には対応する Editor 拡張が同梱されていないため利用できません**  
  （エラー文言は「com.unity.cinemachine / com.unity.timeline が未導入」と表示されることがあります）

この場合は `unity.scene.*` / `unity.gameObject.*` / `unity.component.*` / `unity.asset.*` / `unity.editor.executeMenuItem` などの汎用ツールで代替してください（詳細は `docs/wiki/Troubleshooting.md` を参照）。

## 主なカテゴリ（例）

- scene / gameObject / component / transform
- asset / prefab / audio
- editor / log

## 引数の互換（キー別名）

ツールによってはスキーマ上のキーと Unity 側の実引数が一致しない場合があります。
Bridge は一部ツールについてキー別名を自動で補完します（詳細は `Server~/mcp-bridge/README.md`）。

## ログ運用（推奨）

制作中の見落とし（Unity Console の Warning/Error）を減らすため、各 `unity.*` ツール呼び出しの直後に `unity.log.history` を実行して Error/Warning を確認する運用を推奨します。

- 例: `unity.log.history({ limit: 200, level: "Error,Warning" })`

## Bridge 補助ツール（例）

- `unity.assetImport.setTextureType`
  - `LocalMcp.UnityServer.AssetImport.Editor` 未導入でも、TextureImporter の `textureType`（例: `Sprite`）を変更できます（必要なら reimport）。
  - アセット設定変更＋再import を伴うため、`__confirm: true` が必要です。
- `unity.component.add`
  - `SpriteRenderer` 追加時に `removeConflictingRenderers: true` を指定すると `MeshFilter` / `MeshRenderer` を自動で外します（`__confirm: true` 必須）。
- `unity.component.setReference`（Sprite フィールド）
  - `Assets/...png` など Texture のパスを渡したとき、Unity側が main asset（Texture2D）を返して `Sprite` と型不一致になる場合があります。
  - Bridge は **自動フォールバックは行いません**（sprite sheet 等で暗黙に“どれか1つ”を選ぶのを避けるため）。
  - `unity.assetImport.listSprites` で候補（`spriteNames`）を取得し、`unity.component.setSpriteReference` で `spriteName` を明示して設定してください。
- `unity.gameObject.createEmptySafe`
  - 空の GameObject を安全に作成します（`parentPath`/`active` は任意）。

## Tilemap 作成の注意（2D）

`TilemapRenderer` は `MeshFilter` / `MeshRenderer` 等と競合するため、primitive（Cube/Quad 等）に追加すると失敗します。
Tilemap 用 GameObject は「空の GameObject」（`unity.gameObject.createEmptySafe`）から作る（または `unity.editor.executeMenuItem("GameObject/2D Object/Tilemap/Rectangular")` を使う）ことを推奨します。
