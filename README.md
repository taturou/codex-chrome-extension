# codex-chrome-extension

このリポジトリは、Codex app-server を利用する Chrome 拡張（Side Panel UI）と、接続互換性のための WebSocket プロキシを提供します。

## 構成

- `extension/`: Chrome 拡張本体（Manifest V3, React, TypeScript）
- `server/`: `codex app-server` を自動起動する WebSocket プロキシ

## クイックスタート

1. 拡張をビルドします。

```bash
cd extension
npm ci
npm run build
```

2. Chrome に読み込みます。

- `chrome://extensions` を開く
- 「デベロッパーモード」を ON
- 「パッケージ化されていない拡張機能を読み込む」から `extension/dist/` を選択

3. 別ターミナルでプロキシを起動します（`codex app-server` も自動起動）。

```bash
cd server
node ws-proxy.mjs
```

4. 出力された `listening ws://...` を拡張の Options で `WebSocket URL` に設定します。

出力例:

```text
ws-proxy.mjs - WebSocket proxy for Codex app-server
codex: started (home: ~/.codex/)
listening ws://127.0.0.1:43172
```

## リリース対象

- `extension/dist/`: Chrome 拡張の配布用成果物
- `server/ws-proxy.mjs`: プロキシ実行スクリプト
