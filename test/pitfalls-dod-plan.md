# UniMCP4CC: 5つの「落とし穴」クローズ DoD / テストケース / 実装計画（Ash-n-Circuit非接触）

このドキュメントは、UniMCP4CC（Unity MCP Server + Node MCP Bridge）を **2Dゲーム制作（Ash-n-Circuit）に導入する前提**で、
既知の「落とし穴」5点を **“制作で詰まらない状態”にクローズ**するための **DoD（受け入れ条件）**と、実装/テストの計画をまとめます。

> 重要: この計画は **Ash-n-Circuit（ゲーム本体）には一切触れない**。検証は **Unityテストプロジェクト**（`.../GitHub/Test/My project`）のみで行う。

---

## 0. 前提 / 制約

- 対象リポジトリ: `.../GitHub/Unity_MCP/UniMCP4CC`
- Unityサーバー本体は DLL 配布であり中身を直せない（基本方針）  
  → Bridge / Editor拡張 / docs / tests で吸収する
- 安全設計は維持する（破る場合は代替案とリスクを明記する）
  - confirmゲート（破壊的操作の `__confirm: true` 必須）
  - 曖昧ターゲットブロック（破壊系は候補提示で停止）
  - `unity.editor.invokeStaticMethod` は既定OFF（`tools/list` 非表示 + `tools/call` ブロック）

---

## 1. 優先度（実装順）

- **P0**: 1) `unity.component.setReference` の詰まり吸収（参照配線は制作の頻出動線）
- **P0**: 2) Tilemap作成/TilemapRenderer追加の罠（2D制作の初手で詰む）
- **P0**: 3) UI Toolkit runtime の詰まり吸収（UI Toolkit 制作の頻出動線）
- **P1**: 4) 揺れ（PlayMode/再コンパイル）時の運用・ノイズ低減（停止を防ぐ）
- **P2**: 5) invokeStaticMethod既定OFFの妥当性（方針維持＋必要時はallowlistで拡張）

---

## 2. テスト戦略（自動化の粒度）

### 2.1 Unit（Node, Bridge単体）

- 目的: 正規化/推論/エラー整形が **Unityに依存せず**回帰しないこと
- 実装先（例）:
  - `Server~/mcp-bridge/lib/bridgeLogic.js`（純関数化しやすい箇所）
  - `Server~/mcp-bridge/test/bridgeLogic.test.js`

### 2.2 E2E（Node → Bridge → Unity）

- 目的: 実プロジェクト導入前に **Unityとの実際の往復**で詰まりが消えたことを保証する
- 既存:
  - `npm run smoke -- --project "/path/to/Test/My project"`
  - `node scripts/playmode-ab.js --project "/path/to/Test/My project" --cycles 10`
- 追加方針:
  - `scripts/e2e-setreference.js`（参照配線専用）
  - `scripts/e2e-tilemap.js`（Tilemap罠専用）
  - `scripts/e2e-uitoolkit.js`（UI Toolkit runtime/スキーマ互換）
  - `scripts/e2e-invoke-safety.js`（安全設計の回帰防止）
  - `scripts/e2e-recompile-jitter.js`（再コンパイル瞬断の見え方/復帰）
  - `scripts/e2e-prefab.js`（Prefab 作成/Instantiate/Apply/Revert/Unpack）
  - `scripts/e2e-asset-import-reference.js`（Asset import/参照配線: Material/Texture2D/Sprite）
  - `scripts/e2e-ambiguous-destroy.js`（曖昧ターゲットブロック: destroy の候補提示）

> 注: 既存 `scripts/e2e-smoke.js` のように、`tools/list` の schema に合わせてキーを動的に選ぶ（堅牢化）方針を踏襲する。

---

## 3. 共通 DoD（全体）

### 3.1 必須（マージ条件）

