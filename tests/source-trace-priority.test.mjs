import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitCard, traceCardSources } from "../packages/nexogenesis-tools/lib/cards.js";

const root = mkdtempSync(join(tmpdir(), "nexo-source-priority-"));
try {
	mkdirSync(join(root, "05-Buffer", "themes", "test", "sources"), { recursive: true });
	writeFileSync(join(root, "05-Buffer", "themes", "test", "sources", "legacy.md"), `---\nkind: chapter-source\n---\n# 旧来源\n\n旧来源正文。\n`);
	writeFileSync(join(root, "05-Buffer", "themes", "test", "sources", "v2.md"), `---\nkind: chapter-source\nsource_quality_contract: theme-source-v2\n---\n# 新来源\n\n新来源正文。\n`);
	commitCard(root, {
		id: "来源优先级测试", title: "来源优先级测试", type: "claim", maturity: "growing", lifecycle: "active",
		domains: [], origin: "user", relations: [],
		sources: ["05-Buffer/themes/test/sources/legacy.md", "05-Buffer/themes/test/sources/v2.md"],
		created: "2026-08-31", updated: "2026-08-31", body: "用于确认新版主题来源优先进入受限追溯窗口。"
	});
	const traced = traceCardSources(root, "来源优先级测试", { limit: 1 });
	assert.equal(traced.anchors[0].source, "05-Buffer/themes/test/sources/v2.md");
	assert.match(traced.anchors[0].preview, /新来源正文/u);
	console.log("PASS theme-source-v2 is traced before legacy sources");
} finally {
	rmSync(root, { recursive: true, force: true });
}
