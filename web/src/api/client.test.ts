import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetGraphOverviewCacheForTests, __resetLocalRequestTokenForTests, cancelChat, confirmWrite, createConversation, createUnoDomainFromCard, deleteConversation, deleteConversations, deleteUnoUnassignedCard, fetchCardCatalog, fetchCognitiveSession, fetchGraphOverview, fetchInboxDocuments, fetchProjects, fetchUnoUnassignedPool, invalidateGraphOverviewCache, organizeUnoUnassignedCard, readCachedGraphOverview, recompileUnoUnassignedCard, resetPipelineConversation, reviewUnoDomains, savePipelineAuthority, saveSettings, testModelConnection, sendChat, sendChatStream, stopPipelineJob, uploadInbox, startUnoJob, updateUnoJob, type UnoJob } from "./client";
import { prepareStart, pendingStart } from '../conversations/recovery';

function mockFetch(impl: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/security/session") return {
      ok: true, status: 200, json: async () => ({ token: "test-local-token" }),
    } as Response;
    const out = impl(url, init) as { ok: boolean; status?: number; body: unknown };
    return {
      ok: out.ok,
      status: out.status ?? (out.ok ? 200 : 500),
      json: async () => out.body,
    } as Response;
  }));
}

afterEach(() => {
  __resetLocalRequestTokenForTests();
  __resetGraphOverviewCacheForTests();
  vi.unstubAllGlobals();
});

