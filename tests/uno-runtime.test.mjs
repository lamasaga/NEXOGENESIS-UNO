import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applicationIdentity } from "../packages/nexogenesis-web-host/lib/application.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const run = (file, args = [], env = {}) => execFileSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NEXO_PORT: "", ...env }, timeout: 20000,
});

test("UNO startup ignores shared runtime and matches the backend workspace identity", () => {
    const config = JSON.parse(run(join(root, "start-nexogenesis.ps1"), ["-CheckOnly"], { DSH_HOME: "C:/shared-old-runtime" }));
    assert.equal(config.Port, 3093);
    assert.equal(config.RuntimeHome, join(root, ".nexogenesis/runtime"));
    assert.equal(config.WorkspaceId, applicationIdentity(root).workspace_id);
    assert.notEqual(config.WorkspaceId, applicationIdentity(join(root, "other")).workspace_id);
    for (const port of ["3083", "3080", "0", "65536", "abc"]) {
        assert.throws(() => run(join(root, "start-nexogenesis.ps1"), ["-CheckOnly"], { NEXO_PORT: port }));
    }
});

test("fresh preparation changes only the copied application runtime and is repeatable", () => {
    const parent = mkdtempSync(join(tmpdir(), "uno-prepare-"));
    const app = join(parent, "empty app");
    const old = join(parent, "old-runtime");
    try {
        mkdirSync(old); writeFileSync(join(old, "sentinel"), "do not touch");
        for (const file of ["prepare-nexogenesis.ps1", "deploy/runtime.ps1", "deploy/runtime-profile.json", "presets/nexogenesis/agent.cordis.yml", "presets/nexogenesis/preset.yml", "presets/uno-compile/agent.cordis.yml", "presets/uno-compile/preset.yml", "patch/cordis.patch.yml"]) {
            mkdirSync(join(app, file, ".."), { recursive: true });
            copyFileSync(join(root, file), join(app, file));
        }
        assert.throws(() => run(join(app, "prepare-nexogenesis.ps1"), ["-ConfigureOnly"], { DSH_HOME: old }));
        assert.equal(existsSync(join(app, ".nexogenesis/runtime")), false);
        mkdirSync(join(app, "web/dist"), { recursive: true });
        mkdirSync(join(app, "packages/nexogenesis-tools"), { recursive: true });
        mkdirSync(join(app, "packages/nexogenesis-web-host"), { recursive: true });
        writeFileSync(join(app, "web/dist/index.html"), "test-only build");
        for (let attempt = 0; attempt < 2; attempt++) run(join(app, "prepare-nexogenesis.ps1"), ["-ConfigureOnly"], { DSH_HOME: old });
        const config = readFileSync(join(app, ".nexogenesis/runtime/profiles/nexogenesis/cordis.patch.yml"), "utf8");
        assert.ok(config.includes(app.replaceAll("\\", "/")));
        assert.equal(config.includes("__NEXO_PROJECT_ROOT__"), false);
        assert.equal(existsSync(join(old, "profiles")), false);
        assert.equal(readFileSync(join(old, "sentinel"), "utf8"), "do not touch");
        assert.ok(existsSync(join(app, "knowledge-bases/legacy/01-Cards")));
    } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("launcher never kills an occupied port and development proxy targets UNO", () => {
    const launcher = readFileSync(join(root, "start-nexogenesis.ps1"), "utf8");
    assert.doesNotMatch(launcher, /Stop-Process|taskkill/i);
    assert.match(launcher, /workspace_id/);
    assert.match(readFileSync(join(root, "web/vite.config.ts"), "utf8"), /127\.0\.0\.1:3093/);
});

test("explicit stop launcher verifies identity and atomically refuses active UNO work before termination",()=>{
    const stopper=readFileSync(join(root,'stop-nexogenesis.ps1'),'utf8');
    assert.match(stopper,/application\.workspace_id/);assert.match(stopper,/NEXOGENESIS-UNO/);
    assert.match(stopper,/@deepseek-ai/);assert.match(stopper,/--profile\\s\+nexogenesis/);assert.match(stopper,/--port/);
    assert.match(stopper,/\/api\/runtime\/prepare-stop/);assert.match(stopper,/x-nexogenesis-csrf/);
    assert.match(stopper,/StatusCode/);assert.match(stopper,/statusCode -ne 404/);
    assert.match(stopper,/\/api\/uno\/prepare/);assert.match(stopper,/status -eq 'running'/);
    assert.match(stopper,/stop-request\.json/);assert.match(stopper,/launcher_pid/);
    assert.ok(stopper.indexOf('/api/runtime/prepare-stop')<stopper.indexOf('Stop-Process'));
    assert.doesNotMatch(stopper,/ForceActiveWork|EmergencyStop/);
    assert.match(readFileSync(join(root,'stop-nexogenesis.cmd'),'utf8'),/pause/i);
    const starter=readFileSync(join(root,'start-nexogenesis.ps1'),'utf8');
    assert.match(starter,/stop-request\.json/);assert.match(starter,/requestedStop\.launcher_pid/);
});

test("Windows launcher preparation preserves Chinese UTF-8 registries and rejects actual corruption", () => {
    const parent = mkdtempSync(join(tmpdir(), "uno-registry-"));
    const app = join(parent, "测试 application");
    try {
        for (const file of ["prepare-nexogenesis.ps1", "deploy/runtime.ps1", "deploy/runtime-profile.json", "presets/nexogenesis/agent.cordis.yml", "presets/nexogenesis/preset.yml", "presets/uno-compile/agent.cordis.yml", "presets/uno-compile/preset.yml", "patch/cordis.patch.yml"]) {
            mkdirSync(join(app, file, ".."), { recursive: true });
            copyFileSync(join(root, file), join(app, file));
        }
        for (const dir of ["web/dist", "packages/nexogenesis-tools", "packages/nexogenesis-web-host", ".nexogenesis", "knowledge-bases/default/01-Cards"]) mkdirSync(join(app, dir), { recursive: true });
        writeFileSync(join(app, "web/dist/index.html"), "test-only build");
        const registryPath = join(app, ".nexogenesis/instances.json");
        const registry = JSON.stringify({ active_instance_id: "default", schema_version: 1, instances: [{ name: "默认知识库", id: "default", root: join(app, "knowledge-bases/default") }] }, null, 2);
        const sentinel = join(app, "knowledge-bases/default/01-Cards/keep.md");
        writeFileSync(sentinel, "测试知识保持原样");
        for (const prefix of ["", "\ufeff"]) {
            writeFileSync(registryPath, prefix + registry, "utf8");
            run(join(app, "prepare-nexogenesis.ps1"), ["-ConfigureOnly"]);
            assert.equal(readFileSync(registryPath, "utf8"), prefix + registry);
            assert.equal(readFileSync(sentinel, "utf8"), "测试知识保持原样");
            assert.equal(existsSync(join(app, "knowledge-bases/legacy")), false);
        }
        writeFileSync(registryPath, '{"instances": [', "utf8");
        assert.throws(() => run(join(app, "prepare-nexogenesis.ps1"), ["-ConfigureOnly"]));
        assert.equal(readFileSync(registryPath, "utf8"), '{"instances": [');
        assert.equal(existsSync(join(app, "knowledge-bases/legacy")), false);
    } finally { rmSync(parent, { recursive: true, force: true }); }
});
