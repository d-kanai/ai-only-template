# クラウドセッションの Node / pnpm は setup script と SessionStart フックの二段で用意し、nodejs.org に届かなければ npm レジストリから取る

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #23 / PR #30 / Issue #34 / PR #37 / Issue #36 / PR #38（クローズ）/ `.claude/rules/cloud-session.md` / スキル `cloud-session` / `scripts/cloud-session-start.sh`

## 背景
Claude Code のクラウド VM には Node 20〜22 しか無く asdf も無いため、`.tool-versions` の Node 24.21.0 / pnpm 12.7.0 をセッション側で用意する必要があった。VM は毎セッション新しく、環境設定の setup script は初回だけ実行されてキャッシュされ、SessionStart フックは毎回実行される（https://code.claude.com/docs/en/cloud-environments ）。初回のトライでは、nodejs.org への接続がプロキシに 403 で拒否された。

## 決定
- `scripts/cloud-session-start.sh` を、setup script（`--install-only`。初回に入れてキャッシュ）と SessionStart フック（毎回。入っていれば PATH の追記と `pnpm install` だけ）の二段で使う。版は `.tool-versions` だけから読む。
- nodejs.org から取れなければ、npm レジストリの `node-linux-<arch>`（Node の公式バイナリを同梱）と pnpm（`pnpm` と `@pnpm/exe.<platform>`）を取り、`dist.integrity` で検証してから置く。
- フックは失敗してもセッションを止めない（常に exit 0）。クラウドでも `.tool-versions` の Node 24 を使う。

## 理由
- フックだけで毎回 Node を入れるのは遅い（ユーザーの指摘。PR #30）。
- `registry.npmjs.org` はプロキシを通らず直接届き、既定のネットワークポリシーのままで使える。レジストリの Node は nodejs.org の配布物と同一だった（2026-09-28 の work-logs「クラウドセッション（Claude Code on the web）の初回トライで環境を実測」「クラウドセッション用フックに npm レジストリからの Node / pnpm 取得を追加（Issue #34）」）。
- pnpm 12 の `pnpm` パッケージは placeholder で、本体はネイティブバイナリ。2 つを取って検証しないと、初回実行時の自前ダウンロードが検証とタイムアウトの外になる（同日の work-logs、LEARNINGS.md）。

## 採用しなかった案
- フックだけで毎セッション入れる（Issue #23 の最初の設計）: 遅い。
- フックでの Node / pnpm の導入を止め、VM 既定の Node 22 で `pnpm install` だけ行う（Issue #36 / PR #38）: レジストリへのフォールバック（PR #37）が先にマージされて前提が消え、ユーザーの判断「24 動くようになったならそれに合わせる」でクローズした（2026-09-28 の work-logs「SessionStart フックの導入を一時停止する PR #38 / Issue #36 を、#37 に置き換わったためクローズ」）。
- 環境設定で nodejs.org を許可ドメインに加えることを前提にする: フォールバックで既定のまま動くので必須にしない。

## 影響
- 良い点: ネットワークの設定を変えずに、クラウドでも手元と同じ版で動く。
- 悪い点: スクリプトとテストが大きい。フックの時間の上限（600 秒）に収まるよう、取得のタイムアウトを配分する必要がある。フックとして起動したときの一部の挙動は未確認（`.claude/rules/cloud-session.md`）。
- 見直す条件: 記録に無い。
