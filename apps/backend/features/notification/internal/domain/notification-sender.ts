// 通知を送る窓口（interface）。送り方（ログに出す・メールやチャットに送る）は infra の実装が決める。
// WHY domain に interface だけを置く: application（SendNotificationCommand）は「送れる何か」にだけ依存し、送り先を変えても
//   command を直さずに済むようにする（依存性の逆転。todo の TodoRepository と同じ形）。
// WHY 値の検証（zod）を持たない: 今の本文は呼び出し側（todo）が組み立てた英語の固定の形だけで、利用者の入力ではない。
//   検証を入れるには新しい ErrorKey が要り、画面の辞書まで変わる。外から任意の本文を受けるようになったら決める。
// WHY Promise を返す: ログに出す実装は同期で済むが、外部に送る実装は非同期になる。同じ形にそろえる。
export interface NotificationSender {
  send(message: string): Promise<void>;
}