describe("client", () => {
  it('does not replay or upgrade an unconfirmed legacy compile request', async()=>{
    const values=new Map<string,string>();vi.stubGlobal('sessionStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
    const input={mode:'compile' as const,sources:['00-Inbox/book.md'],notes:'保留原要求',library_id:'legacy-library'},saved=prepareStart(input);
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await expect(startUnoJob(pendingStart('legacy-library')!.input)).rejects.toThrow('历史编译');
    expect(fetcher).not.toHaveBeenCalled();expect(pendingStart('legacy-library')!.id).toBe(saved.id);
  });
  it.each(['resume','retry','review','stop-after-batch'] as const)('blocks %s for a legacy compile job without any request',async(action)=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await expect(updateUnoJob({id:'old-compile',version:9,mode:'compile',workflow:'uno-compile-v3'} as UnoJob,action,[],[],30)).rejects.toThrow('历史编译仅供查看');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('resumes a new book task with its original id and version',async()=>{
    mockFetch((url,init)=>{
      expect(url).toBe('/api/uno/jobs/new-book/resume');
      expect(JSON.parse(String(init?.body))).toEqual({version:9,decision:'save',allow_titles:[],skip_titles:[],budget_calls:30});
      return {ok:true,body:{id:'new-book',version:10}};
    });
    await updateUnoJob({id:'new-book',version:9,mode:'compile',workflow:'uno-unit-compile-v2'} as UnoJob,'resume',[],[],30);
  });
  it('submits an explicit decision for every domain proposal',async()=>{
    mockFetch((url,init)=>{
      expect(url).toBe('/api/uno/jobs/new-book/domain-review');
      expect(JSON.parse(String(init?.body))).toEqual({version:12,approve_ids:['proposal-a'],defer_ids:['proposal-b']});
      return {ok:true,body:{id:'new-book',version:13}};
    });
    await reviewUnoDomains({id:'new-book',version:12,mode:'compile'} as UnoJob,['proposal-a'],['proposal-b']);
  });
  it('loads, organizes, recompiles and deletes cards through the unassigned-pool API',async()=>{
    const seen:string[]=[];mockFetch((url,init)=>{seen.push(url);
      if(url==='/api/uno/unassigned')return {ok:true,body:{library:{id:'library-1',name:'测试库'},items:[{id:'tracked',created_at:'2026-09-18T00:00:00Z',last_evaluated_at:null},{id:'legacy-empty-domain',created_at:null,last_evaluated_at:null}]}};
      if(url==='/api/uno/unassigned/card-a/organize'){expect(init?.method).toBe('POST');expect(JSON.parse(String(init?.body))).toEqual({library_id:'library-1',request_id:'00000000-0000-4000-8000-000000000000',budget_calls:4});return {ok:true,body:{id:'job-0'}};}
      if(url==='/api/uno/unassigned/card-a/recompile'){expect(init?.method).toBe('POST');expect(JSON.parse(String(init?.body))).toEqual({library_id:'library-1',request_id:'00000000-0000-4000-8000-000000000001',budget_calls:6});return {ok:true,body:{id:'job-1'}};}
      expect(url).toBe('/api/uno/unassigned/card-a');expect(init?.method).toBe('DELETE');expect(JSON.parse(String(init?.body))).toEqual({library_id:'library-1',confirm_id:'card-a',expected_revision:'a'.repeat(64),reason:'内容无保留价值'});return {ok:true,body:{accepted:true,card_id:'card-a'}};
    });
    expect((await fetchUnoUnassignedPool()).items.map(item=>item.id)).toEqual(['tracked']);await organizeUnoUnassignedCard('card-a','library-1','00000000-0000-4000-8000-000000000000');await recompileUnoUnassignedCard('card-a','library-1','00000000-0000-4000-8000-000000000001');
    await deleteUnoUnassignedCard({id:'card-a',revision:'a'.repeat(64)},'library-1','内容无保留价值');
    expect(seen).toEqual(['/api/uno/unassigned','/api/uno/unassigned/card-a/organize','/api/uno/unassigned/card-a/recompile','/api/uno/unassigned/card-a']);
  });
  it('creates a domain from one unassigned seed card with an explicit definition',async()=>{
    const domain={title:'土地制度与王朝治理',summary:'研究土地制度如何塑造财政、社会结构与王朝治理。',core_questions:['土地收益如何影响国家治理？'],includes:['土地制度与财政分配'],excludes:['单一王朝事件名录']};
    mockFetch((url,init)=>{
      expect(url).toBe('/api/uno/unassigned/card-a/create-domain');expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({library_id:'library-1',expected_revision:'a'.repeat(64),request_id:'00000000-0000-4000-8000-000000000002',domain});
      return {ok:true,body:{accepted:true,summary:'领域治理：新建 1 个领域，挂靠 1 张卡片',card_ids:['card-a'],domain_ids:['domain-a'],publication:{cards:['card-a'],domains:['domain-a']}}};
    });
    const receipt=await createUnoDomainFromCard({id:'card-a',revision:'a'.repeat(64)},'library-1',domain,'00000000-0000-4000-8000-000000000002');
    expect(receipt.domain_ids).toEqual(['domain-a']);
  });
  it("connection test sends the current draft with CSRF and cancellation without saving", async () => {
    const controller=new AbortController();
    const connection={provider:"custom" as const,base_url:"https://example.org/v1",model:"",thinking_mode:"auto" as const,reasoning_effort:"auto",model_type:"auto" as const,thinking_protocol:"none" as const};
    let calls=0;
    mockFetch((url,init)=>{
      calls++;
      expect(url).toBe("/api/settings/test");expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("X-Nexogenesis-CSRF")).toBe("test-local-token");
      expect(init?.signal).toBe(controller.signal);
      expect(JSON.parse(String(init?.body))).toEqual({...connection,api_key:"draft-only"});
      return {ok:true,body:{models:["private-model"],model_listed:false}};
    });
    expect((await testModelConnection(connection,"draft-only",controller.signal)).models).toEqual(["private-model"]);
    expect(calls).toBe(1);
  });
  it("creates an ordinary conversation with automatic intent only after capability verification", async () => {
    const seen: string[] = [];
    mockFetch((url, init) => {
      seen.push(url);
      if (url === "/api/health") return { ok: true, body: { capabilities: { uno_intent_routing: 1 } } };
      expect(JSON.parse(String(init?.body))).toEqual({ project_id: "p", thinking_mode: "quick" });
      return { ok: true, body: { id: "c", thinking_mode: "quick" } };
    });
    expect((await createConversation("p", "quick")).thinking_mode).toBe("quick");
    expect(seen).toEqual(["/api/health", "/api/conversations"]);
  });
  it("does not silently create an old agent conversation on a backend without intent routing", async () => {
    mockFetch(url => {
      expect(url).toBe("/api/health");
      return { ok: true, body: { capabilities: { uno_thinking_routes: 1 } } };
    });
    await expect(createConversation("p", "quick")).rejects.toThrow("自动意图识别");
  });
  it("delivers intent independently from answer text", async () => {
    const intent = { action: "retrieve", route: "challenge", judgment: "检验上轮判断的边界" }, onIntent = vi.fn(), onDelta = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/security/session"
      ? new Response(JSON.stringify({ token: "test" }))
      : new Response([{ type: "intent", intent }, { type: "delta", text: "回答正文" }, { type: "done" }].map(e => "data: " + JSON.stringify(e) + "\n\n").join(""))));
    await sendChatStream("c", "问题", { onIntent, onDelta, onDone() {}, onError(detail) { throw new Error(detail); } });
    expect(onIntent).toHaveBeenCalledWith(intent);
    expect(onDelta).toHaveBeenCalledExactlyOnceWith("回答正文");
  });
  it("sendChat POSTs JSON and returns answer", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("/api/chat");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("X-Nexogenesis-CSRF")).toBe("test-local-token");
      expect(JSON.parse(String(init?.body))).toEqual({
        conversation_id: "c1", message: "你好",
      });
      return { ok: true, body: { answer: "回答", conversation_id: "c1" } };
    });
    const r = await sendChat("c1", "你好");
    expect(r.answer).toBe("回答");
  });

  it("sendChat throws backend detail on error", async () => {
    mockFetch(() => ({ ok: false, status: 400, body: { detail: "请先在设置中配置 LLM API Key" } }));
    await expect(sendChat("c1", "x")).rejects.toThrow("请先在设置中配置 LLM API Key");
  });

  it("jsonOrThrow falls back to status when no detail", async () => {
    mockFetch(() => ({ ok: false, status: 500, body: {} }));
    await expect(sendChat("c1", "x")).rejects.toThrow("500");
  });

  it("fetchProjects returns projects array without reusing a stale conversation snapshot", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("/api/projects");
      expect(init?.cache).toBe("no-store");
      return { ok: true, body: { projects: [{ id: "p1", name: "默认项目", conversations: [] }] } };
    });
    const ps = await fetchProjects();
    expect(ps[0].name).toBe("默认项目");
  });

  it("deleteConversation sends the JSON body required by the DSH endpoint", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("/api/conversations/conversation-1");
      expect(init?.method).toBe("DELETE");
      expect(init?.body).toBe("{}");
      expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
      return { ok: true, body: { deleted: true } };
    });

    await expect(deleteConversation("conversation-1")).resolves.toBeUndefined();
  });

  it("deleteConversation accepts a successful empty response", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/security/session") return {
        ok: true, status: 200, json: async () => ({ token: "test-local-token" }),
      } as Response;
      return {
        ok: true,
        status: 204,
        json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
      } as unknown as Response;
    }));

    await expect(deleteConversation("conversation-1")).resolves.toBeUndefined();
  });

  it("deleteConversations keeps successful deletions when one protected conversation fails", async () => {
    const requested: string[] = [];
    mockFetch((url) => {
      requested.push(url);
      if (url.endsWith("/running")) return { ok: false, status: 409, body: { detail: "请先停止任务，再删除对话。" } };
      return { ok: true, body: { deleted: true } };
    });

    await expect(deleteConversations(["first", "running", "last", "first"])).resolves.toEqual({
      deletedIds: ["first", "last"],
      failures: [{ id: "running", message: "请先停止任务，再删除对话。" }],
    });
    expect(requested).toEqual([
      "/api/conversations/first",
      "/api/conversations/running",
      "/api/conversations/last",
    ]);
  });

  it("resetPipelineConversation requests a fresh fixed task conversation", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("/api/pipeline/digest/conversation/reset");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({});
      return { ok: true, body: { id: "fresh-digest", title: "消化", project_id: "p1", created_at: "now", updated_at: "now", task_kind: "digest", messages: [] } };
    });
    await expect(resetPipelineConversation("digest")).resolves.toMatchObject({ id: "fresh-digest", task_kind: "digest", messages: [] });
  });

  it("resetPipelineConversation explains when an older local service lacks the route", async () => {
    mockFetch((url) => {
      expect(url).toBe("/api/pipeline/compile/conversation/reset");
      return { ok: false, status: 404, body: { detail: "not found" } };
    });
    await expect(resetPipelineConversation("compile")).rejects.toThrow("尚未加载“清理对话”功能");
  });

  it("treats an ordinary conversation without CognitiveRun as an inactive state", async () => {
    mockFetch((url) => {
      expect(url).toBe("/api/cognition/sessions/session-1");
      return { ok: true, body: { active: false } };
    });
    await expect(fetchCognitiveSession("session-1")).resolves.toBeNull();
  });

  it("saveSettings PUTs and returns public view", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("/api/settings");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body)).provider).toBe("deepseek");
      expect(JSON.parse(String(init?.body)).style_prompt).toBe("结论先行");
      expect(JSON.parse(String(init?.body)).vision_model).toBe("vision-model");
      return { ok: true, body: { provider: "deepseek", base_url: "https://api.deepseek.com", model: "deepseek-v4-flash", api_key_masked: "sk-···0001", has_key: true, username: "u", style_prompt: "结论先行", default_style_prompt: "默认" } };
    });
    const s = await saveSettings({ provider: "deepseek", base_url: "https://api.deepseek.com", model: "deepseek-v4-flash", api_key: "sk-x", style_prompt: "结论先行", vision_model: "vision-model" });
    expect(s.has_key).toBe(true);
    expect(s.style_prompt).toBe("结论先行");
  });

  it("saves pipeline authority independently and keeps the request alive across page close", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("/api/settings");
      expect(init?.method).toBe("PUT");
      expect(init?.keepalive).toBe(true);
      expect(JSON.parse(String(init?.body))).toEqual({ pipeline_authority: "trusted" });
      return { ok: true, body: { pipeline_authority: "trusted" } };
    });
    const saved = await savePipelineAuthority("trusted");
    expect(saved.pipeline_authority).toBe("trusted");
  });

  it("uploadInbox posts multipart FormData", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("/api/inbox");
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).getAll("files")).toHaveLength(1);
      return { ok: true, body: { saved: ["a.md"] } };
    });
    const file = new File(["x"], "a.md");
    const list = { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) } as unknown as FileList;
    const r = await uploadInbox(list);
    expect(r.saved).toEqual(["a.md"]);
  });

  it("fetchInboxDocuments returns selectable Inbox materials", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("/api/inbox");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, body: { documents: [{ path: "books/a.epub", doc_type: "epub", size: 2048, modified_at: 1 }] } };
    });
    expect((await fetchInboxDocuments()).documents[0].path).toBe("books/a.epub");
  });

  it("fetchCardCatalog encodes full-text search, filters and sorting", async () => {
    mockFetch((url) => {
      expect(url).toBe("/api/cards?q=%E6%B5%81%E5%8A%A8%E6%80%A7&type=claim&domain=finance&relation=supports&sort=relevance");
      return { ok: true, body: { items: [], total: 0, all_total: 0, facets: { types: [], domains: [], relations: [] } } };
    });
    const result = await fetchCardCatalog({ query: "流动性", type: "claim", domain: "finance", relation: "supports", sort: "relevance" });
    expect(result.total).toBe(0);
  });
});

