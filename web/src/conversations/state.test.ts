import { describe, expect, it } from "vitest";
import type { Conversation, Project } from "../api/client";
import { canApplyConversationSnapshot, removeConversationFromProjects, updateConversationInProjects } from "./state";

const projects: Project[] = [{
  id: "project-1",
  name: "默认项目",
  created_at: "2026-08-30T08:00:00Z",
  conversations: [
    { id: "conversation-1", title: "原名称", updated_at: "2026-08-30T08:00:00Z", pinned: false },
    { id: "conversation-2", title: "保留的对话", updated_at: "2026-08-30T09:00:00Z", pinned: true },
  ],
}];

describe("conversation project state", () => {
  it("流式发送期间拒绝历史快照，避免已落盘消息与本地副本重复", () => {
    expect(canApplyConversationSnapshot("construct-1", "construct-1", true)).toBe(false);
    expect(canApplyConversationSnapshot("construct-1", "construct-1", false)).toBe(true);
  });

  it("旧轮询晚到时按当前流状态检查，且不污染已切换会话", () => {
    expect(canApplyConversationSnapshot("construct-1", "construct-1", false)).toBe(true);
    expect(canApplyConversationSnapshot("construct-1", "construct-1", true)).toBe(false);
    expect(canApplyConversationSnapshot("talk-2", "construct-1", false)).toBe(false);
    expect(canApplyConversationSnapshot(null, "construct-1", false)).toBe(false);
  });
  it("服务端确认删除后立即从本地项目列表移除对应对话", () => {
    const next = removeConversationFromProjects(projects, "conversation-1");

    expect(next[0].conversations.map((item) => item.id)).toEqual(["conversation-2"]);
    expect(projects[0].conversations).toHaveLength(2);
  });

  it("使用服务端返回结果同步名称、置顶状态和更新时间", () => {
    const updated: Conversation = {
      id: "conversation-1",
      project_id: "project-1",
      title: "领域关系梳理",
      created_at: "2026-08-30T08:00:00Z",
      updated_at: "2026-08-30T10:00:00Z",
      pinned: true,
      messages: [],
    };

    const next = updateConversationInProjects(projects, updated);

    expect(next[0].conversations[0]).toMatchObject({
      title: "领域关系梳理",
      pinned: true,
      updated_at: "2026-08-30T10:00:00Z",
    });
    expect(projects[0].conversations[0].title).toBe("原名称");
  });
});
