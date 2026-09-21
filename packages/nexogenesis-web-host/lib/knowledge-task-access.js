import { HttpError } from './rpc.js';

// Historical ingestion records may be displayed, but cannot regain execution
// authority through ordinary conversation, queued continuations or old forms.
export const isRetiredIngestion = value => ['compile','theme_compile','digest'].includes(value?.run?.mode ?? value);
export const RETIRED_INGESTION_MESSAGE = '旧编译与消化流程已退役，历史记录和成果保留；请从编译入口选择原书开始新的图书编译。';
export function assertCurrentKnowledgeExecution(value) {
  if (isRetiredIngestion(value)) throw new HttpError(409, RETIRED_INGESTION_MESSAGE);
}
