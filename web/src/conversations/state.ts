import type { Conversation, Project } from "../api/client";

// 流式本地消息与服务器快照不能同时成为当前轮的显示来源。
export function canApplyConversationSnapshot(currentId: string | null, incomingId: string, streamActive: boolean): boolean {
  return currentId === incomingId && !streamActive;
}

export function updateConversationInProjects(projects: Project[], conversation: Conversation): Project[] {
  return projects.map((project) => ({
    ...project,
    conversations: project.conversations.map((item) => item.id === conversation.id
      ? {
          ...item,
          title: conversation.title,
          updated_at: conversation.updated_at,
          pinned: conversation.pinned,
        }
      : item),
  }));
}

export function removeConversationFromProjects(projects: Project[], conversationId: string): Project[] {
  return projects.map((project) => ({
    ...project,
    conversations: project.conversations.filter((item) => item.id !== conversationId),
  }));
}
