# DESIGN

## 結論
- MV3の責務分離を優先し、`sidepanel(React)` は表示と入力、`background(service worker)` は状態・永続化・WS中継、`storage repository` は上限管理付きI/Oに限定しました。

## 構成
- `public/manifest.json`
  - `sidePanel`/`storage`/`activeTab`/`scripting`/`tabs` を付与
  - `background.js` を service worker として登録
  - `options.html` と `sidepanel.html` を公開
- `src/background.ts`
  - runtime command受信
  - thread/message永続化
  - `chrome.scripting.executeScript` による選択取得
  - WS状態・token/done/error イベント中継
  - 同一 `threadId:messageId` 更新をキュー直列化し、token/done/error 競合を回避
- `src/transport/wsTransport.ts`
  - 接続/切断/送信
  - 自動再接続（指数バックオフ 1s,2s,4s...最大30s）
  - 手動再接続
  - `CONNECTING` 中の重複 `connect()` を抑止
  - `reconnectNow()` 直後の不要な再接続スケジュールを抑止
- `src/storage/repository.ts`
  - `chrome.storage.local` の単一キー永続化
  - threads上限50、messages/thread上限200
  - `appendToken` は `done/error` 後の遅延token上書きを拒否
- `src/sidepanel/*`
  - スレッド一覧、メッセージ表示、入力、添付、再接続UI
  - Enter送信/Shift+Enter改行
  - Markdown表示は `SafeMarkdown`（`react-markdown` + `remark-gfm` + `rehype-sanitize`）で描画
- `src/options/*`
  - wsUrl保存と接続・切断要求

## メッセージ契約
- Command:
  - `CONNECT_WS`, `DISCONNECT_WS`, `SEND_CHAT_MESSAGE`, `ATTACH_SELECTION`, `CREATE_THREAD`, `SWITCH_THREAD`, `DELETE_THREAD`, `LIST_THREADS`, `GET_THREAD_MESSAGES`, `SAVE_SETTINGS`, `GET_SETTINGS`
- Event:
  - `WS_STATUS_CHANGED`, `CHAT_TOKEN`, `CHAT_DONE`, `CHAT_ERROR`, `SELECTION_ATTACHED`

## データモデル
- `Setting { wsUrl }`
- `Thread { id,title,createdAt,updatedAt,lastMessageAt }`
- `Message { id,threadId,role,contentMd,attachments?,createdAt,status }`
- `Attachment { type:'selected_text',text,tabId,url,capturedAt }`

## 安全性
- Markdownは `react-markdown` で構文解析し、GFM（表・タスクリスト・打消し線等）は `remark-gfm` で対応
- 出力HTMLは `rehype-sanitize` を適用し、危険なタグ・属性（`script`、`javascript:` URL など）を抑止
- `dangerouslySetInnerHTML` を使わず、Reactコンポーネント描画でXSSリスクを低減

## 設計根拠
- KISS: protocol差異吸収を transport adapter に局所化
- DRY: command/event型を `contracts` に集約し、Markdown仕様追従は実績あるライブラリへ委譲
- SOLID(単一責務): UI/通信/永続化を別モジュールに分離

## 参照
- Chrome MV3: https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3
- Chrome Side Panel API: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- Chrome activeTab: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
- Codex app-server: https://developers.openai.com/codex/app-server/
