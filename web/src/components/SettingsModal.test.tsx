import { KnowledgeProcessing } from './settings/KnowledgeProcessing';
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsModal } from "./SettingsModal";

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(async () => ({
    provider: "deepseek", base_url: "https://api.deepseek.com", model: "deepseek-flash",
    api_key_masked: "", has_key: false, username: "用户",
    credential_status: { deepseek: { api_key_masked: "", has_key: false }, kimi_code_plan: { api_key_masked: "", has_key: false } },
    provider_options: [
      { id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com", default_model: "deepseek-flash", models: [{ id: "deepseek-flash", label: "DeepSeek Flash" }] },
      { id: "kimi_code_plan", label: "Kimi Code Plan", base_url: "https://api.kimi.com/coding", default_model: "k3-256k", models: [{ id: "k3-256k", label: "Kimi K3 256K" }] },
    ],
    vision_base_url: "", vision_model: "", vision_api_key_masked: "", has_vision_key: false, vision_configured: false,
    style_prompt: "结论先行", default_style_prompt: "默认风格",
    digest_two_stage: true,
    pipeline_authority: "manual",
  })),
  saveSettings: vi.fn(),
  testModelConnection: vi.fn(),
  savePipelineAuthority: vi.fn(),
}));

describe("SettingsModal", () => {
  it("把现有设置整合为四个清晰分类", () => {
    const html = renderToString(<SettingsModal onClose={() => undefined} />);
    expect(html).toContain("常规");
    expect(html).toContain("模型连接");
    expect(html).toContain("知识处理");
    expect(html).toContain("思维体表达");
    expect(html).not.toContain("计费");
    expect(html).not.toContain("插件");
  });

  it("默认展示真实的模型与本地凭据设置", () => {
    const html = renderToString(<SettingsModal onClose={() => undefined} initialSection="model" />);
    expect(html).toContain("凭据状态");
    expect(html).toContain("API Key");
    expect(html).toContain('aria-label="模型 ID"');
    expect(html).toContain("已保存不代表连接可用");
    expect(html).toContain("测试连接并读取模型");
    expect(html).toContain("图像处理");
    expect(html).toContain("不会猜测图像语义");
    expect(html).toContain("Kimi Code Plan");
    expect(html).toContain("智谱 GLM");
    expect(html).toContain("阿里云百炼");
    expect(html).toContain("思考强度");
    expect(html).toContain("对话思考深度");
    expect(html).toContain("实际 ID：");
    expect(html).toContain("deepseek-flash");
    expect(html).toContain("https://api.deepseek.com");
  });

  it("提供可编辑的思维体表达风格区域和恢复默认入口", () => {
    const html = renderToString(<SettingsModal onClose={() => undefined} initialSection="expression" />);
    expect(html).toContain("思维体表达风格");
    expect(html).toContain("思维体表达风格提示词");
    expect(html).toContain("恢复默认");
    expect(html).toContain("下一轮对话开始生效");
  });

  it("知识处理先给总体安排，再依次呈现编译、建构和对话",()=>{
    const html=renderToString(<KnowledgeProcessing value={{prompt:'保留关键案例',cleaning:'clear',delivery:'auto',external_images:false,budget_calls:120,revision:null}} onChange={()=>{}} conversationPersona="严谨但自然"/>);
    expect(html).toContain('知识处理长期偏好');expect(html).toContain('3,000 tokens');expect(html).toContain('处理设置');expect(html).toContain('高质量 · 逐卡精修');
    expect(html.indexOf('knowledge-overall')).toBeLessThan(html.indexOf('knowledge-compile'));expect(html.indexOf('knowledge-compile')).toBeLessThan(html.indexOf('knowledge-construct'));expect(html.indexOf('knowledge-construct')).toBeLessThan(html.indexOf('knowledge-conversation'));
    expect(html).toContain('审核通过后自动保存');expect(html).toContain('审核后由我确认');expect(html).toContain('思维体人设');expect(html).toContain('严谨但自然');expect(html).not.toContain('检索方式');expect(html).not.toContain('高质量编译的成本');expect(html).not.toContain('可以同时关注多个方向');expect(html).not.toContain('两阶段路由消化');
  });
});
