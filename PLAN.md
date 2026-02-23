# Chrome拡張: Codex連携サイドパネルチャット（MVP）実装計画

## Summary
- 目的: 閲覧ページの選択テキストを明示添付し、`ws://localhost:{port}` の Codex app-server と対話する Chrome MV3 拡張を実装します。
- UI: `Chrome sidePanel API` 上に React 製チャットUIを提供します。
- 通信: Codex app-server 公式WSプロトコル準拠、応答は逐次ストリーミング表示します。
- 永続化: スレッド作成・切替対応、`chrome.storage.local` に永続保存、件数上限で古い順削除します。

## Premise Debug（先に潰す設計リスク）
- `activeTab`中心の権限方針だと、タブ切替・再読込・別オリジン遷移で選択取得権限が不安定になります。
- 対策: 選択添付時に `chrome.scripting.executeScript` 実行失敗を検知し、再許可導線（拡張アイコンクリック案内）をUIで明示します。
- Side Panelは拡張ページ文脈、選択テキストはページ文脈です。直接DOM参照できないため、`background(service worker)` を中継点に統一します。
- app-serverプロトコル差異が出る可能性があります。対策として送受信を `transport adapter` で抽象化し、UIと分離します。

## Scope
- In:
1. Side PanelチャットUI（スレッド一覧、メッセージ一覧、入力欄、添付ボタン）
2. WS接続管理（接続/切断/再接続/手動再試行）
3. 選択テキスト取得（明示添付のみ）
4. 永続履歴（スレッドCRUD、メッセージ保存、上限管理）
5. Options画面でWS URL設定
- Out:
1. ページ全文要約
2. 自動添付
3. 認証連携（ローカルWS前提）
4. 高度検索（履歴全文検索、タグ分類）

## アーキテクチャ
- `sidepanel`:
1. React UI
2. ユーザー操作受付
3. `chrome.runtime.sendMessage` で background にコマンド送信
- `background (service worker)`:
1. 単一責務でアプリ状態管理（接続状態、現在スレッド、保存I/O）
2. WSクライアント保持、ストリーミングイベントをsidepanelへ中継
3. 選択取得要求時に `chrome.scripting.executeScript` を実行
- `options`:
1. `ws_url` 設定/検証
2. 接続テストボタン（非必須だが推奨）
- `storage`:
1. `threads`, `messages`, `settings`, `meta` を `chrome.storage.local` に保存
2. LRU風に古いスレッドから削除

## 追加・変更する公開インターフェース
- `chrome.runtime` message contract（内部公開API）
1. `CONNECT_WS { url?: string }`
2. `DISCONNECT_WS`
3. `SEND_CHAT_MESSAGE { threadId, text, attachments[] }`
4. `ATTACH_SELECTION { tabId }`
5. `CREATE_THREAD { title? }`
6. `SWITCH_THREAD { threadId }`
7. `LIST_THREADS`
8. `GET_THREAD_MESSAGES { threadId, cursor? }`
9. `SAVE_SETTINGS { wsUrl }`
10. `GET_SETTINGS`
- Side Panel受信イベント
1. `WS_STATUS_CHANGED { status, reason? }`
2. `CHAT_TOKEN { threadId, messageId, token }`
3. `CHAT_DONE { threadId, messageId }`
4. `CHAT_ERROR { threadId, error }`
5. `SELECTION_ATTACHED { text, sourceTabId }`
- 永続化スキーマ（TypeScript型）
1. `Setting { wsUrl: string }`
2. `Thread { id, title, createdAt, updatedAt, lastMessageAt }`
3. `Message { id, threadId, role: "user"|"assistant"|"system", contentMd, attachments?, createdAt, status }`
4. `Attachment { type: "selected_text", text, tabId, url, capturedAt }`

## 実装詳細（決定済み）
- Manifest:
1. `manifest_version: 3`
2. permissions: `sidePanel`, `storage`, `activeTab`, `scripting`
3. host_permissions は初期最小化（恒久 `<all_urls>` は付与しない）
4. `action` から side panel を開く動線を提供
- UI仕様:
1. Enter改行、Ctrl+Enter送信
2. 「選択を添付」ボタンでのみページ選択を取り込む
3. Markdown + コードハイライト表示
4. 接続状態バッジ（connected/connecting/disconnected/error）
- 接続仕様:
1. Options保存値を優先、未設定時は `ws://localhost:3000` を暫定デフォルト
2. 再接続は指数バックオフ（例: 1s, 2s, 4s, 8s, 最大30s）
3. 手動「再接続」ボタンを常設
- 保存上限:
1. スレッド最大50件
2. 各スレッド最大200メッセージ
3. 超過時は最終更新が古い順に削除

## Trade-off Analysis（採用理由）
- Side Panel採用:
1. 利点: サイトDOM汚染なし、Chrome標準UX、権限境界が明確
2. 欠点: ページ内固定UIより一体感が下がる
- app-server準拠:
1. 利点: 将来互換性、変換レイヤ最小（KISS）
2. 欠点: 初期にプロトコル理解コストが必要
- React採用:
1. 利点: ストリーミング更新とスレッド切替の状態管理を単純化（DRY）
2. 欠点: 依存増加、バンドルサイズ増

## テスト計画
- Unit:
1. メッセージ正規化（stream token結合）
2. 保存上限ロジック（50/200超過時の削除順）
3. reconnectバックオフ計算
- Integration（拡張内）:
1. Side Panel送信 -> background中継 -> WS送信
2. WS token受信 -> UI逐次反映 -> DONE確定
3. 添付ボタン -> 選択取得成功/失敗分岐
4. スレッド作成/切替/再読み込み後復元
- E2E（手動受け入れ）:
1. OptionsでURL変更し再接続
2. タブ切替後の添付操作
3. app-server停止時のエラー表示と再接続
4. 再起動後に履歴が維持されること

## 受け入れ基準
1. Side Panelで新規スレッド作成・切替・削除ができる
2. 送信したユーザーメッセージに対し、assistant応答がストリーミング表示される
3. 「選択を添付」で現在タブの選択テキストをメッセージに追加できる
4. WS切断時に自動再接続し、失敗時は手動再試行できる
5. 履歴が永続化され、上限超過時に古いデータが削除される

## 実装ステップ
1. Vite + React + TypeScript + MV3ビルド土台作成
2. Manifest/sidePanel/options/backgroundの配線
3. runtime message contract と型定義実装
4. WS transport adapter 実装（接続・送信・受信・再接続）
5. チャットUI実装（スレッド、入力、表示、状態バッジ）
6. 選択添付フロー実装（scripting経由）
7. 永続化実装（storage repository + 上限管理）
8. テスト実装（unit/integration）と手動受け入れ

## Assumptions / Defaults
1. Codex app-serverは `ws://localhost` で到達可能です。
2. app-serverのイベントは公式仕様準拠で、拡張側は追加認証不要です。
3. ローカル利用が前提で、初期MVPでは暗号化保存は行いません。
4. Markdown描画は安全化（HTMLサニタイズ）を前提に実装します。

## 根拠ソース
1. Chrome Extensions Manifest V3: https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3
2. Chrome Side Panel API: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
3. Chrome activeTab permission: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
4. OpenAI Codex app-server: https://developers.openai.com/codex/app-server/
