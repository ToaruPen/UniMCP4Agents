# UniMCP4CC 実使用レポート（2Dゲーム制作 / UI Toolkit）

## 1. 概要 / 結論

本リポジトリ（UniMCP4CC: Unity MCP Server + Node MCP Bridge）について、**2Dゲーム制作に必要な「制作の往復」**（アセット生成・参照設定・Prefab・Tilemap・UI Toolkit・PlayMode・再コンパイル瞬断・安全ゲート）を、Unity Editor を実際に起動した状態で E2E 実行し確認した。

**結論**: 本レポートで実施した範囲においては、**実使用に耐える見込みが高い**（少なくとも「2D制作の最小ループ」を回せる）と判断する。  
ただし、**未検証領域（後述）**があるため、プロジェクト固有要件（入力/物理/アニメ/ビルド/Addressables 等）まで含めて “完全に問題なし” とは断言しない。

---

## 2. 実行環境

- Repo: `<REPO_ROOT>`（`git rev-parse --short HEAD` → `768e5c8` + 未コミット差分あり）
- Bridge: `Server~/mcp-bridge/index.js`
- Node.js: `v25.2.1`
- Unity テストプロジェクト: `<UNITY_PROJECT_ROOT>`
- Unity: `6000.3.2f1`
- Unity MCP Server: `http://localhost:5051`
  - `curl http://localhost:5051/health` → `{"status":"ok","projectName":"My project","unityVersion":"6000.3.2f1",...}`

---

## 3. 実施したテスト（自動）

### 3.1 Bridge（単体）

- `cd Server~/mcp-bridge && npm test`
  - PASS（22/22）

### 3.2 Unity E2E（Node → Bridge → Unity）

UI Toolkit（UI Toolkit Extension 導入済み）:

- `cd Server~/mcp-bridge && node scripts/e2e-uitoolkit.js --project "/Users/.../GitHub/Test/My project"`
  - PASS

参考（フルスイート）:

- smoke / invoke safety / setReference / tilemap / prefab / asset import+reference / ambiguous destroy / recompile+jitter / playmode-ab（50 cycles）
  - PASS

証跡（標準出力ログ）:

- `/tmp/unimcp_e2e_suite_20260101_011929.out`（フルスイート）
- `/tmp/unimcp_e2e_suite_20260101_012853.out`（`npm test` + `e2e-uitoolkit` 再実行）

---

## 4. UI Toolkit 検証（uGUI ではなく UI Toolkit の制作動線）

### 4.1 依存（重要）

`unity.uitoolkit.*` は `tools/list` に表示されても、**追加の Editor 拡張が未導入だと失敗**する。

- 必要拡張: `LocalMcp.UnityServer.UIToolkit.Editor`
  - 本パッケージの Samples: `UIToolkit Extension` を Import すると利用可能

### 4.2 Bridge 互換（selector / query / elementName）

Unity 側 `unity.uitoolkit.runtime.*` の一部ツールは `selector` を要求する一方、スキーマ上は `query` / `elementName` しか露出していないケースがあったため、Bridge 側で互換吸収を追加した。

- `query` → `selector`
- `elementName` → `selector`（`"HPLabel"` → `"#HPLabel"`）

これにより、**UI Toolkit を前提とするゲーム制作**（UXML/USS の生成、UIDocument 設定、Play 中の UI 更新）を E2E で通せる状態になった。

---

## 5. 既知の注意点（観測した揺れ）

- PlayMode 遷移のタイミング等で、Bridge 側に `Connection lost during API call: fetch failed` が一時的に出る場合がある  
  - 本レポートの実行ログでは **再接続して継続**できている（`e2e-uitoolkit` / `playmode-ab`）
- 破壊的操作（destroy/delete/import 等）は `__confirm: true` が必要（安全ゲート）

---

## 6. シナリオ / E2E の穴（未検証領域）

本レポートは “2D制作の最小ループ” を主眼にしているため、次は **まだ自動検証していない**（＝プロジェクト要件によっては追加テスト推奨）。

- UI Toolkit:
  - クリック/入力/フォーカス等のイベント系（UI Test Framework 連携含む）
  - `ListView` / `ScrollView` / バインディング / 複雑な階層とスタイル
- 2Dゲーム主要領域:
  - Physics2D（衝突/Trigger/FixedUpdate 依存）
  - Animation / AnimatorController / SpriteAtlas
  - Audio（AudioSource/AudioMixer）
  - Input System（ActionAsset / PlayerInput）
- 制作運用:
  - 複数シーン/加算ロード、ビルド設定、Addressables、ビルド（プラットフォーム別）
  - 長時間連続運用（数時間）でのメモリ/リーク/ログ肥大

---

## 7. 次に増やすと効果が高い追加 E2E（提案）

- UI Toolkit: `setElementVisibility` / `setElementEnabled` / `setElementValue` / `addRuntimeClass` / `removeRuntimeClass` を一通り検証（`selector` と互換キーの両方）
- 2D: Physics2D の最小 e2e（Collider2D+Rigidbody2D を生成→接触をログで検証）
- Scenes: `scene.create/open/save` + `BuildSettings` 更新（安全ゲート前提）までの往復

---

## 8. 関連ドキュメント

- 実使用シナリオ: `test/scenario.md`
- 落とし穴/DoD/実装計画: `test/pitfalls-dod-plan.md`
- UI Toolkit: `docs/wiki/UI-Toolkit.md`
