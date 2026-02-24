# ws-proxy server

## 起動

`codex app-server` はホストで先に起動してください。

```bash
codex app-server --listen ws://127.0.0.1:43171
```

`ws-proxy` を起動します。

```bash
cd server
node ws-proxy.mjs
```

## URI の確認

起動時に標準出力へ `WS_PROXY_URI=...` を出力します。

出力例:

```text
WS_PROXY_URI=ws://127.0.0.1:43172
```

この値を Chrome 拡張の WebSocket URL に設定してください。

## ポート自動検出

- `WS_PROXY_LISTEN_PORT` を開始点として未使用ポートを探索します。
- 探索回数は `WS_PROXY_PORT_SEARCH_LIMIT`（デフォルト 200）です。

## 環境変数

- `WS_PROXY_LISTEN_HOST`（デフォルト: `127.0.0.1`）
- `WS_PROXY_LISTEN_PORT`（デフォルト: `43172`）
- `WS_PROXY_PORT_SEARCH_LIMIT`（デフォルト: `200`）
- `WS_PROXY_UPSTREAM_HOST`（デフォルト: `127.0.0.1`）
- `WS_PROXY_UPSTREAM_PORT`（デフォルト: `43171`）
