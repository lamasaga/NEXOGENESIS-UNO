import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleInboxList } from "../packages/nexogenesis-web-host/lib/inbox.js";

const root = mkdtempSync(join(tmpdir(), "nexogenesis-inbox-selection-"));
try {
	mkdirSync(join(root, "00-Inbox", "books"), { recursive: true });
	writeFileSync(join(root, "00-Inbox", "notes.md"), "# 说明", "utf8");
	writeFileSync(join(root, "00-Inbox", "books", "研究.epub"), Buffer.from("PK\u0003\u0004"), "utf8");

	let body = "";
	await handleInboxList(null, null, {
		writeHead(status) { assert.equal(status, 200); },
		end(value) { body = value; }
	}, [], root);
	const listed = JSON.parse(body).documents;
	assert.deepEqual(new Set(listed.map((item) => item.path)), new Set(["notes.md", "books/研究.epub"]));
	assert.equal(listed.find((item) => item.path.endsWith(".epub")).doc_type, "epub");


	console.log("PASS Inbox selection lists actual source materials for the current book entry");
} finally {
	rmSync(root, { recursive: true, force: true });
}
