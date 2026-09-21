// Synthetic compatibility fixtures; never reads or copies an installed knowledge base.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeCard } from "../../packages/nexogenesis-tools/lib/cards.js";

export function isolatedGraphFixture() {
    const root = mkdtempSync(join(tmpdir(), "uno-synthetic-graph-"));
    mkdirSync(join(root, "01-Cards"));
    const records = [
        { id: "测试组织领域", type: "domain", relations: [] },
        { id: "测试周期观察", type: "phenomenon", relations: [{ target: "测试反馈机制", type: "example-of", note: "合成观察用于测试机制举例和关系去重。" }] },
        { id: "测试反馈机制", type: "model", relations: [{ target: "测试信用边界", type: "supports", note: "只有信用受限时，该合成机制支持测试边界。" }] },
        { id: "测试信用边界", type: "claim", relations: [] },
    ];
    for (const record of records) {
        writeFileSync(join(root, "01-Cards", record.id + ".md"), serializeCard({
            title: record.id, maturity: "growing", lifecycle: "active", origin: "user",
            created: "2026-09-08", updated: "2026-09-08", sources: [],
            domains: record.type === "domain" ? [] : ["测试组织领域"],
            body: "## 诠释\n\n这是人工构造的银行危机和最后贷款人测试材料，不代表现实知识。\n\n## 模式描述\n\n该合成对象用于验证字段保留、遍历和局部修订。\n",
            ...record,
        }), "utf8");
    }
    process.once("exit", () => rmSync(root, { recursive: true, force: true }));
    return root;
}
