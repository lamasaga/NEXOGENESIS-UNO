export const COMPILE_HINTS=[
  {id:'free',label:'自由式编译',prompt:'根据材料自身结构判断重点与卡片粒度，不预设类型倾向，保留有独立价值的知识和关键论证。'},
  {id:'entities-cases',label:'实体与案例',prompt:'重点保存材料中的重要实体与案例，交代对象身份、关键事实、发生过程、背景边界及其在论证中的作用。'},
  {id:'mechanisms-methods',label:'机制与方法',prompt:'重点保存材料明确表达的机制与方法，保留运作过程、操作步骤、适用条件、证据和局限。'},
  {id:'ideas-disputes',label:'观念与争议',prompt:'重点保存材料中的核心主张、观念分歧与实质争议，区分各方立场、依据、前提和反驳关系。'},
  {id:'concepts-models',label:'概念与模型',prompt:'重点保存可独立复用的概念与模型，说明定义、组成、解释对象、成立条件、适用范围和局限。'}
];
export function parseCompileCommand(text){const match=/^\s*\/(?:编译|compile|主题编译|theme-compile|theme_compile)(?=\s|$)\s*\+?\s*([\s\S]*)$/iu.exec(String(text));return match?{notes:match[1].trim()}:null;}
