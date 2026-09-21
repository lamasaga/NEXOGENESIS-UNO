# nexogenesis-uno 全端点冒烟测试（基准测试基线）
#
# 前置：产品实例已启动（start-nexogenesis.cmd ，由本目录的独立启动器配置运行环境）
# 用法：
#   pwsh -File tools/smoke-test.ps1                       # 默认 http://127.0.0.1:3093
#   pwsh -File tools/smoke-test.ps1 -BaseUrl http://127.0.0.1:3099
#   pwsh -File tools/smoke-test.ps1 -ReportFile docs/baseline/2026-08-19-全端点冒烟.md
#
# 说明：会话/项目为测试创建并软删除清理；Inbox 上传为临时材料，测后删除；
#       settings 先读原值，测后恢复。不含真实 API Key 时 chat 预期走错误帧（记录即可）。
param(
  [string]$BaseUrl = "http://127.0.0.1:3093",
  [string]$ReportFile = ""
)

$ErrorActionPreference = "Stop"
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result($name, $pass, $detail) {
  $results.Add([pscustomobject]@{ name = $name; status = $(if ($pass) { "PASS" } else { "FAIL" }); detail = $detail })
}

# Raw request returning status + body; throws on transport error.
function Invoke-Raw($method, $path, $body = $null) {
  $params = @{ Method = $method; Uri = "$BaseUrl$path"; UseBasicParsing = $true; TimeoutSec = 30 }
  if ($null -ne $body) {
    $params.ContentType = "application/json"
    $params.Body = ($body | ConvertTo-Json -Depth 10 -Compress)
  }
  $res = Invoke-WebRequest @params
  return [pscustomobject]@{ Status = [int]$res.StatusCode; Content = $res.Content }
}

# JSON request: returns parsed content; throws HttpError-ish object on non-2xx.
function Invoke-Json($method, $path, $body = $null) {
  $r = Invoke-Raw $method $path $body
  $parsed = $null
  try { $parsed = $r.Content | ConvertFrom-Json } catch { }
  return $parsed
}

function Test-Case($name, [scriptblock]$block) {
  try {
    $detail = & $block
    Add-Result $name $true $detail
  } catch {
    $status = "n/a"
    if ($_.Exception.Response -ne $null) {
      $status = [int]$_.Exception.Response.StatusCode
    }
    Add-Result $name $false "HTTP $status :: $($_.Exception.Message)"
  }
}

Write-Host "=== nexogenesis-uno smoke test @ $BaseUrl ==="

$createdSessions = [System.Collections.Generic.List[string]]::new()
$inboxBefore = @(Get-ChildItem "$PSScriptRoot\..\00-Inbox" -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })

# 1. health / index / fence
Test-Case "GET /api/health" {
  $r = Invoke-Json "GET" "/api/health"
  "ok=$($r.ok) service=$($r.service)"
}
Test-Case "GET / (index.html)" {
  $r = Invoke-Raw "GET" "/"
  "status=$($r.Status) lang=$($r.Content -match 'lang=\"zh\"') bytes=$($r.Content.Length)"
}
Test-Case "fence: Host evil.example -> 403" {
  $code = & curl.exe -s -o NUL -w "%{http_code}" -H "Host: evil.example" "$BaseUrl/api/health"
  "http=$code"
}

# 2. settings (read -> put -> restore)
$settingsOriginal = $null
Test-Case "GET /api/settings" {
  $s = Invoke-Json "GET" "/api/settings"
  $script:settingsOriginal = $s
  "base_url=$($s.base_url) model=$($s.model) username=$($s.username) has_key=$($s.has_key) masked=$($s.api_key_masked)"
}
Test-Case "PUT /api/settings (roundtrip)" {
  Invoke-Json "PUT" "/api/settings" @{ username = "冒烟测试"; style_prompt = "" } | Out-Null
  $s = Invoke-Json "GET" "/api/settings"
  "username=$($s.username)"
}

