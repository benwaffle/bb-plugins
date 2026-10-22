import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin, { TOOL_NAME } from "./server";

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "telecom-ref" });
  await plugin(bb);
  return harness;
}

function text(result: unknown): string {
  if (typeof result === "string") return result;
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((part) => part.text ?? "").join("\n");
}

describe(TOOL_NAME, () => {
  it("returns the full entry for an exact abbreviation, then other matches", async () => {
    const harness = await host();
    const output = text(await harness.behavior.callAgentTool(TOOL_NAME, { query: "ULR" }));
    expect(output).toMatch(/^## CMD ULR \/ ULA · Update-Location/);
    expect(output).toContain("TS 29.272 §7.2.3");
    expect(output).toContain("Page: /plugins/telecom-ref/ref/diam.cmd/316");
    expect(output).toContain("Other matches:");
    expect(output).toContain("ULR-Flags");
  });

  it("includes descriptions, type, flags, and children for an AVP", async () => {
    const harness = await host();
    const output = text(await harness.behavior.callAgentTool(TOOL_NAME, { query: "APN-Configuration-Profile" }));
    expect(output).toContain("AVP 1429 · vendor 10415 (3GPP) · Grouped");
    expect(output).toContain("Context-Identifier");
    expect(output).toContain("Parents: Subscription-Data (1400)");
  });

  it("keeps output bounded by the limit", async () => {
    const harness = await host();
    const output = text(await harness.behavior.callAgentTool(TOOL_NAME, { query: "location", kind: "avp", limit: 3 }));
    expect(output.match(/^### AVP /gm)?.length).toBe(3);
  });

  it("filters by interface name", async () => {
    const harness = await host();
    const output = text(await harness.behavior.callAgentTool(TOOL_NAME, { query: "charging", interface: "Gx", limit: 3 }));
    expect(output).toContain("### ");
    expect(output).not.toContain("No telecom-ref entry");
  });

  it("reports an unknown interface as a tool error", async () => {
    const harness = await host();
    const result = await harness.behavior.callAgentTool(TOOL_NAME, { query: "x", interface: "Zz9" });
    expect(text(result)).toContain('no interface named "Zz9"');
  });

  it("rejects an empty query", async () => {
    const harness = await host();
    await expect(harness.behavior.callAgentTool(TOOL_NAME, { query: "" })).rejects.toThrow();
  });
});

describe("bb telecom-ref", () => {
  it("search prints matches", async () => {
    const harness = await host();
    const result = await harness.behavior.runCli(["search", "ULR"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^### CMD ULR \/ ULA · Update-Location/);
  });

  it("search --json prints ids and entities", async () => {
    const harness = await host();
    const result = await harness.behavior.runCli(["search", "S6a", "--kind", "if", "--json"]);
    const parsed = JSON.parse(result.stdout ?? "[]") as Array<{ id: string }>;
    expect(parsed[0]?.id).toBe("if/S6a");
  });

  it("show resolves an exact key", async () => {
    const harness = await host();
    const result = await harness.behavior.runCli(["show", "diam.avp/10415/1400"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("## AVP Subscription-Data");
  });

  it("show fails with a hint for an ambiguous key", async () => {
    const harness = await host();
    const result = await harness.behavior.runCli(["show", "Subscr"]);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stderr}`).toContain("bb telecom-ref search Subscr");
  });
});
