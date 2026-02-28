---
name: git-commit
description: ステージ済みの Git 変更のみを Conventional Commits 形式でコミットします。`git commit` 実行の依頼時、コミットメッセージの標準化時、または「ステージ済みのみをコミットする」運用ポリシーを強制したい場合に使用します。変更の目的・意図が不明な場合は、コミット前に必ず人間へ確認します。
---

# Git コミット

## ルール

- ステージ済みの変更のみをコミットします。
- 明示的な指示がない限り、`git add` / `git restore --staged` / `git reset` / 破棄操作を実行しません。
- コミットメッセージは Conventional Commits 形式にします。
- コミットメッセージ（タイトル・本文）は英語で記載します。
- タイトルは修正目的を簡潔に要約します。
- 本文は次の順序で記載します。
  1. 目的・意図
  2. 修正内容
- スキル呼び出し時にパラメータが指定された場合、その内容をコミット目的・意図として解釈します。
- ステージ差分と文脈から目的・意図を確定できない場合、コミット前に人間へ確認します。

## ワークフロー

1. ステージ済み変更を確認します。
  ```bash
  git status --short
  git diff --cached --stat
  git diff --cached
  ```
2. スキル呼び出し時のパラメータがある場合はそれを優先して目的・意図として採用します。なければ、ステージ差分と周辺コンテキストから修正目的を推定します。
3. 目的が不明な場合は処理を停止し、人間に確認します。
4. Conventional Commit 形式でメッセージを作成します。
5. ステージ済み変更のみをコミットします。
  ```bash
  git commit -m "<type>(<scope>): <purpose-summary>" -m "<body>"
  ```
6. 結果を検証します。
  ```bash
  git log -1 --pretty=format:'%H%n%s%n%b'
  git status --short
  ```

## Conventional Commit ガイド

- 使用可能な主 type: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`
- 追跡性が上がる場合は scope を付与します。例: `feat(extension): ...`
- タイトルは命令形を維持し、可能な限り 72 文字程度以内に収めます。
- `!` または `BREAKING CHANGE:` は破壊的変更時のみ使います。

## メッセージテンプレート

```text
<type>(<scope>): <purpose-summary>

Purpose and intent:
<why this change is needed, expected effect, risk reduced>

Changes:
- <change 1>
- <change 2>
- <change 3>
```

## 目的確認プロンプト

目的・意図が不明な場合、必ず次の形式で確認します。

```text
コミット目的・意図が差分から確定できません。以下を1-2文で指定してください。
- 何を達成する変更か
- どのリスク/不具合を解消するか
```
