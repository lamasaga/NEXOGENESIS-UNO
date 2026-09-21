// 核心仓边界：实例知识与运行产物不能被 Git 跟踪。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const tracked = execFileSync("git", ["ls-files", "-z"], {
	cwd: root, encoding: "utf8"
}).split("\0").filter(Boolean).map((path) => path.replaceAll("\\", "/"));

const forbidden = [
	/^00-Inbox(?:\/|$)/,
	/^01-Cards(?:\/|$)/,
	/^02-Profile(?:\/|$)/,
	/^03-Archive(?:\/|$)/,
	/^04-OutBox(?:\/|$)/,
	/^05-Buffer(?:\/|$)/,
	/^06-Journal(?:\/|$)/,
	/^07-Conversations(?:\/|$)/,
	/^knowledge-bases(?:\/|$)/,
	/^\.nexogenesis(?:\/|$)/,
	/^tmp(?:\/|$)/,
	/^instances(?:\/|$)/,
	/^artifacts(?:\/|$)/,
	/^output(?:\/|$)/,
	/^test-results(?:\/|$)/,
	/^coverage(?:\/|$)/,
	/(?:^|\/)node_modules(?:\/|$)/,
	/^web\/dist(?:\/|$)/,
	/(?:^|\/)\.env(?:\.|$)/,
	/\.log$/i
];

const violations = tracked.filter((path) => forbidden.some((pattern) => pattern.test(path)));
assert.deepEqual(violations, [], `核心仓混入实例或运行文件：\n${violations.join("\n")}`);

const ignore = readFileSync(new URL(".gitignore", root), "utf8");
for (const path of [
	"/00-Inbox/", "/01-Cards/", "/02-Profile/", "/03-Archive/", "/04-OutBox/",
	"/05-Buffer/", "/06-Journal/", "/07-Conversations/", "/knowledge-bases/",
	"/.nexogenesis/", "/tmp/", "/instances/", "/artifacts/", "/output/",
	"/test-results/", "/coverage/"
]) assert.match(ignore, new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), `.gitignore 缺少 ${path}`);

const attributes = readFileSync(new URL(".gitattributes", root), "utf8");
for (const asset of ["金融经济与国际贸易测试资料集", "真实回归案例"]) {
	assert.match(attributes, new RegExp(`${asset}.+export-ignore`), `${asset} 必须排除出干净发布归档`);
}

console.log("PASS repository keeps runtime knowledge separate from distributable core");
