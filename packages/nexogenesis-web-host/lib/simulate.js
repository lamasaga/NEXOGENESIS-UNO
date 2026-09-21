/**
 * /api/simulate and /api/replay compatibility handlers.
 *
 * The frontend uses these only in URL-driven demo/walkthrough modes
 * (?autoplay=<scenario>&replay=1). These read-only scripts exercise the same
 * neural-flow event contract as live work without starting a model or writing knowledge.
 */
import { json } from "./rpc.js";

/** POST /api/simulate/:scenario → 204 (demo trigger; animation comes via events). */
export async function handleSimulate(ctx, _req, res, _trustedHosts) {
	res.writeHead(204);
	res.end();
}

const flow = (t, kind, title, detail, duration = 7) => ({ t, type: "neural.flow", payload: { kind, title, detail, duration } });
const stop = t => ({ t, type: "neural.stop", payload: {} });
const REPLAYS = {
	"neural-dialogue": [
		flow(0, "inquiry", "知识网络正在回应", "问题正在唤起图谱中的相关知识活动"),
		flow(8, "convergence", "回答正在形成", "分散的知识信号正在向当前问题汇聚", 6),
		stop(15),
	],
	"neural-compile": [
		flow(0, "encoding", "材料正在编码", "原始材料正被组织为可复用的知识单元", 9),
		flow(10, "convergence", "知识单元正在复核", "候选卡片正在聚合为可发布结构", 6),
		flow(17, "commit", "知识单元正在写入", "通过审核的知识正在进入图谱", 5),
		stop(23),
	],
	"neural-construct": [
		flow(0, "rewiring", "知识网络正在重组", "现有知识正在比较、改写并建立新的连接", 10),
		flow(11, "convergence", "建构结果正在收束", "候选结构正在独立复核与校验", 6),
		flow(18, "commit", "新结构正在形成", "确认后的卡片与关系正在进入图谱", 5),
		stop(24),
	],
};

/** GET /api/replay/:scenario → { events } */
export async function handleReplay(_ctx, req, res, _trustedHosts) {
	const path = new URL(req.url ?? "/", "http://local").pathname;
	const scenario = decodeURIComponent(path.slice("/api/replay/".length));
	json(res, 200, { events: REPLAYS[scenario] ?? [] });
}
