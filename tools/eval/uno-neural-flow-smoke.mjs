import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const baseUrl = process.env.UNO_QA_URL ?? "http://127.0.0.1:4174";
const useLiveReplay = process.env.UNO_QA_LIVE_REPLAY === "1";
const outputDir = process.env.UNO_QA_OUTPUT ?? process.cwd();
const executablePath = process.env.UNO_QA_BROWSER ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const scripts = {
  "neural-dialogue": [
    { t: 0, type: "neural.flow", payload: { kind: "inquiry", duration: 8, title: "知识网络正在回应" } },
    { t: 8, type: "neural.flow", payload: { kind: "convergence", duration: 6, title: "回答正在形成" } },
  ],
  "neural-compile": [
    { t: 0, type: "neural.flow", payload: { kind: "encoding", duration: 9, title: "材料正在编码" } },
  ],
  "neural-construct": [
    { t: 0, type: "neural.flow", payload: { kind: "rewiring", duration: 10, title: "知识网络正在重组" } },
  ],
};

const browser = await chromium.launch({ headless: true, executablePath });
const results = [];
try {
  for (const [scenario, events] of Object.entries(scripts)) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 1 });
    const consoleErrors = [];
    page.on("console", message => { if (["error", "warning"].includes(message.type())) consoleErrors.push(`${message.type()}: ${message.text()}`); });
    page.on("pageerror", error => consoleErrors.push(`pageerror: ${error.message}`));
    if (!useLiveReplay) await page.route(`**/api/replay/${scenario}`, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events }) }));
    await page.goto(`${baseUrl}/?autoplay=${scenario}&replay=1&nosse=1`, { waitUntil: "domcontentloaded" });
    await page.locator("canvas").first().waitFor({ state: "attached", timeout: 15000 });
    await page.waitForTimeout(2600);
    const canvasCount = await page.locator("canvas").count();
    const graphVisible = await page.locator(".graph-stage").isVisible();
    await page.getByRole("button", { name: "展开图谱调节" }).click();
    const controlCount = await page.locator('.graph-controls input[type="range"]').count();
    const screenshot = resolve(outputDir, `uno-${scenario}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    results.push({ scenario, title: await page.title(), graphVisible, canvasCount, controlCount, consoleErrors, screenshot });
    await page.close();
  }

  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const mobileErrors = [];
  page.on("console", message => { if (["error", "warning"].includes(message.type())) mobileErrors.push(`${message.type()}: ${message.text()}`); });
  if (!useLiveReplay) await page.route("**/api/replay/neural-dialogue", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: scripts["neural-dialogue"] }) }));
  await page.goto(`${baseUrl}/?autoplay=neural-dialogue&replay=1&nosse=1`, { waitUntil: "domcontentloaded" });
  await page.locator("canvas").first().waitFor({ state: "attached", timeout: 15000 });
  await page.waitForTimeout(2600);
  await page.getByRole("button", { name: "打开会话列表" }).click();
  const navigationVisible = await page.locator(".sidebar-surface").isVisible();
  const screenshot = resolve(outputDir, "uno-neural-mobile.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  results.push({ scenario: "mobile", title: await page.title(), graphVisible: await page.locator(".graph-stage").isVisible(), canvasCount: await page.locator("canvas").count(), navigationVisible, consoleErrors: mobileErrors, screenshot });
  await page.close();

  const reduced = await browser.newPage({ viewport: { width: 1200, height: 800 }, reducedMotion: "reduce" });
  const reducedErrors = [];
  reduced.on("console", message => { if (["error", "warning"].includes(message.type())) reducedErrors.push(`${message.type()}: ${message.text()}`); });
  if (!useLiveReplay) await reduced.route("**/api/replay/neural-dialogue", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: scripts["neural-dialogue"] }) }));
  await reduced.goto(`${baseUrl}/?autoplay=neural-dialogue&replay=1&nosse=1`, { waitUntil: "domcontentloaded" });
  await reduced.locator("canvas").first().waitFor({ state: "attached", timeout: 15000 });
  await reduced.waitForTimeout(2300);
  results.push({ scenario: "reduced-motion", title: await reduced.title(), graphVisible: await reduced.locator(".graph-stage").isVisible(), canvasCount: await reduced.locator("canvas").count(), consoleErrors: reducedErrors });
  await reduced.close();
} finally {
  await browser.close();
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
if (results.some(result => result.title !== "NEXOGENESIS UNO" || result.canvasCount < 3 || result.consoleErrors.length
  || (result.scenario === "mobile" ? !result.navigationVisible
    : result.scenario === "reduced-motion" ? !result.graphVisible
    : !result.graphVisible || result.controlCount !== 4))) process.exitCode = 1;
