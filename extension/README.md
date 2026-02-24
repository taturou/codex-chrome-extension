# Codex Side Panel Chat (Chrome Extension)

`cd extension && npm ci && npm run build` を実行し、`chrome://extensions` で `extension/dist/` を「パッケージ化されていない拡張機能を読み込む」から読み込めば起動できます。

## 概要

- Chrome Manifest V3 の Side Panel 上で動作する Codex 連携チャット拡張です。
- `background service worker` が WebSocket 接続、永続化、選択テキスト添付を担当します。
- `sidepanel` は React UI、`options` は接続先 WebSocket URL の設定を担当します。

## 主要機能

- スレッド作成・切替・削除
- チャット送信とストリーミング表示（token/done/error）
- 閲覧中ページの選択テキスト添付（明示操作のみ）
- 自動再接続（指数バックオフ）
- 履歴の永続化（`chrome.storage.local`）
- Markdown 安全描画（`react-markdown` + `rehype-sanitize`）

## 要件

- Node.js 18+（推奨: 20+）
- Google Chrome（Side Panel API 対応版）
- Codex app-server（WebSocket エンドポイント）

## セットアップ

1. 依存関係をインストールします。

```bash
npm ci
```

2. 拡張をビルドします。

```bash
npm run build
```

3. Chrome に読み込みます。

- `chrome://extensions` を開く
- 「デベロッパーモード」を ON
- 「パッケージ化されていない拡張機能を読み込む」から `extension/dist/` を選択

4. `Options` で WebSocket URL を保存します（未設定時デフォルト: `ws://localhost:3000`）。

5. app-server を起動します（例）。

```bash
codex app-server --listen ws://127.0.0.1:43171
```

6. `Sec-WebSocket-Extensions` の握手相性回避のため、`server/` の WS プロキシを起動します。

```bash
cd ../server
node ws-proxy.mjs
```

7. 起動時に標準出力へ出る URI を確認します（未使用ポートを自動検出）。

```bash
# 出力例
WS_PROXY_URI=ws://127.0.0.1:43172
```

8. 拡張の WebSocket URL を 7 で出た `WS_PROXY_URI=...` の値に設定します。

## 使い方

1. 拡張アイコンをクリックして Side Panel を開きます。
2. `新規スレッド` で会話を開始します。
3. テキストを入力し `Enter` で改行します（`Ctrl+Enter` で送信）。
4. ページ上で文字列を選択し `選択を添付` を押すと添付されます。
5. 接続異常時は `再接続`、明示切断時は `切断` を使用します。

## スクリプト

- `npm run dev`: Vite 開発サーバー起動
- `npm run build`: 拡張ビルド（`dist/` 出力）
- `npm run sync:version`: `package.json` の `version` を `public/manifest.json` に同期
- `npm run sync:manifest-policy`: `manifest` の host policy から検証用 SHA-256 を生成
- `npm test`: Vitest 実行
- `npm run lint`: ESLint 実行

## バージョン運用

- `package.json.version` は `X.Y.Z` 形式のみ許可しています。
- 各要素は整数かつ `0..65535` の範囲です。
- `npm run build` 実行時に `prebuild` で `npm run sync:version` と `npm run sync:manifest-policy` を実行し、条件違反時はビルド失敗します。

## メッセージ契約（内部）

Command:

- `CONNECT_WS`
- `DISCONNECT_WS`
- `SEND_CHAT_MESSAGE`
- `ATTACH_SELECTION`
- `CREATE_THREAD`
- `SWITCH_THREAD`
- `DELETE_THREAD`
- `LIST_THREADS`
- `GET_THREAD_MESSAGES`
- `SAVE_SETTINGS`
- `GET_SETTINGS`

Event:

- `WS_STATUS_CHANGED`
- `CHAT_TOKEN`
- `CHAT_DONE`
- `CHAT_ERROR`
- `SELECTION_ATTACHED`

## 永続化と上限

- 保存先: `chrome.storage.local`
- スレッド上限: `50`
- メッセージ上限: `200 / thread`
- 上限超過時は古いデータを削除

## 技術的トレードオフ

- KISS: UI/通信/永続化を分離し責務を単純化
- DRY: Command/Event の型契約を `src/contracts` に集約
- SOLID（単一責務）: `sidepanel`（表示）/`background`（制御）/`storage`（I/O）を分離
- 既知制約:
  - app-server 側イベント差異が大きい場合、token 反映が崩れる可能性があります。
  - `chrome.storage.local` の容量制限に対し、現状は件数制御のみです。

## 検証状況

- `npm test`: 20 tests passed
- `npm run build`: 成功（`dist/` 生成）

## 参照

- Chrome MV3: https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3
- Chrome Side Panel API: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- Chrome activeTab permission: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
- OpenAI Codex app-server: https://developers.openai.com/codex/app-server/
