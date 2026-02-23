# CONCERN

## 結論
- MVPとして要件は満たすが、運用前に以下のリスク対策が必要です。

## 懸念点
1. WSプロトコル差異
- 現状: `type/event` と `threadId/messageId` の揺れを吸収する実装
- リスク: app-serverイベント名がさらに異なるとトークン反映不能
- 対策: 実サーバーログを固定し、厳密スキーマ(バージョン付き)へ移行
- 実測結果(2026-02-22):
  - app-serverを `codex app-server --listen ws://127.0.0.1:4317` で起動し、WSで `initialize -> thread/start -> turn/start` を実行
  - token相当は `item/agentMessage/delta` (`params.delta`) で到達
  - done相当は `turn/completed` (`params.turn.status=completed`) で到達
  - error相当は通知イベントだけでなく、JSON-RPC error response (`{error:{code,message}, id}`) でも到達
  - 識別子は `turnId` と `itemId` が主であり、`messageId` 固定前提は不整合
  - 検証ログ: `/tmp/codex-ws-log.json`, `/tmp/codex-ws-error-log.json`, `/tmp/codex-app-server-debug.out`
  - 備考: 接続クライアント差異により handshake 失敗あり（`sec-websocket-extensions`）。検証時は `perMessageDeflate: false` で接続

2. runtimeメッセージブロードキャスト範囲
- 現状: `chrome.runtime.sendMessage` で全拡張ページへ配信
- リスク: options画面など不要購読先も受信
- 対策: `chrome.runtime.connect` + port識別で sidepanel限定配信

3. Markdownレンダラの機能制限
- 現状: HTMLエスケープ優先の簡易変換
- リスク: 複雑Markdown（ネスト、表、リスト）非対応
- 対策: 将来は安全設定済みライブラリ採用（サニタイズ必須）

4. storage容量上限
- 現状: 件数上限のみ（threads50/messages200）
- リスク: 長文メッセージで `chrome.storage.local` 容量超過
- 対策: 文字数ベース制限と圧縮・要約方針を追加
- 運用判断(2026-02-23): WSL側ローカル保存API導入はBacklogへ先送り。MVPは現行方式で実装継続。

5. 同時更新競合
- 現状: token/done/error の同一メッセージ更新は background 側キューで直列化済み
- リスク: それ以外の更新経路（例: 将来追加機能）で read-modify-write 競合が再発する余地
- 対策: repository層に汎用の更新直列化キューを導入し、全更新APIで共通化

6. 依存導入失敗によるテスト未実行
- 現状: `registry.npmjs.org` 名前解決不可（`EAI_AGAIN`）で `npm install` 失敗
- リスク: `npm test`/`npm run build` の実行結果をこの環境で確定できない
- 対策: ネットワーク到達可能環境で `npm ci && npm test && npm run build` を実施し結果を固定

## 技術的負債の優先順位
1. WS厳密スキーマ化
2. repository更新直列化の全面適用
3. Portベース配信
4. Markdown機能拡張
5. 容量上限の文字数制御
6. オフライン環境でのCI未検証
