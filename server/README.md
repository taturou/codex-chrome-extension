# ws-proxy server

## 起動

`ws-proxy` を起動します（内部で `codex app-server` も起動されます）。

```bash
cd server
node ws-proxy.mjs
```

## URI の確認

起動時に標準出力へ以下を出力します。

出力例:

```text
ws-proxy.mjs - Codex app-server WebSocket プロキシ
codex: 起動成功 (home: ~/.codex/)
listening ws://127.0.0.1:43172
```

- Chrome 拡張に設定する値は `listening ...` に表示された URL です。

## ポート自動検出

- `WS_PROXY_LISTEN_PORT` を開始点として未使用ポートを探索します。
- 探索回数は `WS_PROXY_PORT_SEARCH_LIMIT`（デフォルト 200）です。

## 環境変数

- `WS_PROXY_LISTEN_HOST`（デフォルト: `127.0.0.1`）
  - `ws-proxy` が待ち受けるホストです。
  - 例: `127.0.0.1`（ローカルのみ公開）
- `WS_PROXY_LISTEN_PORT`（デフォルト: `43172`）
  - `ws-proxy` 側ポート探索の開始番号です。
  - この番号が使用中なら、次の番号を順に探索します。
- `WS_PROXY_PORT_SEARCH_LIMIT`（デフォルト: `200`）
  - ポート探索の最大試行回数です。
  - `WS_PROXY_LISTEN_PORT` と `WS_PROXY_UPSTREAM_PORT` の両方に適用されます。
- `WS_PROXY_UPSTREAM_HOST`（デフォルト: `127.0.0.1`）
  - `ws-proxy` が接続する `codex app-server` のホストです。
- `WS_PROXY_UPSTREAM_PORT`（デフォルト: `43171`）
  - `codex app-server` 側ポート探索の開始番号です。
  - この番号が使用中なら、次の番号を順に探索します。
- `WS_PROXY_CODEX_COMMAND`（デフォルト: `codex`）
  - 起動する Codex CLI コマンド名またはパスです。
  - 例: `codex` / `/usr/local/bin/codex`
- `WS_PROXY_CODEX_ARGS`（デフォルト: 空文字）
  - `codex app-server` 実行時に追加する引数です（空白区切り）。
  - 例: `--log-level debug`
- `WS_PROXY_FORWARD_CODEX_LOGS`（デフォルト: `0`）
  - `1` を設定すると `codex app-server` の標準出力/標準エラーを中継表示します。
  - 既定では中継表示しません（接続先の誤認防止のため）。
