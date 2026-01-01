# UniMCP4CC 実使用シナリオテスト（2Dローグライク制作）

このドキュメントは、**UniMCP4CC（Unity MCP Server + Node MCP Bridge）を使って「2Dローグライクを作る」**という実使用に近い往復（コード編集 ↔ Unity Editor操作 ↔ 検証）を通し、**安全性・安定性・実用性**を検証するためのシナリオです。

実行結果のまとめ（実使用レポート）: `test/realworld-report.md`

> 重要: `unity.editor.invokeStaticMethod` は **既定で無効**のまま実行します（本シナリオでは使用しない）。

---

## 0. 想定 / 前提

### 対象

- UniMCP4CC リポジトリ: `.../GitHub/Unity_MCP/UniMCP4CC`
- テスト用 Unity プロジェクト: `.../GitHub/Test/My project`
- Unity: `6000.3.2f1`
- Bridge: `.../UniMCP4CC/Server~/mcp-bridge/index.js`
- DB: なし

### 実行者/運用（重要）

- このシナリオは **コーディングエージェント（本ツール実行者）単独**で実行する想定。
- 生成物は `Assets/Roguelike/**` 配下に作成し、**テスト後も残してOK**（クリーンアップしない）。
- 原則として人手介入なしで進めるが、Unity 側で **モーダル/許諾/UI操作が必要な状態**になった場合は人間が介入する（介入が入ってもテスト継続する）。
- 介入が必要/復旧が難しい場合、**Unity を再起動して復旧**してよい（MCP サーバー自動起動/再接続の挙動も検証対象）。
- エラーログ等の収集は **エージェント側で行う**（主に `unity.log.history`。必要なら Unity のログファイルも読む）。

### 目的（このシナリオで確かめたいこと）

1. **制作に必要な往復が成立すること**
   - ファイル作成/編集（C#）→ Unity再コンパイル/ドメインリロード → ツール操作/Play → 失敗時の復旧 → 継続
2. **安全性が実運用で機能すること**
   - 破壊的操作の `__confirm: true`
   - 曖昧ターゲットのブロックと候補提示（path指定で再試行できる）
   - 危険ツール `unity.editor.invokeStaticMethod` が既定で露出しない
3. **揺れ（PlayMode/再コンパイル/一時的な切断）に耐えること**
   - Bridge の再接続・タイムアウト設計が破綻しない
4. **ログ運用が成立すること**
   - `unity.log.history` の切り詰めが Opt-in である（指定時のみ短縮）
5. **保守点検が成立すること**
   - 失敗時に「どこを見るべきか」が明確（Unity Console / `unity.log.history` / MCP APIログ / Editor.log）
   - 再起動・再接続で復旧でき、復旧手順がドキュメント化されている

### 非目的（このテストではやらない）

- 高品質なアート制作/アニメ/演出
- プラットフォーム別ビルド
- 最適化（FPS/GC/ロード時間）

---

## 1. 役割分担（推奨）

- **人間（オペレーター）**: Unity を起動してプロジェクトを開き、必要に応じて UI 上の確認（シーン見た目/Play確認）を行う
- **コーディングエージェント**: MCP ツール呼び出しとファイル編集で制作タスクを進める（破壊操作は必ず `__confirm` を付ける）

---

## 2. 共通ルール（事故を減らす）

### 命名規約（推奨）

同名衝突を避けるため、作成物はプレフィックス付きで作る:

- 例: `RL_`（RogueLike）
- 例: GameObject: `RL_GameManager`, `RL_Player`, `RL_Enemy_001`
- 例: フォルダ: `Assets/Roguelike/*`

### 安全ゲート

- 破壊的操作（destroy/delete/remove/import/build など）は **必ず** `__confirm: true`（必要なら `__confirmNote`）を付ける
- ターゲットが曖昧になりうる操作では **name 指定ではなく path 指定**を優先する
- 不明なときは `unity.scene.list` で候補の `path` を取得してから実行する

### タイムアウト

- 重いツール呼び出しは `__timeoutMs` を付けて 1 回だけ延長する（常用しない）

### ログ

- 原則: 各 `unity.*` ツール呼び出しの直後に `unity.log.history` を実行して Error/Warning を確認する（見落とし防止）
  - 推奨: `unity.log.history({ limit: 200, level: "Error,Warning" })`
  - Bridge 経由で長いログが必要な場合は `__maxMessageChars` / `__maxStackTraceChars` を追加（Opt-in）
- `unity.log.history` は既定で無加工。長いログを扱う必要がある時だけ:
  - `__maxMessageChars` / `__maxStackTraceChars` を指定して短縮する
- 追加でログファイルの場所が必要な場合:
  - `unity.apilog.getFilePath`（MCP APIログ: `Logs/MCP/mcp_api_*.log`, `Logs/MCP/mcp_api_errors_*.log`）
  - Unity Editorログ: `~/Library/Logs/Unity/Editor.log`

---

## 3. 事前準備（必須）

### 3.1 Unity 側の起動

