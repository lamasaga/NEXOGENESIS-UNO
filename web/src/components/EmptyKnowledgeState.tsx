import { ArrowRight, ChatCircleDots, FileArrowUp, ShareNetwork } from "@phosphor-icons/react";

interface Props {
  onStartConversation: () => void;
}

export function EmptyKnowledgeState({ onStartConversation }: Props) {
  return <section className="empty-knowledge-state" aria-labelledby="empty-knowledge-state-title">
    <div className="empty-knowledge-state__panel">
      <div className="empty-knowledge-state__eyebrow">
        <span className="empty-knowledge-state__mark" aria-hidden><ShareNetwork size={22} weight="duotone" /></span>
        <span>新的知识库</span>
      </div>
      <h1 id="empty-knowledge-state-title">从一个问题或一份材料开始</h1>
      <p>这里还没有知识卡片。它们会在你编译材料、展开对话或确认沉淀后，逐步形成可浏览的图谱。</p>
      <div className="empty-knowledge-state__paths" aria-label="开始方式">
        <div>
          <ChatCircleDots size={18} weight="duotone" aria-hidden />
          <span><strong>先提出问题</strong><small>用右侧对话探索你的研究主题。</small></span>
        </div>
        <div>
          <FileArrowUp size={18} weight="duotone" aria-hidden />
          <span><strong>先导入材料</strong><small>在左侧“编译”中整理原文，生成具有主类型和领域归属的知识卡片。</small></span>
        </div>
      </div>
      <button className="empty-knowledge-state__action" type="button" onClick={onStartConversation}>
        开始一个问题 <ArrowRight size={16} weight="bold" aria-hidden />
      </button>
    </div>
  </section>;
}
