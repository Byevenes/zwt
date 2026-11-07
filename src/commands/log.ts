import { Console, Effect } from "effect"
import { renderActionLog } from "../action-log.ts"
import { ActionLog } from "../services/ActionLog.ts"

export const showLog = Effect.gen(function*() {
  const entries = yield* (yield* ActionLog).entries
  yield* Console.log(entries.length === 0 ? "no actions" : renderActionLog(entries))
})