- `cd Server~/mcp-bridge && npm test` が PASS
- `cd Server~/mcp-bridge && npm run smoke -- --project "/path/to/Test/My project"` が PASS
- `cd Server~/mcp-bridge && node scripts/playmode-ab.js --project "/path/to/Test/My project" --cycles 50` が完走し、以下を満たす:
  - `metrics[*].playCall.isError === false`
  - `metrics[*].stopCall.isError === false`
  - `metrics[*].playStatus.isError === false`（ツールが存在する場合）
  - `metrics[*].stopStatus.isError === false`（同上）
- 安全方針が回帰していない（後述の INV 系 + 曖昧ターゲットブロックのテストが PASS）

### 3.2 推奨（リリース品質）

- E2E スクリプトが失敗時に「次に見るべきログ/再試行手順」を標準出力へ出す（運用導線）
- コーディングエージェント運用では、各 `unity.*` ツール呼び出しの直後に `unity.log.history({ level: "Error,Warning" })` を実行し、Unity Console の Warning/Error を必ず確認する（見落とし防止）
- `MCP_VERBOSE=true` のとき、Bridgeログが「再接続」「runtime config再読込」「ブロック理由」を追跡できる

---

## 4. 落とし穴別 DoD とテストケース（Given/When/Then）

### 4.1 (P0) `unity.component.setReference` が実運用で詰まりやすい

#### DoD（必須）

- `tools/list` 上で `unity.component.setReference` の入力要件が、実際のUnity側バリデーションと矛盾しない（少なくとも `referenceType` の存在と意味が説明される）
- MCPクライアントが `referenceType` を省略しても、Bridgeが安全に補完して以下が成功する（Testプロジェクト内の最小構成でOK）:
  - GameObject参照
  - Component参照
  - Asset参照（Material/Texture2D/Sprite。Sprite は Texture パスからでも詰まらないこと）
- 失敗時は Bridge が「不足引数」「期待する referenceType」「referencePath の期待形式」を含むガイドを返し、試行錯誤が2回以内で終わる

#### テストケース（SR = SetReference）

**SR-00 事前条件（共通）**
- Given: Unity Editor が起動し、Testプロジェクトで MCP HTTP server が起動している（`.unity-mcp-runtime.json` が生成済み）
- And: Node から `npm run smoke ...` が通る状態

**SR-01 スキーマ整合（tools/list）**
- Given: MCPクライアントで `tools/list` を取得済み
- When: `unity.component.setReference` の tool schema を確認する
- Then: `referenceType`（または同等の必須分類キー）が存在し、説明がある（required扱いでも anyOf でもよいが「どう呼べばよいか」が明確）

**SR-02 GameObject参照（referenceType省略で成功）**
- Given: シーンに `SR_Source` と `SR_Target` の GameObject が存在する
- And: `SR_Source` に `SetReferenceFixture` コンポーネントが付いている（`public GameObject target;` を持つ）
- When: `unity.component.setReference` を `{ path: "SR_Source", componentType: "SetReferenceFixture", fieldName: "target", referencePath: "SR_Target" }` 相当で呼ぶ（referenceType省略）
- Then: 呼び出しが成功する
- And: `unity.component.inspect` または `unity.component.getProperty` 相当で `target` が `SR_Target` を指していることを確認できる

**SR-03 Component参照（referenceType省略で成功）**
- Given: `SR_Target` に `Transform` など参照対象コンポーネントが存在する
- And: `SR_Source` の `SetReferenceFixture` に `public Transform targetTransform;` がある
- When: `fieldName: "targetTransform"` を指定して `setReference` を呼ぶ（referenceType省略）
- Then: 成功し、参照が張られている

**SR-04 明示指定の優先（ユーザー指定を壊さない）**
- Given: SR-02 の状態
- When: `referenceType` を明示（例: `gameObject`）して `setReference` を呼ぶ
- Then: Bridgeは推論で上書きせず、その指定で成功する（またはUnity側が拒否した場合は“指定が原因”だと分かるエラーにする）

**SR-05 エラー整形（不足情報の具体ガイド）**
- Given: `referencePath` が空、または存在しない対象を指定する
- When: `setReference` を呼ぶ
- Then: Bridgeの返却に「不足/不正なキー」「再試行テンプレ（必要なら __confirm 等）」が含まれる