1. Unity Hub から `.../GitHub/Test/My project` を開く
2. Console に MCP サーバー起動ログが出ることを確認
3. 必要なら Unity メニュー `MCP/Server/Start` を実行

### 3.2 Bridge の準備（推奨）

```bash
cd ".../GitHub/Unity_MCP/UniMCP4CC/Server~/mcp-bridge"
npm install
```

---

## 4. シナリオ本体（制作しながら検証）

各ステップで **「使う機能（ツール/挙動）」「期待結果」「証跡」**を記録します。

### Phase 0: 接続・安全確認（5分）

**想定**: Unity/Bridge の接続、tools/list の内容、安全ゲートが正しく効くこと。

**実施**

1. MCP クライアントから `bridge.status`, `bridge.ping`
2. `tools/list` を確認し、次をチェック:
   - `unity.editor.invokeStaticMethod` が **見えない**
   - `unity.editor.listMenuItems` が **見える**
3. `unity.editor.listMenuItems` を `filter: "MCP"` で呼び、メニュー項目が返ること

**期待結果**

- 接続OK
- invokeStaticMethod は既定で露出しない
- listMenuItems は override 実装で動く

**証跡**

- `bridge.status` / `bridge.ping` の出力
- `tools/list` のスクリーンショット or ログ（invoke が無いこと）
- `unity.editor.listMenuItems` の結果（`MCP/Server/Start` が含まれること）

---

### Phase 1: プロジェクト土台作成（10分）

**想定**: 基本的な Asset/Scene/Hierarchy 操作が成立し、保存できること。

**実施**

1. `Assets/Roguelike/{Scenes,Scripts,Prefabs}` フォルダ作成
2. シーン作成: `Assets/Roguelike/Scenes/RoguelikeMain.unity`
3. Hierarchy 構成を作る:
   - `RL_Systems`（空）
   - `RL_Grid`（Grid + Tilemap: `RL_Floor`, `RL_Walls`）
   - `RL_Runtime`（空。実行時生成を配置する親）
4. シーン保存

> 注意（Tilemapの落とし穴）: `TilemapRenderer` は `MeshFilter` などと競合します。`unity.create` で Quad 等の primitive を作ってしまうと TilemapRenderer を追加できず詰まりやすいので、Tilemap 用 GameObject は「空の GameObject」から作る（または `unity.editor.executeMenuItem("GameObject/2D Object/Tilemap/Rectangular")` を使う）こと。  
> ※ `executeMenuItem` は Bridge の安全ゲートにより `__confirm: true` が必要です。

**使用したいツール（例）**

- `unity.asset.createFolder` / `unity.asset.list`
- `unity.scene.create` / `unity.scene.save` / `unity.scene.open`
- `unity.create`（primitive/empty 作成）
- `unity.gameObject.setParent`（親子付け）
- `unity.component.add`（Grid/Tilemap 等の追加。ツール名が違う場合は tools/list から選ぶ）

**期待結果**

- シーンが保存され、再オープンしても Hierarchy が保持される

**証跡**

- `unity.scene.list` の結果（path が意図通り）
- `unity.asset.list` で `RoguelikeMain.unity` が存在すること

---

### Phase 2: ダンジョン生成（アセット依存ゼロ）（20分）

**想定**: 画像/タイルの Import に依存せず、C# のみで Tilemap 表示まで持っていけること。

**方針（テスト都合）**

- 外部素材なしで完結させるため、実行時に `Texture2D` → `Sprite` → `Tile` を生成して Tilemap に敷く

**実施（コード編集 ↔ Unity揺れの往復を含む）**

1. `Assets/Roguelike/Scripts/Dungeon/DungeonGenerator.cs` を追加
   - 幅/高さ/seed
   - マップ生成（例: ランダムウォーク or 部屋+通路）
   - Floor/Walls タイル生成と Tilemap 反映
2. `RL_Systems` に `DungeonGenerator` を付与（Inspector相当のプロパティ設定も含む）
3. Play して生成を確認
4. 失敗したら:
   - `unity.log.history` でエラーを見る（必要なら `__maxMessageChars` 指定）
   - 修正して再Play

**使用したいツール（例）**

- `unity.component.add` / `unity.component.setProperty`
- `unity.editor.play` / `unity.editor.stop`
- `unity.log.history`（opt-in で切り詰め）

**期待結果**

- Play で床/壁が見える（最小でOK）
- 途中で Unity が再コンパイルしても Bridge が復帰し、作業を続けられる

**証跡**

- `unity.log.history`（エラー0が理想。エラーが出た場合は修正後の「解消」ログ）
- `unity.editor.playModeStatus` の結果（可能なら）

---

### Phase 3: プレイヤー（移動・衝突）＋カメラ追従（20分）

**想定**: Prefab/Component/Script の実制作パス（作る→つなぐ→動かす）が成立すること。

**実施**

1. `RL_Player` を作成し、`Assets/Roguelike/Prefabs/RL_Player.prefab` に保存
2. 必要コンポーネント:
   - `Rigidbody2D`（Kinematic 推奨）
   - `Collider2D`
   - `SpriteRenderer`
