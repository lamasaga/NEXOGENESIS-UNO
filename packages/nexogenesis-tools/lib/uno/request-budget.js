/** Host-owned provider dispatch budget. No model tools, prompt bodies or credentials. */
import { randomUUID, createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { safeId } from '../uno-contract.js';
import { unoPath } from '../harness/uno-storage.js';
import { sessionCompileJob } from './state.js';

export const PROVIDER_BUDGET_PROFILE = 'bounded-workflow-v1';
const ROLES = new Set(['select', 'author', 'reviewer']);
const DEFAULT_STAGE_LIMIT = { select: 3, author: 6, reviewer: 4 };
const OUTCOMES = new Set(['completed', 'truncated', 'failed', 'cancelled', 'incomplete']);
const now = () => new Date().toISOString();
export class ProviderBudgetError extends Error {
  constructor(message, code = 'UNO_BUDGET_STATE') { super(`[${code}] ${message}`); this.name = 'ProviderBudgetError'; this.code = code; }
}
const fail = (message, code) => { throw new ProviderBudgetError(message, code); };
function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > 100000) fail(`${name}无效。`);
  return value;
}
function identifier(value, name) {
  if (typeof value !== 'string' || !value || value.length > 180 || /[\x00-\x1f]/.test(value)) fail(`${name}无效。`);
  return value;
}
function ledgerPath(root, jobId) {
  if (!safeId(jobId)) fail('预算任务 ID 无效。');
  return unoPath(root, `.nexogenesis/provider-request-budgets/${jobId}.json`);
}
function sessionPath(root, sessionId) {
  identifier(sessionId, '会话 ID');
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return unoPath(root, `.nexogenesis/provider-budget-sessions/${digest}.json`);
}
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail('请求预算记录缺失或损坏，未发送模型请求。'); }
}
function validate(ledger, jobId) {
  if (ledger?.schema !== 1 || ledger.profile !== PROVIDER_BUDGET_PROFILE || ledger.job_id !== jobId
    || !ledger.imported || !Array.isArray(ledger.requests) || !ledger.stages || !ledger.packages) fail('请求预算记录不兼容。');
  integer(ledger.limit, '请求上限', 1); integer(ledger.imported.used, '已消费请求');
  if (ledger.imported.used + ledger.requests.length > ledger.limit) fail('请求预算累计数超过授权上限。');
  const ids = new Set();
  for (const [index, row] of ledger.requests.entries()) {
    if (!row || row.number !== ledger.imported.used + index + 1 || typeof row.id !== 'string' || ids.has(row.id)
      || !Object.hasOwn(ledger.stages, row.stage_id)) fail('请求预算序号或阶段损坏。');
    const stage = ledger.stages[row.stage_id];
    if (row.role !== stage.role || row.package_id !== stage.package_id || !['work','compaction','session-title','auxiliary'].includes(row.purpose)
      || (row.state !== 'reserved' && !OUTCOMES.has(row.state))) fail('请求预算尝试记录损坏。');
    ids.add(row.id);
  }
  for (const stage of Object.values(ledger.stages)) {
    if (!ROLES.has(stage.role) || !Object.hasOwn(ledger.packages, stage.package_id)) fail('请求预算阶段损坏。');
    integer(stage.limit, '阶段上限', 1);
  }
  for (const pack of Object.values(ledger.packages)) integer(pack.review_reserve, '审核预留');
  if (ledger.current && (!Object.hasOwn(ledger.stages, ledger.current.stage_id) || !ledger.current.session_id)) fail('请求预算当前阶段损坏。');
  return ledger;
}
function atomicWrite(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path);
  } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp); }
}
// The lock covers read/check/append/replace. A stale crash lock fails closed; no timed stealing.
function transact(root, jobId, operation) {
  const path = ledgerPath(root, jobId); mkdirSync(dirname(path), { recursive: true });
  let fd;
  try { fd = openSync(path + '.lock', 'wx', 0o600); }
  catch { fail('请求预算正在写入或需要恢复，未发送模型请求。', 'UNO_BUDGET_LOCKED'); }
  try {
    const ledger = existsSync(path) ? validate(readJson(path), jobId) : null;
    const result = operation(ledger);
    if (result.write) atomicWrite(path, result.write);
    return result.value;
  } catch (error) {
    if (error instanceof ProviderBudgetError) throw error;
    const failure = new ProviderBudgetError('请求预算无法可靠保存，未发送新的模型请求。');
    failure.storage_code = typeof error.code === 'string' ? error.code : error.name;
    throw failure;
  } finally { closeSync(fd); unlinkSync(path + '.lock'); }
}
function used(ledger) { return ledger.imported.used + ledger.requests.length; }
function stageCounts(ledger, stageId) { return ledger.requests.filter(row => row.stage_id === stageId).length; }
function heldReview(ledger, packageId) {
  const reserve = ledger.packages[packageId].review_reserve;
  const attempts = ledger.requests.filter(row => row.package_id === packageId && row.role === 'reviewer' && row.purpose === 'work').length;
  return Math.max(0, reserve - attempts);
}
function snapshot(ledger) {
  const remaining = ledger.limit - used(ledger), current = ledger.current;
  let stageView = null;
  if (current) {
    const stage = ledger.stages[current.stage_id], stageUsed = stageCounts(ledger, current.stage_id);
    const reviewReserve = heldReview(ledger, stage.package_id), stageRemaining = Math.max(0, stage.limit - stageUsed);
    stageView = { stageId: current.stage_id, sessionId: current.session_id, packageId: stage.package_id, role: stage.role,
      stageLimit: stage.limit, stageUsed, stageRemaining, reviewReserve,
      allowance: Math.max(0, Math.min(stageRemaining, remaining - (stage.role === 'reviewer' ? 0 : reviewReserve))),
      auxiliaryAllowance: Math.max(0, Math.min(stageRemaining - (stage.role === 'reviewer' ? reviewReserve : 0), remaining - reviewReserve)) };
  }
  return { profile: ledger.profile, jobId: ledger.job_id, used: used(ledger), limit: ledger.limit, remaining,
    imported: ledger.imported.used, unknownUsage: ledger.imported.used + ledger.requests.filter(row => row.usage?.status !== 'reported').length,
    current: stageView };
}

