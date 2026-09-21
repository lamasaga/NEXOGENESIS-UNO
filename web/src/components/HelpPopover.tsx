export function HelpPopover() {
  return <div className="help-menu__popover" role="dialog" aria-label="UNO 使用帮助">
    <header className="help-menu__header">
      <span className="help-menu__eyebrow">UNO 使用指南</span>
      <strong>先分清对话、编译与建构</strong>
      <p>普通对话默认只读；编译负责把材料制成卡片，建构负责整理已有知识。通过检查的写入会保留来源、历史版本与任务记录。</p>
    </header>

    <section className="help-menu__section">
      <h3>常用入口</h3>
      <div className="help-menu__steps">
        <div><span>1</span><p><strong>新对话</strong>直接提问或讨论；回答中的卡片链接可以打开对应知识卡。对话本身不会自动改库。</p></div>
        <div><span>2</span><p><strong>导入材料</strong>把文件加入当前知识库的 Inbox。导入只登记材料，不会自行开始处理。</p></div>
        <div><span>3</span><p><strong>编译</strong>选择 Inbox 材料后按阅读单元直接生成、检查并保存卡片，不再经过“消化”。通过项先保存，问题项进入待修复队列。</p></div>
        <div><span>4</span><p><strong>建构</strong>选择侧重、范围与允许调整；UNO 会核对已有卡片与关系。审核后按当前设置自动保存，或等待你确认。</p></div>
      </div>
    </section>

    <section className="help-menu__section">
      <h3>任务状态怎么看</h3>
      <div className="help-menu__commands">
        <p><kbd>执行中</kbd><span>进度保留在原任务；刷新或短暂断线不会自动暂停。</span></p>
        <p><kbd>等待你处理</kbd><span>需要选择方向、审核结果或确认领域后才能继续。</span></p>
        <p><kbd>待修复</kbd><span>已通过成果仍可用；问题候选不会进入正式检索，也不算完成。</span></p>
        <p><kbd>可继续</kbd><span>原范围、检查点与用量保留，从未完成处恢复即可。</span></p>
      </div>
    </section>

    <aside className="help-menu__tip"><strong>知识库与任务归属</strong><span>顶部“知识实例”用于切换知识库，“卡片”用于浏览正式知识。编译与建构始终绑定创建任务时的知识库，不会随界面切换迁移；正在回答或执行时，请先完成、暂停或停止。</span></aside>
  </div>;
}