**SR-06 安全性（破壊系ではないことの確認）**
- Given: SR-02 の状態
- When: `setReference` を `__confirm` なしで呼ぶ
- Then: confirmゲートに引っかからず実行できる（参照配線は日常動線のため）  
  - 例外が必要なら、対象範囲と理由を docs に明記する

**SR-07 Asset参照（Material/Texture2D/Sprite）**
- Given: `Assets/...` 配下に Texture（png）/ Material が存在する
- And: `SetReferenceFixture` に `public Material material; public Texture2D texture; public Sprite sprite;` がある
- When: Material/Texture2D は `unity.component.setReference` を `referenceType` 省略のまま `referencePath:"Assets/..."` で呼ぶ
- Then: Bridge が `referenceType=asset` を推論して成功する
- And: Sprite は `unity.assetImport.listSprites` で候補を取得し、`unity.component.setSpriteReference` で `spriteName` を明示して成功する（sprite sheet 等で暗黙に選ばない）
- And: 必要なら `unity.assetImport.setTextureType` で importer を `Sprite` にする

#### 実装タスク（計画）

- [x] `tools/list` の schema patch 追加（`unity.component.setReference`）
- [x] `tools/call` 前の引数正規化（referenceType推論 + `referencePath`→`referenceGameObjectPath` 等の互換吸収）
- [x] read-only 情報（`unity.component.inspect` の fieldType 等）を前提にしないフォールバック（ルールベース）
- [x] E2E: `scripts/e2e-setreference.js` 追加（上記 SR-01〜06 を自動化）
- [x] E2E: `scripts/e2e-asset-import-reference.js` 追加（上記 SR-07 を自動化）
- [x] Bridge: `unity.assetImport.setTextureType`（AssetImport拡張なしでも importer を調整）
- [x] Bridge: `unity.assetImport.listSprites` + `unity.component.setSpriteReference`（Sprite の sub-asset を `spriteName` で明示。暗黙フォールバックなし）
- [x] docs: 最小呼び出し例 / 失敗時の再試行例を wiki に追加

---

### 4.2 (P0) Tilemap作成/TilemapRenderer追加でエージェントがハマる

#### DoD（必須）

- 誤ルート（primitiveに TilemapRenderer 追加）で失敗したとき、Bridgeまたはdocsにより「次の一手」が明示される
- 正ルート（空GO起点 or `executeMenuItem("GameObject/2D Object/Tilemap/Rectangular")`）で Tilemap が作成できる

#### テストケース（TM = Tilemap）

**TM-00 事前条件（共通）**
- Given: SR-00 と同じ

**TM-01 誤ルート失敗の誘導**
- Given: primitive（Quad等）`TM_Primitive` がシーンに存在する
- When: `TM_Primitive` に `TilemapRenderer` を追加しようとする（`unity.component.add` など）
- Then: 失敗する（Unity仕様）
- And: 返却文に「MeshFilter等との競合の可能性」と「回避策（空GO起点/メニュー作成）」が含まれる

**TM-02 正ルート（空GO起点）**
- Given: 空の GameObject `TM_TilemapRoot` が存在する
- When: `TM_TilemapRoot` に `Tilemap` と `TilemapRenderer` を追加する
- Then: 成功する
- And: `unity.scene.list` で `TM_TilemapRoot` が期待するコンポーネントを持つ

**TM-03 正ルート（メニュー作成）**
- Given: `unity.editor.executeMenuItem` が利用可能
- When: `GameObject/2D Object/Tilemap/Rectangular` を実行する
- Then: Tilemap が作成される
- And: 作成物を `unity.scene.list` で検出できる（名前/パスの候補が出る）

#### 実装タスク（計画）

- [x] docs: `test/scenario.md` の注意を wiki（Troubleshooting/Tools）へ昇格し、レシピ化
- [x] Bridge: TilemapRenderer競合っぽいエラー文に対する“回避策追記”整形
- [x] E2E: `scripts/e2e-tilemap.js` 追加（TM-01〜03）

