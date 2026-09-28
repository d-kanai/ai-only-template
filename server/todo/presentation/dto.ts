// Todo API のリクエスト / レスポンスの型。
// WHY ここに置く: 画面側（features/todo）とサーバ側（server/todo）が同じ契約を共有するため。
//   画面側からは `import type` だけで参照し、サーバの実装を画面のバンドルに持ち込まない（rules/code/architecture.md）。

export type TodoDto = {
  id: string;
  title: string;
  completed: boolean;
  // ISO 8601 文字列。JSON にそのまま載せられるよう Date ではなく string にしている。
  createdAt: string;
};

export type CreateTodoRequest = {
  title: string;
};

// 部分更新。送られてきた項目だけを更新する（PUT だが PATCH 相当の意味にしている。CRUD の雛形として動詞を減らすため）。
export type UpdateTodoRequest = {
  title?: string;
  completed?: boolean;
};

export type TodoListResponse = {
  todos: TodoDto[];
};

export type ErrorResponse = {
  error: {
    // "validation_error" | "not_found" など。画面側で分岐できるよう機械可読なコードを持つ。
    code: string;
    message: string;
  };
};
