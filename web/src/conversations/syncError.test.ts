import { expect, it } from 'vitest';
import { workSyncErrorMessage } from './syncError';

it('区分超时、网络失败与后台错误，不将进度请求失败当成模型失败', () => {
  expect(workSyncErrorMessage(new DOMException('timeout', 'TimeoutError'))).toContain('进度同步超时');
  expect(workSyncErrorMessage(new TypeError('Failed to fetch'))).toContain('网页暂时无法连接后台');
  expect(workSyncErrorMessage(new Error('HTTP 503'))).toContain('HTTP 503');
  expect(workSyncErrorMessage(new Error('HTTP 500'))).toContain('不会自动暂停任务');
});