/** Only trusted host code may initialize/import. Replaying does not reset consumption. */
export function initializeProviderBudget(root, jobId, { limit, alreadyUsed = 0, provenance = null } = {}) {
  integer(limit, '请求上限', 1); integer(alreadyUsed, '已消费请求');
  if (alreadyUsed > limit || (alreadyUsed && (typeof provenance !== 'string' || !provenance.trim() || provenance.length > 1000))) fail('导入已消费预算需要可核对的宿主来源说明。');
  return transact(root, jobId, previous => {
    if (previous) {
      if (previous.limit !== limit || previous.imported.used !== alreadyUsed || previous.imported.provenance !== provenance) fail('已有请求预算不能重新初始化或清零。');
      return { value: snapshot(previous) };
    }
    const ledger = { schema: 1, profile: PROVIDER_BUDGET_PROFILE, job_id: jobId, created_at: now(), limit,
      imported: { used: alreadyUsed, provenance }, limit_changes: [], packages: {}, stages: {}, requests: [], current: null };
    return { write: ledger, value: snapshot(ledger) };
  });
}
/** Explicit user-approved host action only; never exposed as a model tool. */
export function raiseProviderBudget(root, jobId, limit) {
  integer(limit, '请求上限', 1);
  return transact(root, jobId, ledger => {
    if (!ledger) fail('请求预算尚未初始化。');
    if (limit < ledger.limit) fail('请求预算上限只能增加，不能减少或清零。');
    if (limit > ledger.limit) ledger.limit_changes.push({ from: ledger.limit, to: limit, at: now() });
    ledger.limit = limit;
    return { write: ledger, value: snapshot(ledger) };
  });
}

/**
 * Explicit resume grants a fresh allowance without erasing the audit ledger.
 * Repeated clicks before any further provider request do not keep increasing
 * the limit: the ledger is raised only until `remaining >= allowance`.
 */
