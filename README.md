# codex-chrome-extension

## リリース対象

- `./extension/dist`: Chrome 拡張成果物
- `./server`: WS プロキシ配布物

## WS プロキシ起動

```bash
codex app-server --listen ws://127.0.0.1:43171
cd server
node ws-proxy.mjs
```

- URI は標準出力に `WS_PROXY_URI=...` で出力されます。
- その URI を拡張の WebSocket URL に設定してください。