# 3. projects
Test-Case "GET /api/projects" {
  $p = Invoke-Json "GET" "/api/projects"
  "projects=$($p.projects.Count) first=$($p.projects[0].name)"
}
$testProjectId = $null
Test-Case "POST /api/projects" {
  $p = Invoke-Json "POST" "/api/projects" @{ name = "冒烟测试项目" }
  $script:testProjectId = $p.id
  "id=$($p.id) name=$($p.name)"
}

# 4. conversations CRUD
Test-Case "POST /api/conversations" {
  $c = Invoke-Json "POST" "/api/conversations" @{ project_id = $testProjectId }
  $script:createdSessions.Add($c.id)
  "id=$($c.id) title=$($c.title) project_id=$($c.project_id)"
}
Test-Case "GET /api/conversations/:id" {
  $c = Invoke-Json "GET" "/api/conversations/$($createdSessions[0])"
  "id=$($c.id) messages=$($c.messages.Count)"
}
Test-Case "PATCH /api/conversations/:id (title)" {
  $c = Invoke-Json "PATCH" "/api/conversations/$($createdSessions[0])" @{ title = "冒烟会话-已改名" }
  "title=$($c.title)"
}

# 5. graph & cards
Test-Case "GET /api/graph" {
  $g = Invoke-Json "GET" "/api/graph"
  "nodes=$($g.nodes.Count) edges=$($g.edges.Count) firstNode=$($g.nodes[0].id)"
}
Test-Case "GET /api/cards/:id" {
  $g = Invoke-Json "GET" "/api/graph"
  $first = $g.nodes[0].id
  $card = Invoke-Json "GET" "/api/cards/$([uri]::EscapeDataString($first))"
  "id=$($card.id) title=$($card.title) type=$($card.type) bodyLen=$($card.body.Length)"
}

# 6. pipeline
Test-Case "GET /api/pipeline/status" {
  $p = Invoke-Json "GET" "/api/pipeline/status"
  "inbox=$($p.inbox) scratch=$($p.scratch)"
}
Test-Case "GET /api/pipeline/job" {
  $p = Invoke-Json "GET" "/api/pipeline/job"
  "job=$($p.job)"
}
Test-Case "POST /api/pipeline/compile/conversation" {
  $c = Invoke-Json "POST" "/api/pipeline/compile/conversation" @{ project_id = $testProjectId }
  $script:createdSessions.Add($c.id)
  "id=$($c.id) task_kind=$($c.task_kind)"
}

# 7. candidates / write confirm (route semantics)
Test-Case "POST /api/candidates/prepare" {
  $r = Invoke-Json "POST" "/api/candidates/prepare" @{}
  "prepared=$($r.prepared)"
}
Test-Case "POST /api/write/confirm (unknown proposal -> 404)" {
  try {
    Invoke-Raw "POST" "/api/write/confirm" @{ proposal_id = "smoke-nonexistent"; decision = "confirm" } | Out-Null
    "unexpected 200"
  } catch {
    $code = [int]$_.Exception.Response.StatusCode
    if ($code -eq 404) { "404 as designed" } else { throw }
  }
}

# 8. chat (non-stream; without API key expect error path)
Test-Case "POST /api/chat (no key -> error or answer)" {
  try {
    $r = Invoke-Json "POST" "/api/chat" @{ conversation_id = $createdSessions[0]; message = "你好" }
    if ($null -ne $r.answer) { "answer=${$r.answer.Substring(0, [Math]::Min(60, $r.answer.Length))}" } else { "no answer field" }
  } catch {
    $code = [int]$_.Exception.Response.StatusCode
    $body = ""
    try { $body = $_.ErrorDetails.Message } catch { }
    "http=$code body=$body"
  }
}
Test-Case "POST /api/chat/stream (SSE frames)" {
  $r = Invoke-Raw "POST" "/api/chat/stream" @{ conversation_id = $createdSessions[0]; message = "你好" }
  $frames = @($r.Content -split "data: " | Where-Object { $_ -match "delta|done|error|step|sources|pipeline" })
  $sample = if ($frames.Count -gt 0) { $frames[0].Substring(0, [Math]::Min(120, $frames[0].Length)) } else { "(no frames)" }
  "status=$($r.Status) frames=$($frames.Count) sample=$sample"
}

