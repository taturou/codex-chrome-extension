# Codex Side Panel Chat (Chrome Extension)

Chrome Manifest V3 の Side Panel 上で動作する Codex 連携チャット拡張です。

## 機能

- スレッド管理: 作成 / 切替 / 検索 / リネーム / 削除
- チャット: ストリーミング表示（`CHAT_TOKEN` / `CHAT_DONE` / `CHAT_ERROR`）
- 添付:
  - ページ選択テキスト添付
  - DOM Selection Mode によるページ文脈添付
- 接続制御: Connect / Disconnect / 自動再接続（指数バックオフ）
- 履歴保存: `chrome.storage.local`
- スレッド保存/復元:
  - Side Panel: 単一スレッドの保存（削除前バックアップ）
  - Options: 複数スレッドのエクスポート/インポート
- Usage Limits 表示（5h/weekly など）
- Markdown 安全描画（`react-markdown` + `rehype-sanitize`）

## 前提

- Node.js 18+（推奨: 20+）
- Chrome（Side Panel API 対応版）
- `codex` CLI が利用可能であること

## セットアップ

1. 依存関係をインストールします。

```bash
npm ci
```

2. ビルドします。

```bash
npm run build
```

3. Chrome に読み込みます。

- `chrome://extensions` を開く
- 「デベロッパーモード」を ON
- 「パッケージ化されていない拡張機能を読み込む」から `extension/dist/` を選択

4. `server/ws-proxy.mjs` を起動し、`listening ws://...` の値を Options の `WebSocket URL` に設定します。

補足:

- 未設定時の既定値は `ws://localhost:3000` です（`src/shared/constants.ts`）。
- プロキシは `codex app-server` を自動起動します。

## 使い方

- Side Panel で `New` を押してスレッド作成
- 入力欄で `Enter` は改行、`Ctrl+Enter` / `Cmd+Enter` で送信
- `Attach current page selection` で現在ページの選択文字列を添付
- `Context` を `DOM selection` に切り替えると DOM Selection Mode を開始
- 必要に応じて `Connect` / `Disconnect` を使用

## 権限とポリシー

- `host_permissions`: localhost / 127.0.0.1 の `ws/wss/http/https`
- `optional_host_permissions`: DOM Selection Mode 対象サイト
  - 現在: `https://pjp.esol.co.jp/epw/*`, `https://teams.cloud.microsoft/*`
- 起動時に permission policy の SHA-256 整合性を検証し、不一致時は拡張をブロックします。

`manifest` の host policy を変更した場合は、次を実行して整合性ハッシュを更新してください。

```bash
npm run sync:manifest-policy
```

## スクリプト

- `npm run dev`: Vite 開発サーバー
- `npm run build`: 本番ビルド（`prebuild` で policy/version 同期）
- `npm test`: Vitest
- `npm run lint`: ESLint
- `npm run sync:version`: `package.json` の version を `public/manifest.json` に同期
- `npm run sync:manifest-policy`: permission policy の検証ハッシュを更新

## 主要ディレクトリ

- `src/sidepanel`: UI（React）
- `src/options`: 設定/エクスポート/インポート UI
- `src/background.ts`: 通信制御、永続化、添付処理
- `src/transport/wsTransport.ts`: WebSocket プロトコル処理
- `src/contracts`: Command/Event 契約
- `src/storage`: `chrome.storage.local` リポジトリ

## 参照

- Chrome MV3: https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3
- Chrome Side Panel API: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- OpenAI Codex app-server: https://developers.openai.com/codex/app-server/