3. `PlayerController.cs` を追加
   - 4方向移動（壁なら移動しない）
   - 可能なら「グリッド単位」の移動にする（ローグライクらしさ）
4. MainCamera を Orthographic にし、追従スクリプトを追加

**期待結果**

- Play でプレイヤーが動く
- 壁で止まる
- カメラが追従する

**失敗注入（ここで必ず1回）**

- 同名オブジェクトを 2 つ作る（例: `RL_TestAmbiguous` を複製）
- name 指定で破壊（destroy）を試みる（`__confirm` なし → confirm で止まる / `__confirm` あり → 曖昧ターゲットで止まることを期待）
- 返ってきた候補の `path` を指定して destroy を再実行し、成功させる

**証跡**

- 曖昧ターゲットブロックの応答（候補が返ること）
- `path` 指定で成功すること

---

### Phase 4: 敵・ターン制・戦闘（30分）

**想定**: “手順が長い制作”を通じて、エージェント運用で問題になりやすい箇所（修正→再試行→検証）を踏む。

**実施**

1. `TurnManager.cs` を追加（最低限でOK）
   - プレイヤーが1手動いたら敵が1手動く
2. `RL_Enemy` prefab を作成（複数スポーン）
3. `EnemyAI.cs`（例: プレイヤーに近づく / 近接したらダメージ）
4. `Health.cs`（プレイヤー/敵共通で最小）
5. GameOver → Restart（シーン再ロード or 初期化）

**期待結果**

- 1手ずつ進行する感触が出る
- エラーが出た場合にログ→修正→復帰がスムーズ

**証跡**

- `unity.log.history` で例外が出ていないこと（出た場合は修正後に消えること）

---

### Phase 5: UI Toolkit（HP/フロア表示）＋ログ運用（10分）

**想定**: UI Toolkit ベースの UI 生成・参照・更新（制作の頻出動線）が成立すること。

**実施**

1. `unity.uitoolkit.*` が利用できることを確認
   - 失敗する場合は Samples の `UIToolkit Extension` を Import する（`LocalMcp.UnityServer.UIToolkit.Editor`）
2. HUD 用の `UXML` / `USS` / `PanelSettings` を作成し、`UIDocument` に割り当てる
   - 例: `Assets/Roguelike/UI/HUD.uxml`, `Assets/Roguelike/UI/HUD.uss`, `Assets/Roguelike/UI/HUD_PanelSettings.asset`
   - `unity.uitoolkit.scene.createUIGameObject` → `unity.uitoolkit.scene.configureUIDocument`
3. Play 中に HP/Seed/Floor の表示が更新されることを確認
   - まずは `unity.uitoolkit.runtime.setElementText` で動作確認し、次に `GameManager` から UI を更新する経路を作る
   - `selector`（例: `#HPLabel`）を使う（Bridge は `query` / `elementName` も吸収します）
4. `unity.log.history` の切り詰め（`__maxMessageChars` / `__maxStackTraceChars`）を意図的に使い、運用できることを確認

**期待結果**

- UI が更新される
- ログ取得が「必要時のみ短縮」で運用できる

---

## 5. 追加ストレス（任意だが推奨）

### 5.1 E2E Smoke（Bridge）

```bash
cd ".../GitHub/Unity_MCP/UniMCP4CC/Server~/mcp-bridge"
npm run smoke -- --project ".../GitHub/Test/My project" --verbose
```

### 5.2 PlayMode ON/OFF ストレス

```bash
cd ".../GitHub/Unity_MCP/UniMCP4CC/Server~/mcp-bridge"
node scripts/playmode-ab.js --project ".../GitHub/Test/My project" --cycles 30 --verbose
```

**期待結果**

- 途中で一時的な切断が発生しても、再接続して最後まで完走する

---

## 6. 合否判定（DoD）

次を満たせば「実使用に耐える見込みが高い」と判定する。

1. Phase 0〜5 が完走できる（途中で詰まっても、ログ/候補提示/再接続で復帰できる）
2. 破壊操作が `__confirm` で確実に止まり、曖昧ターゲットがブロックされる
3. `unity.editor.invokeStaticMethod` を使わずに、上記の制作タスクが進められる
4. `unity.log.history` の切り詰めが opt-in で、既定挙動を壊していない
5. PlayMode/再コンパイルを跨いでも Bridge が致命的に壊れない（少なくとも `bridge.ping` に復帰する）
6. 失敗時にログ（MCP/Unity）の採取・切り分けができ、再現手順を残せる（保守点検の最低ライン）

---

## 7. 実行ログのテンプレ（貼り付け用）

実行後、以下を埋めて貼る:

- 実行日時:
- Unity Version:
- Project:
- MCP Client:
- Phase 0: OK/NG（ログリンク/貼付）
- Phase 1: OK/NG
- Phase 2: OK/NG
- Phase 3: OK/NG（曖昧ターゲットの証跡も）
- Phase 4: OK/NG
- Phase 5: OK/NG（log.history opt-in 証跡も）
- Smoke: OK/NG（`npm run smoke` 出力）
- PlayMode AB: OK/NG（完走/失敗箇所）