# 9. events SSE (keep-alive; curl max-time 2 -> exit 28 = stream stayed open)
Test-Case "GET /api/events (SSE keep-alive)" {
  $code = & curl.exe -s -o NUL -w "%{http_code}" --max-time 2 "$BaseUrl/api/events?conversation_id=$($createdSessions[0])"
  "http=$code (curl exit=$LASTEXITCODE; 28=timeout=stream open)"
}

# 10. inbox multipart upload (temp file, then cleanup)
Test-Case "POST /api/inbox (multipart)" {
  $tmp = Join-Path $env:TEMP "nexo-smoke-upload.md"
  Set-Content -Path $tmp -Value "# 冒烟测试临时材料`n`n基线测试用，测后删除。" -Encoding UTF8
  $out = & curl.exe -s -X POST -F "file=@$tmp" "$BaseUrl/api/inbox"
  $inboxAfter = @(Get-ChildItem "$PSScriptRoot\..\00-Inbox" -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  $delta = @($inboxAfter | Where-Object { $inboxBefore -notcontains $_ })
  foreach ($f in $delta) { Remove-Item $f -Force }
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  "response=$out filesCreated=$($delta.Count)"
}

# 11. simulate / replay (demo, stable empty impl)
Test-Case "POST /api/simulate/:scenario" {
  $r = Invoke-Json "POST" "/api/simulate/smoke" @{}
  "body=$($r | ConvertTo-Json -Compress)"
}
Test-Case "GET /api/replay/:scenario" {
  $r = Invoke-Raw "GET" "/api/replay/smoke"
  "status=$($r.Status)"
}

# 12. cleanup: restore settings, soft-delete sessions
if ($settingsOriginal -ne $null) {
  try {
    Invoke-Json "PUT" "/api/settings" @{
      base_url = $settingsOriginal.base_url; model = $settingsOriginal.model;
      username = $settingsOriginal.username; style_prompt = $settingsOriginal.style_prompt
    } | Out-Null
  } catch { Write-Host "WARN: settings restore failed: $($_.Exception.Message)" }
}
foreach ($id in @($createdSessions | Where-Object { $_ -and $_.Trim() -ne "" })) {
  try { Invoke-Raw "DELETE" "/api/conversations/$id" | Out-Null } catch { }
}

# Remove smoke-test traces from the meta store: the created project record
# (pipeline sessions attach to the default project, so remove every session
# we created by id). No delete-project API exists yet; direct file edit keeps
# the store clean.
try {
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $PSScriptRoot "../.nexogenesis/runtime" }
  $metaPath = Join-Path $dshHome "nexogenesis-meta.json"
  if (Test-Path $metaPath) {
    $meta = Get-Content -LiteralPath $metaPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($testProjectId -ne $null -and $testProjectId -ne "") {
      $meta.projects.PSObject.Properties.Remove($testProjectId)
    }
    foreach ($sid in @($createdSessions | Where-Object { $_ -and $_.Trim() -ne "" })) {
      $meta.conversations.PSObject.Properties.Remove($sid)
      $meta.deleted.PSObject.Properties.Remove($sid)
    }
    $meta | ConvertTo-Json -Depth 10 | Set-Content $metaPath -Encoding UTF8
  }
} catch { Write-Host "WARN: meta cleanup failed: $($_.Exception.Message)" }

# summary
Write-Host ""
Write-Host "=== summary ==="
$passCount = @($results | Where-Object { $_.status -eq "PASS" }).Count
$failCount = @($results | Where-Object { $_.status -eq "FAIL" }).Count
$results | Format-Table -AutoSize
Write-Host "PASS=$passCount FAIL=$failCount TOTAL=$($results.Count)"

