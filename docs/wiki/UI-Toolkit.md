# UI Toolkit Extension

`unity.uitoolkit.*` ツール群は一覧に表示されますが、利用には追加の拡張が必要です（`tools/list` の description に `[Optional] ...` の注記が付きます）。

## 必要な拡張

- `LocalMcp.UnityServer.UIToolkit.Editor`

未導入だと `unity.uitoolkit.*` の呼び出しが「必要なパッケージが未インストール」というエラーで失敗します。

## 導入（任意）

このパッケージには、UI Toolkit 拡張 DLL を **Samples** として同梱しています（既定では読み込まれません）。

1. Unity Editor で `Window > Package Manager` を開く
2. `UniMCP4CC`（`com.dsgarage.unimcp4cc`）を選択
3. **Samples** の `UIToolkit Extension` を **Import** する

## Bridge 側の引数補正

UI Toolkit 系ツールで `gameObjectPath` / `gameObjectName` を渡しても動くよう、Bridge が `gameObject` へ補正します。

> `com.unity.ui.test-framework`（UI Test Framework）は上記拡張の代替ではありません。