---

### 4.3 (P0) UI Toolkit（UIToolkit Extension）の実運用で詰まりやすい（schema/引数不一致）

`unity.uitoolkit.runtime.*` の一部は Unity 側が `selector` を必須とする一方で、`tools/list` の schema が `query` / `elementName` になっているなど、**クライアント側が schema に従うと詰まる**ことがあります。

#### DoD（必須）

- `tools/list` 上で UI Toolkit runtime ツールが `selector` を露出し、`query` / `elementName` を使った呼び出しも Bridge が吸収できる
  - 例: `unity.uitoolkit.runtime.queryElement` は `query` でも動く（Bridge が `selector` に変換）
  - 例: `unity.uitoolkit.runtime.setElementText` は `elementName:"HPLabel"` でも動く（Bridge が `selector:\"#HPLabel\"` に変換）
- `unity.uitoolkit.scene.configureUIDocument` の schema に `uxmlPath` / `panelSettingsPath` が露出し、クライアントがそれらを指定して UIDocument を構成できる

#### テストケース（UITK = UI Toolkit）

**UITK-01 schema（selector/UIDocument設定が見える）**
- When: `tools/list` を取得する
- Then: `unity.uitoolkit.runtime.queryElement` / `setElementText` に `selector` が含まれる
- And: `unity.uitoolkit.scene.configureUIDocument` に `uxmlPath` / `panelSettingsPath` が含まれる

**UITK-02 UXML/USS/PanelSettings の作成**
- When: `unity.uitoolkit.asset.*` で UXML/USS/PanelSettings を作る
- Then: 失敗しない

**UITK-03 UIDocument の構成**
- When: `unity.uitoolkit.scene.createUIGameObject` → `configureUIDocument`
- Then: `unity.uitoolkit.runtime.getUIDocument` で `uxmlPath` / `panelSettingsPath` が設定済みである

**UITK-04 runtime.queryElement（query互換）**
- Given: PlayMode ON
- When: `unity.uitoolkit.runtime.queryElement` を `query:\"#HPLabel\"` で呼ぶ
- Then: 成功する（Bridge が selector を補完）

**UITK-05 runtime.setElementText（elementName互換）**
- Given: PlayMode ON
- When: `unity.uitoolkit.runtime.setElementText` を `elementName:\"HPLabel\"` で呼ぶ
- Then: 成功する（Bridge が selector を補完）

#### 実装タスク（計画）

- [x] Bridge: `normalizeUnityArguments` に UI Toolkit runtime の `query`/`elementName` → `selector` 変換を追加
- [x] Bridge: `tools/list` の schema patch を追加（UI Toolkit runtime / configureUIDocument）
- [x] E2E: `scripts/e2e-uitoolkit.js` 追加（UITK-01〜05）
- [x] docs: `test/scenario.md` Phase 5 を UI Toolkit 版へ更新

---

### 4.4 (P2) 安全設計（invokeStaticMethod既定OFF）の妥当性と必要機能の確保

#### DoD（必須）

- 既定設定で:
  - `tools/list` に `unity.editor.invokeStaticMethod` が出ない
  - 直接呼ぶとブロックされ、理由と有効化手順（`MCP_ENABLE_UNSAFE_EDITOR_INVOKE=true`）が返る
  - `unity.editor.listMenuItems` は動作し、`MCP/Server/Start` を含む結果を返す（最低ライン）
- unsafe を有効化しても、`unity.editor.invokeStaticMethod` は常に `__confirm: true` が必要（回帰防止）

#### テストケース（INV = Invoke Safety）

**INV-01 tools/list で非表示**
- Given: 環境変数 `MCP_ENABLE_UNSAFE_EDITOR_INVOKE` 未設定（または false）
- When: `tools/list` を取得する
- Then: `unity.editor.invokeStaticMethod` が存在しない

**INV-02 直接呼び出しブロック**
- Given: INV-01
- When: `tools/call` として `unity.editor.invokeStaticMethod` を name 指定で呼ぶ
- Then: `isError=true` でブロックされ、enable手順と `__confirm` 必要が説明される

