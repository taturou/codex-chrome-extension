# TASK

- [x] 要件確認（PLAN.md読解・実装範囲確定）
- [x] プロジェクト基盤作成（Vite/React/TypeScript/MV3設定）
- [x] メッセージ契約・型定義の実装
- [x] storage repository と上限管理（threads 50/messages 200）実装
- [x] WS transport adapter（指数バックオフ/手動再接続）実装
- [x] background service worker 実装
- [x] sidepanel React UI 実装（スレッド/チャット/添付/接続状態）
- [x] optionsページ実装（wsUrl設定）
- [x] Markdown安全表示（HTMLエスケープ）実装
- [x] テスト実装（backoff/storage上限/token結合）
- [x] レビュー指摘修正（token更新直列化・多重接続防止・添付失敗導線）
- [x] 回帰テスト追加（ws reconnect, appendToken状態ガード）
- [x] npm scripts(build,test)確認（実行試行、依存取得がEAI_AGAINで失敗）
- [x] DESIGN.md 作成
- [x] CONCERN.md 作成
- [x] 最終動作確認・報告

## Backlog（先送り）
- [ ] WSL側ローカル保存API導入（`chrome.storage.local` 容量上限対策）
  - 想定: 拡張はAPI経由で永続化し、履歴本体をLinux/WSL側（例: SQLite）へ保存
  - 方針: MVPの「まず動くもの」を優先し、現時点では未着手