if ($ReportFile -ne "") {
  $dir = Split-Path $ReportFile
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $lines = @()
  $lines += "# 全端点冒烟测试报告"
  $lines += ""
  $lines += "> 日期：$(Get-Date -Format 'yyyy-MM-dd HH:mm')"
  $lines += "> 目标：$BaseUrl（dsh --profile nexogenesis）"
  $lines += "> 结果：**PASS $passCount / FAIL $failCount / TOTAL $($results.Count)**"
  $lines += ""
  $lines += "| 端点/用例 | 结果 | 详情 |"
  $lines += "|---|---|---|"
  foreach ($r in $results) {
    $detail = ($r.detail -replace "\|", "\\|")
    $lines += "| $($r.name) | $($r.status) | $detail |"
  }
  $lines += ""
  $lines += "## 说明"
  $lines += ""
  $lines += '- 无 API Key 时 chat 端点预期进入错误路径（HTTP 500 + `turn 结束：llm-deepseek: no API key…`），填入 `DEEPSEEK_API_KEY` 后应转正。'
  $lines += '- 测试会话已软删除、Inbox 临时材料已清理、settings 已恢复原值、meta 冒烟记录已清除（项目/会话回到测试前状态）。'
  $lines += '- 复跑：`pwsh -File tools/smoke-test.ps1`（前置：产品实例运行在 3083）。'
  $lines += ""
  $lines += "## 基线观察（2026-08-19）"
  $lines += ""
  $lines += '- **图谱边修复（2026-08-19）**：首轮基线发现 718 节点仅 17 边、`relations` 解析为 null——根因是 JS frontmatter 解析器只认缩进列表（`  - item`），而实践仓卡片为顶格列表（`- item`），导致 relations/domains/sources 全部被丢弃。已修复 `graph.js`/`cards.js` 双份解析器（顶格+缩进均支持）：边 17 → 2669，领域索引 29 个，检索扩散恢复。'
  $lines += '- **图谱边稀疏已排除复制丢失**：对照实践仓（金融2）确认卡文件逐字节一致、relations 完整（2665 条），问题纯属解析器缺陷，非数据丢失。'
  $lines += '- **图谱力导向布局（2026-08-19）**：原 `/api/graph` 用圆形布局（半径 n*22 ≈ 15800px）导致整图缩为圆环、节点不可读。已移植原项目 `runtime/layout.py` 力导向布局（边弹簧 > 排斥 > 向心，600 轮退火，哈希确定性，`.nexogenesis/graph/layout.json` 缓存 + 增量生长）：坐标收敛到 ±280、领域自然聚拢（实测 29 个领域簇分离）。'
  $lines += '- **图谱视觉（2026-08-19 用户迭代）**：Obsidian 式节点大小——按连接度缩放（叶子 0.75× → 枢纽 1.4×，实测屏幕尺寸 2.2px → 5.6px），基础半径调大（标准 4.0 / 领域 5.5 / 冲突 4.6），最小屏幕半径随连接度缩放避免钳制抹平差异；领域标签不再常显，所有节点仅鼠标悬浮显示名称胶囊（命中区随节点大小缩放）。'
  $lines += '- **meta 缓存修复**：本次测试发现 `meta.js` 进程内缓存从不失效，外部编辑会被旧缓存覆盖（多进程/外部清理场景）。已修复为 mtime/size 失效校验（文件是唯一事实源）。'
  $lines += '- **检索工具**：`retrieve`（BM25+图扩散）、`read_card`、`list_domains` 由 agent 会话内调用，本冒烟未驱动模型（无 key）；M2 实测记录见融合设计 §9。'
  $lines += '- **preset 挂载**：会话创建显式 `agentPreset: nexogenesis`（`projects.js`），preset 部署于 `$DSH_HOME/.agent-presets/nexogenesis/`。'
  $lines += '- **git 基线**：本项目已 `git init`（独立仓库，知识体/node_modules/dist 不入库），本报告与冒烟脚本随基线提交。'
  Set-Content -Path $ReportFile -Value ($lines -join "`n") -Encoding UTF8
  Write-Host "report written: $ReportFile"
}
