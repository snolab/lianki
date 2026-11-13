import { describe, expect, it } from "bun:test";
import { agentGuideFile } from "../middleware";

describe("agentGuideFile: the guide's public file names", () => {
  it("reads the language from the name, base tag only", () => {
    expect(agentGuideFile("/agent-guide.md")).toEqual({ lang: null });
    expect(agentGuideFile("/agent-guide.zh-CN.md")).toEqual({ lang: "zh" });
    expect(agentGuideFile("/agent-guide.ja.md")).toEqual({ lang: "ja" });
    expect(agentGuideFile("/agent-guide.EN.md")).toEqual({ lang: "en" });
  });
  it("anything else is not the guide", () => {
    expect(agentGuideFile("/agent-guide")).toBeNull();
    expect(agentGuideFile("/agent-guide.md/x")).toBeNull();
    expect(agentGuideFile("/x/agent-guide.md")).toBeNull();
    expect(agentGuideFile("/agent-guide.zh_CN.md")).toBeNull();
  });
});
