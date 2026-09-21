export const COMPILE_HINTS=[
  {id:'free',label:'自由整理',prompt:'根据材料内容判断重点与卡片粒度，保留有独立价值的知识和关键论证。'},
  {id:'themes',label:'主题与论证',prompt:'重点把握全书主题、作者的核心问题与论证主线，保留立场、前提、分歧和关键案例。'},
  {id:'methods',label:'机制与方法',prompt:'重点保存材料明确表达的机制、模型与方法，保留过程、操作细节、适用条件和局限。'},
  {id:'cases',label:'案例与分歧',prompt:'重点保存关键历史案例、事件过程、不同立场与矛盾，明确作者如何使用这些材料论证。'}
];
export function parseCompileCommand(text){const match=/^\s*\/(?:编译|compile|主题编译|theme-compile|theme_compile)(?=\s|$)\s*\+?\s*([\s\S]*)$/iu.exec(String(text));return match?{notes:match[1].trim()}:null;}
