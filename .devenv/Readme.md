# Development Environment

<!-- @import "[TOC]" {cmd="toc" depthFrom=1 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Development Environment](#development-environment)
  - [結論](#結論)
  - [このフォルダの目的](#このフォルダの目的)
  - [前提条件](#前提条件)
  - [使用方法](#使用方法)
  - [コンフィグレーション](#コンフィグレーション)
    - [`[codex].codex_home_relative`](#codexcodex_home_relative)
    - [`[git].user_name`](#gituser_name)
    - [`[git].user_email`](#gituser_email)
    - [`[clangd].enable`](#clangdenable)
    - [`[clangd].exclude_path`](#clangdexclude_path)
    - [`[clangd].background_skip_path`](#clangdbackground_skip_path)
    - [`[serena].enable`](#serenaenable)
    - [`[serena].ignored_paths`](#serenaignored_paths)
  - [codex cli メタデータ仕様](#codex-cli-メタデータ仕様)
  - [よくある失敗と対処](#よくある失敗と対処)

<!-- /code_chunk_output -->


## 結論
これは、プロジェクトで codex cli を使用できるようにするための開発環境セットアップ用スクリプトです。
codex cli が作業を自動化するために必要な、Node.js と Python の環境をプロジェクト単位で管理します。

## このフォルダの目的
- 開発環境の初期化を `./.devenv/setup.sh` に一本化します。
- シェル入場時の環境反映を `./.devenv/run.sh`（`.envrc` から `source`）に一本化します。
- 重い処理（インストール・venv作成）と軽い処理（既存環境の有効化）を分離し、起動コストを抑えます。
- `clangd` と `serena` 向けの設定同期を、シェル入場時に自動実行します（有効化時のみ）。

## 前提条件
- 必須
    - `bash`
    - `git`
    - `direnv` (https://github.com/direnv/direnv)
- Node.js 関連
    - `nvm` (https://github.com/nvm-sh/nvm)
        - `$HOME/.nvm/nvm.sh`
    - `npm`
        - Codex パッケージ導入に使用
- Python 関連
    - `uv` (https://github.com/astral-sh/uv)
        - Python インストールと `.venv` 作成に使用

## 使用方法
1. このリポジトリをクローン

    ```bash
    $ git clone https://github.com/taturou/devenv.git /tmp/devenv
    ```

1. .devenv フォルダをプロジェクトルートへ移動

    ```bash
    $ cd /path/to/your/project
    $ cp -a /tmp/devenv/.devenv ./
    ```

1. 初回セットアップ

    ```bash
    $ ./.devenv/setup.sh
    ```

1. シェルへ反映

    ```bash
    $ direnv allow
    $ cd .. && cd -
    ```

    または新しいシェルを開きます。

1. 日常運用
    - プロジェクトに `cd` すると `.envrc` 経由で以下が自動反映されます。
    - `.nvmrc` があれば該当 Node バージョンへ切替（未導入時は案内のみ）
    - `.python-version` と `.venv` が整っていれば仮想環境を有効化
    - `CODEX_HOME` と関連 PATH を設定
    - compile_commands.json をもとに `.clangd` を生成（有効化時のみ）
    - `.serena/project.yml` の `ignored_paths` を更新（有効化時のみ）

## コンフィグレーション
- テンプレート: `./.devenv/config.template.toml`
- 生成ファイル: `./.devenv/config.toml`
    - `./.devenv/setup.sh` 実行時にテンプレートからコピーされます。

### `codex` セクション
#### `[codex].codex_home_relative`
- 役割:
    - codex cli の設定ファイルを置くディレクトリを、プロジェクトルートからの相対パスで指定します。
- 既定値:
    - `[codex].codex_home_relative` が未設定または空文字のとき、`.codex` を使用します。
- 記述例:

    ```toml
    [codex]
    codex_home_relative = ".codex"
    ```

### `git` セクション
#### `[git].user_name`
- 役割:
    - リポジトリローカル (`.git/config`) の `user.name` を指定します。
- 既定値:
    - 未設定または空文字のとき、`$HOME/.gitconfig` の `user.name` を使用します。
- 記述例:

    ```toml
    [git]
    user_name = "Taro Yamada"
    ```

#### `[git].user_email`
- 役割:
    - リポジトリローカル (`.git/config`) の `user.email` を指定します。
- 既定値:
    - 未設定または空文字のとき、`$HOME/.gitconfig` の `user.email` を使用します。
- 記述例:

    ```toml
    [git]
    user_email = "taro@example.com"
    ```

### `clangd` セクション
#### `[clangd].enable`
- 役割:
    - `true` のとき、シェル入場時に `./.devenv/clangd/generate_clangd.py` を実行し、`.clangd` を更新します。
- 既定値:
    - `false`
- 記述例:

    ```toml
    [clangd]
    enable = true
    ```

#### `[clangd].exclude_path`
- 役割:
    - `.clangd` 生成時に、`compile_commands.json` 探索と `CompileFlags.PathMatch` 生成対象から除外するパスを指定します。
- 既定値:
    - `[]`
- 記述例:

    ```toml
    [clangd]
    exclude_path = ["source/foo/generated", "third_party/libx"]
    ```

#### `[clangd].background_skip_path`
- 役割:
    - `.clangd` へ `Index.Background: Skip` を出力するパスを指定します。
- 既定値:
    - `[]`
- 記述例:

    ```toml
    [clangd]
    background_skip_path = ["third_party/llvm-project"]
    ```

### `serena` セクション
#### `[serena].enable`
- 役割:
    - `true` のとき、シェル入場時に `./.devenv/serena/update_serena_config.py` を実行し、`.serena/project.yml` の `ignored_paths` を更新します。
- 既定値:
    - `false`
- 記述例:

    ```toml
    [serena]
    enable = true
    ```

#### `[serena].ignored_paths`
- 役割:
    - `.serena/project.yml` の `ignored_paths` に追記・同期するパスを指定します。
- 既定値:
    - `[]`
- 記述例:

    ```toml
    [serena]
    ignored_paths = ["source/foo/generated", "third_party/libx"]
    ```

## codex cli メタデータ仕様
- `./.devenv/config.toml`
    - コピー元: `./.devenv/config.template.toml`
    - 動作: 未作成時のみコピー（既存は上書きしません）。
- `$CODEX_HOME/config.toml`
    - コピー元: `./.devenv/codex/template/config.toml`
    - 動作: 未作成時のみコピー（既存は上書きしません）。
- `$CODEX_HOME/AGENTS.md`
    - リンク元: `$HOME/.codex/AGENTS.md`
    - 動作: 元ファイルが存在し、かつ未作成時のみシンボリックリンクを作成します。
- `$CODEX_HOME/auth.json`
    - リンク元: `$HOME/.codex/auth.json`
    - 動作: 元ファイルが存在し、かつ未作成時のみシンボリックリンクを作成します。
- `.clangd`
    - コピー元: なし（生成）
    - 動作: `./.devenv/config.toml` の `[clangd].enable = true` かつ `python3` 利用可能時に、シェル入場ごとに再生成します。
- `.serena/project.yml`
    - コピー元: なし（既存ファイルを更新）
    - 動作: `./.devenv/config.toml` の `[serena].enable = true` かつ `python3` 利用可能時に、`ignored_paths` のみ追記・同期します。

## よくある失敗と対処
- `[nvm] not found`
- `nvm` をインストールし、`$HOME/.nvm/nvm.sh` を配置してください。
- `[uv] not found`
- `uv` をインストールしてください。
- `[uv] .venv not found` / `python ... is not installed`
- `./.devenv/setup.sh` を再実行してください。
- `[clangd] failed to generate .clangd`
- `python3` の存在と `./.devenv/config.toml` の `[clangd]` 設定（特に `exclude_path` / `background_skip_path`）を確認してください。
- `[serena] failed to update .serena/project.yml`
- `.serena/project.yml` が存在するか、`./.devenv/config.toml` の `[serena].ignored_paths` が配列になっているか確認してください。
