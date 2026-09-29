# コミットメッセージ（常時）

1 行目にサマリ、本文に次の 4 項目を絵文字付きで書く。形式は lefthook の commit-msg フック（`lefthook.yml`）が検査する。

```
<サマリ>

🎯 WHY
<なぜこの変更が必要か>

📝 WHAT
<何を変更したか>

🛠️ 実装経緯
<どう進めたか、検討・変更した判断>

✅ 検証内容
<何をどう確認したか。未確認のことは未確認と書く>
```

- 末尾に `Co-Authored-By: <モデル名>` を付ける（例: `Co-Authored-By: Claude Opus 5.5`）。メールアドレスは任意（Claude Code が付ける `<noreply@anthropic.com>` はそのままでよい）。commit-msg フックが見るのは `Co-Authored-By:` の行があるかだけ。