**INV-03 listMenuItems は動く（専用実装）**
- Given: INV-01
- When: `unity.editor.listMenuItems` を `filter:"MCP"` で呼ぶ
- Then: 成功し、`MCP/Server/Start` を含む

**INV-04 unsafe ON でも confirm 必須**
- Given: 環境変数 `MCP_ENABLE_UNSAFE_EDITOR_INVOKE=true` でBridgeを起動する
- When: `unity.editor.invokeStaticMethod` を `__confirm` なしで呼ぶ
- Then: confirm不足でブロックされる
- When: 同じ呼び出しを `__confirm:true` で実行する
- Then: 実行される（ただし allowlist 化する場合はここを仕様変更し、テストも合わせて更新する）

#### 実装タスク（計画）

- [x] E2E: `scripts/e2e-invoke-safety.js` 追加（INV-01〜04）
- [x] docs: “通常用途では invoke をONにしない”方針と、拡張時は allowlist/専用ツールで対応する指針を明文化

---

### 4.5 (P1) 揺れ（PlayMode/再コンパイル）時の運用・保守性

#### DoD（必須）

- `playmode-ab` を 50 cycles 実行して完走し、ツール呼び出しが恒常的にエラーにならない（3.1 の条件）
- 瞬断時のエラー返却が「Unityが起動しているか」「MCP/Server/Start」「見るログ（bridge.status / unity.log.history / Unity Console）」を含む（次の行動が明確）
- 自動リトライを入れる場合でも、**read-only に限定**し、破壊系は二重実行を避ける（安全設計維持）

#### テストケース（JR = Jitter / Recompile）

**JR-01 playmode-ab 長期完走**
- Given: Unityが起動し、HTTP server が healthy
- When: `node scripts/playmode-ab.js --cycles 50` を実行する
- Then: スクリプトが例外終了しない
- And: 出力JSONを解析すると、主要ツール呼び出しの `isError` が 0（または許容閾値以内）である

**JR-02 再コンパイル瞬断（read-only の耐性）**
- Given: Unityでドメインリロードが起きる条件（C#ファイル書き換え等）
- When: 再コンパイル中に read-only ツール（例: `unity.scene.list`）を一定間隔で呼ぶ
- Then: 一時的な失敗は許容されるが、復帰後に成功し、エージェントが停止しないためのガイドが返る

**JR-03 runtime config 更新（ポート変化）**
- Given: `.unity-mcp-runtime.json` の httpPort が更新されうる状況（Unity再起動等）
- When: Bridgeが一度失敗した後、次の呼び出しで runtime config を再読込する
- Then: 更新後のURLで復帰できる（`bridge.reload_config` 手動でも可）

#### 実装タスク（計画）

- [x] `playmode-ab` の出力から `isError` 集計をし、閾値超えで exit code を非0にする（自動判定）
- [x] E2E: `scripts/e2e-recompile-jitter.js` を追加し、JR-02/JR-03 を自動化
- [x] docs: 瞬断時の“見る順番”を明文化（Troubleshooting）

---

## 5. 実装ステップ（マイルストーン）

### Milestone A（P0: setReference）

1. Unit: 推論/正規化ロジックの純関数化 + テスト追加
2. Bridge: `tools/list` schema patch（setReference）
3. E2E: `e2e-setreference.js` で SR-01〜06 を自動化
4. docs: 最小例と失敗時の再試行例

### Milestone B（P0: Tilemap）

1. docs: レシピ化（誤ルートの注意 + 正ルートの推奨）
2. （任意）エラー整形
3. E2E: `e2e-tilemap.js` で TM-01〜03

### Milestone C（P1: 揺れ）

1. `playmode-ab` の自動判定強化（エラー数集計）
2. E2E: 再コンパイル瞬断の自動化（JR-02/JR-03）
3. docs: 復旧導線（見るログ順・待機・再試行）

### Milestone D（P2: invoke方針）

