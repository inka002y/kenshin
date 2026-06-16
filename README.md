# 聖隷健康診断 空き通知モニター

聖隷健康サポートセンターShizuokaの「雇入れ時健診」について、2026年7月全体の空き枠を確認し、空きがあればDiscordへ通知します。

## ローカルで確認

```bash
npm run check
```

Discordへ送る場合は、環境変数を指定します。

```bash
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." npm run check
```

Windows PowerShellの場合:

```powershell
$env:DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
npm run check
```

## GitHub Actionsで5分ごとに動かす

1. このフォルダをGitHubリポジトリにpushします。
2. GitHubのリポジトリで `Settings` -> `Secrets and variables` -> `Actions` を開きます。
3. `New repository secret` で `DISCORD_WEBHOOK_URL` を追加します。
4. `Actions` タブから `Health Reserve Monitor` を有効化します。
5. 必要なら `Run workflow` で手動実行して確認します。

GitHub ActionsのスケジュールはUTC基準です。この設定は5分ごとに実行されます。

## 重複通知について

一度Discordへ通知した日付は `state/notified.json` に保存します。同じ日付の空きが残っていても、次回以降は再通知しません。別の日に新しく空きが出た場合だけ通知します。
