import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { PipelineStatus } from "../api/client";
import { Sidebar } from "./Sidebar";

const originalWindow=globalThis.window;

beforeAll(()=>{
  Object.defineProperty(globalThis,"window",{configurable:true,value:{
    localStorage:{getItem:()=>null,setItem:()=>undefined},
    addEventListener:()=>undefined,
    removeEventListener:()=>undefined,
  }});
});

afterAll(()=>{
  if(originalWindow)Object.defineProperty(globalThis,"window",{configurable:true,value:originalWindow});
  else Reflect.deleteProperty(globalThis,"window");
});

const props={
  conversations:[],
  currentConvId:null,
  username:"HEIN",
  onNewConversation:()=>undefined,
  onSelectConversation:()=>undefined,
  onRenameConversation:async()=>true,
  onDeleteConversation:async()=>true,
  onDeleteConversations:async(threads: Array<{id:string}>)=>({deletedIds:threads.map(thread=>thread.id),failures:[]}),
  onTogglePinned:async()=>true,
  onClearPipelineConversation:async()=>true,
  pipelineThreads:{},
  pipelineStatus:{inbox:12,scratch:0} as PipelineStatus,
  pipelineRun:null,
  onRunPipeline:()=>undefined,
  onUploadFiles:()=>undefined,
  onOpenSettings:()=>undefined,
  onToggleCollapsed:()=>undefined,
};

describe("Sidebar",()=>{
  it("renders a discoverable whole-panel collapse control in the expanded sidebar",()=>{
    const html=renderToString(<Sidebar {...props} collapsed={false}/>);
    expect(html).toContain('aria-label="主导航"');
    expect(html).toContain('aria-label="收起左侧面板"');
    expect(html).not.toContain("sidebar-surface--collapsed");
  });

  it("keeps core actions and a restore control in the collapsed rail",()=>{
    const html=renderToString(<Sidebar {...props} collapsed/>);
    expect(html).toContain("sidebar-surface--collapsed");
    expect(html).toContain('aria-label="展开左侧面板"');
    expect(html).toContain('aria-label="新对话"');
    expect(html).toContain('aria-label="导入材料"');
    expect(html).toContain('aria-label="编译，12 条材料待编译"');
    expect(html).toContain('aria-label="建构"');
    expect(html).toContain('aria-label="设置"');
    expect(html).toContain("9+");
  });

  it("offers batch deletion when conversations are available",()=>{
    const html=renderToString(<Sidebar {...props} conversations={[
      {id:"conversation-1",title:"第一段对话",updated_at:"2026-09-21T00:00:00Z"},
      {id:"conversation-2",title:"置顶对话",updated_at:"2026-09-21T00:00:01Z",pinned:true},
    ]} collapsed={false}/>);
    expect(html).toContain("批量删除");
    expect(html).toContain("置顶对话");
    expect(html).toContain("其他对话");
  });
});
