# ws-proxy server

`ws-proxy.mjs` は Chrome 拡張と `codex app-server` の間に入る WebSocket プロキシです。
`Sec-WebSocket-Extensions` を除去して接続互換性問題を回避します。

## 起動

```bash
cd server
node ws-proxy.mjs
```

- `codex app-server` は `ws-proxy.mjs` が自動起動します。
- `codex` コマンドが PATH 上に存在し、利用可能である必要があります。

## 起動ログ

起動成功時の出力例:

```text
ws-proxy.mjs - WebSocket proxy for Codex app-server
codex: started (home: ~/.codex/)
listening ws://127.0.0.1:43172
```

- 拡張に設定する URL は `listening ...` の値です。

## ポート自動検出

- `WS_PROXY_LISTEN_PORT` を開始点として待受ポートを探索します。
- `WS_PROXY_UPSTREAM_PORT` を開始点として app-server 側ポートを探索します。
- 探索回数は `WS_PROXY_PORT_SEARCH_LIMIT`（既定: `200`）です。

## 環境変数

- `WS_PROXY_LISTEN_HOST`（既定: `127.0.0.1`）
  - プロキシの待受ホスト
- `WS_PROXY_LISTEN_PORT`（既定: `43172`）
  - 待受ポート探索の開始番号
- `WS_PROXY_PORT_SEARCH_LIMIT`（既定: `200`）
  - ポート探索の最大試行回数
- `WS_PROXY_UPSTREAM_HOST`（既定: `127.0.0.1`）
  - 接続先 `codex app-server` のホスト
- `WS_PROXY_UPSTREAM_PORT`（既定: `43171`）
  - 接続先ポート探索の開始番号
- `WS_PROXY_CODEX_COMMAND`（既定: `codex`）
  - 起動する Codex CLI コマンド名またはフルパス
- `WS_PROXY_CODEX_ARGS`（既定: 空）
  - `codex app-server` に追加する引数（空白区切り）
- `WS_PROXY_FORWARD_CODEX_LOGS`（既定: `0`）
  - `1` で `codex` の stdout/stderr を中継表示

## 終了

- `Ctrl+C`（SIGINT）または SIGTERM で、プロキシと `codex app-server` を順次停止します。