1. E2E: INV-01〜04 を自動化（安全設計の回帰防止）
2. 要求が出た場合のみ: allowlist/専用ツール設計（別チケット化）

---

## 6. 実行コマンド（例）

```bash
cd Server~/mcp-bridge
npm test
npm run smoke -- --project "/Users/.../GitHub/Test/My project" --verbose
node scripts/playmode-ab.js --project "/Users/.../GitHub/Test/My project" --cycles 50
```

---

## 7. 証跡（最低限残すログ）

- `tools/list`（特に setReference / invoke の有無）
- E2E スクリプトの標準出力（JSON）
- Unity側: `unity.log.history`（必要なら `__maxMessageChars` / `__maxStackTraceChars` で短縮）
- playmode-ab の出力（`/tmp/unimcp_playmode_ab_*.out` 等）

---

## 8. 証跡（実行結果: PASS）

> 注意: ここに記載の検証は **Ash-n-Circuit（ゲーム本体）を一切触らず**、Unityテストプロジェクトのみで実施した。

実使用レポート（実行結果のまとめ）: `test/realworld-report.md`

### 8.1 実行環境

- Repo: `.../GitHub/Unity_MCP/UniMCP4CC`（HEAD: `915959f`）
- Unityテストプロジェクト: `<UNITY_PROJECT_ROOT>`
- Unity: `6000.3.2f1`
- MCP Bridge URL: `http://localhost:5051`
  - `curl http://localhost:5051/health` → `{"status":"ok","projectName":"My project","unityVersion":"6000.3.2f1","timestamp":1767108937}`

### 8.2 実行コマンドとログ

Node（Bridge単体）:

- `cd Server~/mcp-bridge && npm test`
  - PASS: `/tmp/unimcp_npm_test.out`
- `cd Server~/mcp-bridge && npm run test:coverage`
  - PASS: `/tmp/unimcp_npm_test_coverage.out`（`bridgeLogic.js 100%`）

Unity E2E（Node → Bridge → Unity）:

- `cd Server~/mcp-bridge && npm run smoke -- --project "<UNITY_PROJECT_ROOT>" --verbose`
  - PASS: `/tmp/unimcp_smoke.out`
- `cd Server~/mcp-bridge && node scripts/e2e-setreference.js --project "<UNITY_PROJECT_ROOT>" --verbose`
  - PASS: `/tmp/unimcp_e2e_setreference.out`
- `cd Server~/mcp-bridge && node scripts/e2e-tilemap.js --project "<UNITY_PROJECT_ROOT>" --verbose`
  - PASS: `/tmp/unimcp_e2e_tilemap.out`
- `cd Server~/mcp-bridge && node scripts/e2e-invoke-safety.js --project "<UNITY_PROJECT_ROOT>" --verbose`
  - PASS: `/tmp/unimcp_e2e_invoke_safety.out`
- `cd Server~/mcp-bridge && node scripts/e2e-recompile-jitter.js --project "<UNITY_PROJECT_ROOT>" --verbose`
  - PASS: `/tmp/unimcp_e2e_recompile_jitter.out`
- `cd Server~/mcp-bridge && node scripts/e2e-prefab.js --project "<UNITY_PROJECT_ROOT>" --verbose`
  - PASS: `/tmp/unimcp_e2e_prefab.out`
- `cd Server~/mcp-bridge && node scripts/e2e-asset-import-reference.js --project "<UNITY_PROJECT_ROOT>" --verbose`
  - PASS: `/tmp/unimcp_e2e_asset_import_reference.out`
- `cd Server~/mcp-bridge && node scripts/e2e-ambiguous-destroy.js --project "<UNITY_PROJECT_ROOT>" --verbose`
  - PASS: `/tmp/unimcp_e2e_ambiguous_destroy.out`
- `cd Server~/mcp-bridge && node scripts/playmode-ab.js --project "<UNITY_PROJECT_ROOT>" --cycles 50`
  - PASS: `/tmp/unimcp_playmode_ab_50.out`
  - Parsed summary: `/tmp/unimcp_playmode_ab_50_summary.out`（`errors.total=0`）