export function replenishProviderBudget(root, jobId, allowance) {
  integer(allowance, '继续请求额度', 1);
  return transact(root, jobId, ledger => {
    if (!ledger) fail('请求预算尚未初始化。');
    const before = snapshot(ledger), target = before.used + allowance;
    if (target > 100000) fail('累计请求额度超过可审计上限。');
    if (ledger.limit < target) {
      ledger.limit_changes.push({ from: ledger.limit, to: target, at: now(), kind: 'resume-allowance', allowance });
      ledger.limit = target;
    }
    return { write: ledger, value: snapshot(ledger) };
  });
}
export function getProviderBudget(root, jobId) {
  // Readers use the same short lock: Windows may reject replacement of a file open in another process.
  return transact(root, jobId, ledger => {
    if (!ledger) fail('请求预算尚未初始化。');
    return { value: snapshot(ledger) };
  });
}

/** Index is reconstructible; stage configurations/counters live only in the job ledger. */
export function bindProviderBudgetSession(root, { jobId, sessionId, packageId = 'selection', role, stageId = `${packageId}:${role}`, stageLimit, reviewReserve } = {}) {
  identifier(sessionId, '会话 ID'); identifier(packageId, '工作包 ID'); identifier(stageId, '阶段 ID');
  if (!ROLES.has(role) || ['__proto__', 'constructor', 'prototype'].includes(packageId) || ['__proto__', 'constructor', 'prototype'].includes(stageId)) fail('预算角色或阶段 ID 无效。');
  const indexPath = sessionPath(root, sessionId);
  if (existsSync(indexPath)) {
    const index = readJson(indexPath);
    if (index.job_id !== jobId || index.session_id !== sessionId) fail('此会话已经绑定另一请求预算。');
  }
  const result = transact(root, jobId, ledger => {
    if (!ledger) fail('请求预算尚未初始化。');
    const previousStage = Object.hasOwn(ledger.stages, stageId) ? ledger.stages[stageId] : null;
    const previousPack = Object.hasOwn(ledger.packages, packageId) ? ledger.packages[packageId] : null;
    const reserve = reviewReserve ?? previousPack?.review_reserve ?? (role === 'select' ? 0 : 3);
    const limit = stageLimit ?? previousStage?.limit ?? DEFAULT_STAGE_LIMIT[role];
    integer(reserve, '审核预留'); integer(limit, '阶段上限', 1);
    if (previousPack && previousPack.review_reserve !== reserve) fail('同一工作包的审核预留不能被重绑重置。');
    if (previousStage && (previousStage.role !== role || previousStage.package_id !== packageId || previousStage.limit !== limit)) fail('同一阶段的角色、工作包或额度不能被重绑重置。');
    if (!previousPack && role === 'author' && ledger.limit - used(ledger) < reserve + 1) fail('剩余额度不足以启动作者并保留审核请求。', 'UNO_REVIEW_RESERVE');
    if (!previousPack) ledger.packages[packageId] = { review_reserve: reserve, created_at: now() };
    if (!previousStage) ledger.stages[stageId] = { package_id: packageId, role, limit, created_at: now() };
    ledger.current = { stage_id: stageId, session_id: sessionId, bound_at: now() };
    return { write: ledger, value: snapshot(ledger) };
  });
  mkdirSync(dirname(indexPath), { recursive: true });
  // Native task sessions must not be reassigned across jobs. Competing bindings fail closed.
  try { writeFileSync(indexPath, JSON.stringify({ schema: 1, profile: PROVIDER_BUDGET_PROFILE, session_id: sessionId, job_id: jobId }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST' || readJson(indexPath).job_id !== jobId) fail('会话预算索引写入失败；请重新绑定后再调用模型。');
  }
  return result;
}

function requestBinding(ctx, options) {
  if (!options.sessionId) return null;
  const root = ctx.get?.('sessions')?.get(options.sessionId)?.header?.cwd ?? options.nexoPrompt?.root;
  if (!root) return null; // Unattributable calls require a transport-level fence; never claim otherwise.
  const path = sessionPath(root, options.sessionId);
  if (existsSync(path)) {
    const index = readJson(path);
    if (index.schema !== 1 || index.profile !== PROVIDER_BUDGET_PROFILE || index.session_id !== options.sessionId || !safeId(index.job_id)) fail('会话预算索引损坏。');
    return { root: resolve(root), jobId: index.job_id };
  }
  const job = sessionCompileJob(root, options.sessionId);
  if (job?.orchestration_profile === PROVIDER_BUDGET_PROFILE) fail('本任务尚未绑定供应商请求预算，未发送模型请求。', 'UNO_BUDGET_UNBOUND');
  return null;
}
/** Freeze attribution before credential/image awaits so a late request cannot change stage. */
export function captureProviderRequestContext(ctx, options) {
  const binding = requestBinding(ctx, options);
  if (!binding) return null;
  const budget = getProviderBudget(binding.root, binding.jobId);
  if (budget.remaining <= 0) fail('本任务供应商请求额度已用尽；已有响应仍可保存和交接。', 'UNO_PROVIDER_BUDGET');
  const current = budget.current;
  if (!current || current.sessionId !== options.sessionId) fail('此请求属于旧执行阶段，未发送模型请求。', 'UNO_BUDGET_STALE_STAGE');
  return { ...binding, stageId: current.stageId, sessionId: options.sessionId };
}
/** Call immediately before each actual fetch, including every retry/auxiliary call. */
export function reserveProviderRequest(ctx, options, captured = undefined) {
  const binding = captured === undefined ? captureProviderRequestContext(ctx, options) : captured;
  if (!binding) return null;
  const purpose = options.purpose ? (['compaction', 'session-title'].includes(options.purpose) ? options.purpose : 'auxiliary') : 'work';
  return transact(binding.root, binding.jobId, ledger => {
    if (!ledger) fail('请求预算尚未初始化。');
    const current = snapshot(ledger).current;
    if (used(ledger) >= ledger.limit) fail('本任务供应商请求额度已用尽；已有响应仍可保存和交接。', 'UNO_PROVIDER_BUDGET');
    if (!current || current.sessionId !== options.sessionId || current.stageId !== binding.stageId) fail('此请求属于旧执行阶段，未发送模型请求。', 'UNO_BUDGET_STALE_STAGE');
    if (current.stageRemaining <= 0) fail('当前阶段供应商请求额度已用尽。', 'UNO_STAGE_BUDGET');
    if ((purpose === 'work' ? current.allowance : current.auxiliaryAllowance) <= 0) fail('剩余请求已为独立审核保留，未发送本次模型请求。', 'UNO_REVIEW_RESERVE');
    const id = randomUUID();
    const row = { id, number: used(ledger) + 1, reserved_at: now(), session_id: options.sessionId, package_id: current.packageId,
      stage_id: current.stageId, role: current.role, purpose, provider: String(options.provider ?? '').slice(0,120), model: String(options.model ?? '').slice(0,120), state: 'reserved', usage: { status: 'unknown' } };
    ledger.requests.push(row);
    return { write: ledger, value: { ...binding, id } };
  });
}
/** Settlement never refunds requests. Crash/unknown/reserved attempts remain consumed. */
export function settleProviderRequest(reservation, { state = 'incomplete', usage = null } = {}) {
  if (!reservation) return;
  if (!OUTCOMES.has(state)) fail('请求结束状态无效。');
  return transact(reservation.root, reservation.jobId, ledger => {
    if (!ledger) fail('请求预算记录缺失。');
    const row = ledger.requests.find(item => item.id === reservation.id);
    if (!row) fail('供应商请求预留记录缺失。');
    if (row.state !== 'reserved') return { value: snapshot(ledger) };
    const reported = {};
    for (const key of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens']) {
      if (Number.isFinite(usage?.[key]) && usage[key] >= 0) reported[key] = usage[key];
    }
    row.state = state; row.finished_at = now(); row.usage = Object.keys(reported).length ? { status: 'reported', ...reported } : { status: 'unknown' };
    return { write: ledger, value: snapshot(ledger) };
  });
}