function mockStreamFetch(chunks: string[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/security/session") return {
      ok: true, status: 200, json: async () => ({ token: "test-local-token" }),
    } as Response;
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          for (const s of chunks) c.enqueue(enc.encode(s));
          c.close();
        },
      }),
    } as Response;
  }));
}

describe("sendChatStream", () => {
  const noop = () => undefined;

  it("sends structured construct choices and keeps resume separate", async () => {
    mockStreamFetch(['data: {"type":"done"}\n\n']);
    const request = { snapshot: "snapshot", goal: "connect" as const, workload: "advice" as const,
      scope: { kind: "domain" as const, id: "finance" }, changes: "relations" as const, notes: "保留独特证据" };
    await sendChatStream("construct-thread", "/construct", { onDelta: noop, onDone: noop, onError: noop }, undefined, { constructRequest: request });
    let calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(JSON.parse(String(calls.at(-1)?.[1]?.body)).construct_request).toEqual(request);
    await sendChatStream("construct-thread", "继续任务", { onDelta: noop, onDone: noop, onError: noop }, undefined, { resumeTask: true });
    calls = vi.mocked(globalThis.fetch).mock.calls;
    const resumed = JSON.parse(String(calls.at(-1)?.[1]?.body));
    expect(resumed.resume_task).toBe(true);
    expect(resumed.construct_request).toBeUndefined();
  });

  it("reassembles SSE frames across chunk boundaries", async () => {
    mockStreamFetch([
      'data: {"type":"delta","text":"你"}\n\nda',
      'ta: {"type":"delta","text":"好"}\n\ndata: {"type":"done"}\n\n',
    ]);
    const deltas: string[] = [];
    let done = false;
    await sendChatStream("c1", "hi", {
      onDelta: (t) => deltas.push(t),
      onDone: () => { done = true; },
      onError: () => { throw new Error("不应触发 onError"); },
    });
    expect(deltas).toEqual(["你", "好"]);
    expect(done).toBe(true);
  });

  it("dispatches error frames", async () => {
    mockStreamFetch(['data: {"type":"error","detail":"LLM 调用失败，请检查网络与 API Key 配置"}\n\n']);
    let detail = "";
    await sendChatStream("c1", "hi", {
      onDelta: noop,
      onDone: noop,
      onError: (d) => { detail = d; },
    });
    expect(detail).toContain("API Key");
  });

  it("skips a malformed SSE frame, reports it, and preserves later content", async () => {
    mockStreamFetch([
      'data: {broken}\r\n\r\ndata: {"type":"delta","text":"仍可继续"}\r\n\r\ndata: {"type":"done"}\r\n\r\n',
    ]);
    const deltas: string[] = [];
    const frameErrors: string[] = [];
    await sendChatStream("c1", "hi", {
      onDelta: (text) => deltas.push(text), onDone: noop, onError: noop,
      onFrameError: (detail) => frameErrors.push(detail),
    });
    expect(frameErrors).toHaveLength(1);
    expect(deltas).toEqual(["仍可继续"]);
  });

  it("reports a truncated final SSE frame without discarding earlier deltas", async () => {
    mockStreamFetch(['data: {"type":"delta","text":"已收到"}\n\ndata: {"type":']);
    const deltas: string[] = [];
    let frameError = "";
    await sendChatStream("c1", "hi", {
      onDelta: (text) => deltas.push(text), onDone: noop, onError: noop,
      onFrameError: (detail) => { frameError = detail; },
    });
    expect(deltas).toEqual(["已收到"]);
    expect(frameError).toContain("损坏");
  });

  it("fetchGraphOverview loads the menu overview data", async () => {
    let requests = 0;
    mockFetch((url) => {
      requests += 1;
      expect(url).toBe("/api/graph/overview");
      return { ok: true, body: { node_count: 2, edge_count: 1, domain_count: 1, entity_count: 0, node_types: [], classification_scope: 'ordered-single-type-and-domains-v2', relation_types: [], relation_highlight: null, judgment: { tone: "info", text: "x" } } };
    });
    expect((await fetchGraphOverview()).node_count).toBe(2);
    expect((await fetchGraphOverview()).edge_count).toBe(1);
    expect(requests).toBe(1);

    invalidateGraphOverviewCache();
    await fetchGraphOverview();
    expect(requests).toBe(2);
  });

  it('does not cache an overview from an obsolete classification contract',async()=>{
    mockFetch(()=>({ok:true,body:{node_count:2,edge_count:0,node_types:[{type:'claim',count:2}],relation_types:[],judgment:{tone:'info',text:'test'}}}));
    const stats=await fetchGraphOverview();
    expect(stats.node_types).toEqual([{type:'claim',count:2}]);
    expect(readCachedGraphOverview()).toBeNull();
  });

  it("dispatches agent frames", async () => {
    mockStreamFetch([
      'data: {"type":"step","kind":"retrieve","label":"检索：政策"}\n\n',
      'data: {"type":"sources","cards":[{"id":"a","title":"卡A"}]}\n\n',
      'data: {"type":"confirm_request","proposal_id":"pw-000000000000","summary":"写入","operations":[]}\n\n',
    ]);
    const labels: string[] = [];
    const cards: string[] = [];
    let proposal = "";
    await sendChatStream("c1", "hi", {
      onDelta: noop, onDone: noop, onError: noop,
      onStep: (s) => labels.push(s.label),
      onSources: (s) => cards.push(s[0].id),
      onConfirmRequest: (p) => { proposal = p.proposal_id; },
    });
    expect(labels).toEqual(["检索：政策"]);
    expect(cards).toEqual(["a"]);
    expect(proposal).toBe("pw-000000000000");
  });

  it("dispatches a structured pipeline result", async () => {
    mockStreamFetch(['data: {"type":"pipeline_status","state":"failed","label":"任务未完成","detail":"校验失败"}\n\n']);
    let result = "";
    await sendChatStream("c1", "hi", {
      onDelta: noop, onDone: noop, onError: noop,
      onPipelineStatus: (status) => { result = `${status.state}:${status.detail}`; },
    });
    expect(result).toBe("failed:校验失败");
  });

  it("sends the selected compile material as structured task scope", async () => {
    mockStreamFetch(['data: {"type":"done"}\n\n']);
    await sendChatStream("compile-thread", "/compile", {
      onDelta: noop, onDone: noop, onError: noop,
    }, undefined, { pipelineSources: ["books/报告一.epub"] });
    const init = vi.mocked(fetch).mock.calls[1][1];
    expect(JSON.parse(String(init?.body))).toEqual({
      conversation_id: "compile-thread",
      message: "/compile",
      pipeline_sources: ["books/报告一.epub"],
    });
  });

  it("confirmWrite posts a decision", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("/api/write/confirm");
      expect(JSON.parse(String(init?.body))).toEqual({ proposal_id: "pw-000000000000", decision: "confirm" });
      return { ok: true, body: { applied: true, created: ["a"], enriched: [] } };
    });
    expect((await confirmWrite("pw-000000000000", "confirm")).applied).toBe(true);
  });

  it("cancelChat requests a real session cancellation", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("/api/chat/cancel");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ conversation_id: "c1" });
      return { ok: true, body: { cancelled: true } };
    });
    await expect(cancelChat("c1")).resolves.toBeUndefined();
  });

  it("requests an after-wave pause and accepts the structured response", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("/api/pipeline/jobs/construct-thread/stop?after_wave=true");
      expect(init?.method).toBe("POST");
      return { ok: true, status: 202, body: {
        accepted: true, mode: "after_wave", state: "running", detail: "将在当前最小工作单元结束后暂停。",
      } };
    });
    const result = await stopPipelineJob("construct-thread", true);
    expect(result.accepted).toBe(true);
    expect(result.mode).toBe("after_wave");
  });

  it("throws backend detail on non-streamed HTTP error", async () => {
    mockFetch(() => ({ ok: false, status: 400, body: { detail: "请先在设置中配置 LLM API Key" } }));
    await expect(sendChatStream("c1", "x", {
      onDelta: noop, onDone: noop, onError: noop,
    })).rejects.toThrow("请先在设置中配置 LLM API Key");
  });
});
