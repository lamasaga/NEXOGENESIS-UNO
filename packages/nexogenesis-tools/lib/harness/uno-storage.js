/** Internal implementation of HarnessGateway's UNO transactions; never called by Web handlers directly. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { stringify as yaml } from "yaml";
import { invalidateKnowledgeSnapshot, parseCardFile } from "../cards.js";

export const sha = data => createHash("sha256").update(data).digest("hex");
export function unoPath(root, ref) {
  if (typeof ref !== "string" || !ref || ref.includes("\\") || ref.split("/").some(p => !p || p === "." || p === ".." || /[:\x00-\x1f]/.test(p))) throw new Error("知识路径无效。");
  const base = resolve(root), path = resolve(base, ref);
  if (!path.startsWith(base + sep)) throw new Error("知识路径越界。");
  let cursor = base;
  if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("知识根目录不能是链接。");
  for (const part of ref.split("/")) { cursor = join(cursor, part); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("知识路径不能经过链接。"); }
  return path;
}
export function unoRevision(root, ref) { const path = unoPath(root, ref); return existsSync(path) ? sha(readFileSync(path)) : null; }
export function unoCardRef(root,card) {
  const ref=relative(resolve(root),card.file).split(sep).join("/");
  if(!ref.startsWith("01-Cards/"))throw new Error("卡片不在知识目录中。");
  unoPath(root,ref);return ref;
}
function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + ".uno-staging";
  try { writeFileSync(temp, content); renameSync(temp, path); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function unoMarkdown(meta, body) { return "---\n" + yaml(meta, { lineWidth: 0, doubleQuotedAsJSON: true }).trimEnd() + "\n---\n\n" + body; }
const receiptRef = key => ".nexogenesis/uno-receipts/" + sha(key) + ".json";
const processIdentity = randomUUID();
export function inspectUnoLock(root) {
  const lock = unoPath(root, '.nexogenesis/uno-write-lock');
  if (!existsSync(lock)) return { status: 'unlocked' };
  let owner;
  try { owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')); }
  catch { return { status: 'needs_inspection', code: 'LOCK_OWNER_UNREADABLE' }; }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return { status: 'needs_inspection', code: 'LOCK_OWNER_INVALID' };
  if (owner.pid === process.pid && owner.process_identity && owner.process_identity !== processIdentity) return { status: 'stale', owner };
  try { process.kill(owner.pid, 0); return { status: 'busy', owner }; }
  catch (error) { return { status: error.code === 'ESRCH' ? 'stale' : 'needs_inspection', owner }; }
}
export function readUnoReceipt(root, key) {
  const path = unoPath(root, receiptRef(key));
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
function recover(root) {
  const dir = unoPath(root, ".nexogenesis/uno-transactions");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter(n => n.endsWith(".json"))) {
    const path = join(dir, name), tx = JSON.parse(readFileSync(path, "utf8"));
    if (readUnoReceipt(root, tx.key)) { unlinkSync(path); continue; }
    // A crash before the receipt rolls back the complete batch; unexpected external edits block recovery.
    for (const row of tx.rows) {
      const target = unoPath(root, row.ref), current = existsSync(target) ? readFileSync(target).toString("base64") : null;
      if (current !== row.before && current !== row.after) throw new Error("恢复遇到外部修改，已停止以保全文件：" + row.ref);
    }
    for (const row of tx.rows.toReversed()) {
      const target = unoPath(root, row.ref);
      if (row.before === null) { if (existsSync(target)) unlinkSync(target); }
      else put(target, Buffer.from(row.before, "base64"));
    }
    unlinkSync(path);
  }
  invalidateKnowledgeSnapshot(root);
}
export function transaction(root, key, input, plan, { checkpoint = () => {} } = {}) {
  if (typeof key !== "string" || !key || key.length > 240) throw new Error("写入批次标识无效。");
  const digest = sha(JSON.stringify(input)), previous = readUnoReceipt(root, key);
  if (previous) {
    if (previous.input_hash !== digest) throw Object.assign(new Error("同一批次不能改写为其他内容。"), {code:'IDEMPOTENCY_CONFLICT'});
    return previous;
  }
  const lock = unoPath(root, ".nexogenesis/uno-write-lock");
  mkdirSync(dirname(lock), { recursive: true });
  if (existsSync(lock)) {
    const inspection = inspectUnoLock(root);
    if (inspection.status !== 'stale') throw Object.assign(new Error(inspection.status === 'busy' ? '知识写入正在进行。' : '知识写入锁需要检查，未执行新写入。'), { code: inspection.status === 'busy' ? 'WRITE_LOCK_BUSY' : 'WRITE_LOCK_RECOVERY_REQUIRED', details: inspection });
    const ownerFile = join(lock, "owner.json");
    unlinkSync(ownerFile); rmdirSync(lock);
  }
  try { mkdirSync(lock); } catch (error) { throw Object.assign(new Error('知识写入锁未取得。'), {code:'WRITE_LOCK_BUSY',cause:error}); }
  let committed = null;
  try {
    checkpoint('owner');
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, process_identity: processIdentity, process_started_at: new Date(Date.now()-process.uptime()*1000).toISOString(), transaction_id: sha(key), created_at: new Date().toISOString() }));
    recover(root);
    invalidateKnowledgeSnapshot(root);
    const { writes, result } = plan();
    const journal = "06-Journal/" + new Date().toISOString().slice(0, 10) + ".md";
    const journalPath = unoPath(root, journal);
    writes.set(journal, (existsSync(journalPath) ? readFileSync(journalPath, "utf8") : "") + "\n- " + new Date().toISOString() + " UNO " + result.summary + "；批次 " + key + "\n");
    const rows = [...writes].map(([ref, content]) => {
      const path = unoPath(root, ref);
      return { ref, before: existsSync(path) ? readFileSync(path).toString("base64") : null, after: content === null ? null : Buffer.from(content).toString("base64") };
    });
    const txPath = unoPath(root, ".nexogenesis/uno-transactions/" + sha(key) + ".json");
    put(txPath, JSON.stringify({ key, rows }));
    const receipt = { accepted: true, key, input_hash: digest, at: new Date().toISOString(), ...result };
    try {
      for (const row of rows) {
        const path = unoPath(root, row.ref);
        if (row.after === null) { if (existsSync(path)) unlinkSync(path); }
        else put(path, Buffer.from(row.after, "base64"));
      }
      put(unoPath(root, receiptRef(key)), JSON.stringify(receipt));
    } catch (error) {
      const saved=readUnoReceipt(root,key);
      if(saved?.input_hash===digest){committed=saved;saved.cleanup_pending=true;invalidateKnowledgeSnapshot(root);return saved;}
      recover(root);throw error;
    }
    committed = receipt;
    try { checkpoint('transaction_cleanup'); unlinkSync(txPath); }
    catch { receipt.cleanup_pending = true; }
    invalidateKnowledgeSnapshot(root);
    return receipt;
  } finally {
    try { checkpoint('lock_cleanup'); if (existsSync(join(lock, 'owner.json'))) unlinkSync(join(lock, "owner.json")); rmdirSync(lock); }
    catch (error) {
      if (committed) committed.cleanup_pending = true;
      else console.warn('UNO_WRITE_LOCK_CLEANUP_PENDING', error.code ?? 'CLEANUP_FAILED');
    }
  }
}
export function expect(root, revisions) {
  for (const [ref, value] of Object.entries(revisions)) if (unoRevision(root, ref) !== value) throw Object.assign(new Error("文件版本已变化，请读回当前对象后局部修订，无需重新生成整批：" + ref), {code:'REVISION_CONFLICT',details:{ref}});
}
export function readUnoUnit(root, ref) {
  if (!ref.startsWith("05-Buffer/themes/_sources/")&&!ref.startsWith('05-Buffer/_index/')) throw new Error("原文范围无效。");
  let unit = parseCardFile(unoPath(root, ref)),physical=ref;
  if(unit.meta.kind==='uno-material-index'){
    physical=unit.meta.target;if(typeof physical!=='string'||!physical.startsWith('05-Buffer/')||physical.startsWith('05-Buffer/_index/'))throw new Error('原文索引目标无效');
    const target=parseCardFile(unoPath(root,physical));if(target.meta.unit_id!==unit.meta.unit_id)throw new Error('原文索引与目标 ID 不一致');unit=target;
  }
  if (!["uno-raw-v1","uno-raw-v2",'uno-raw-v3'].includes(unit.meta.kind)) throw new Error("不是 UNO 原文单元。");
  return { ref, ...unit, physical_ref:physical, revision: unoRevision(root, physical) };
}
