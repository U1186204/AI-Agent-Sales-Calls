/** Tool definitions stay in sync with the Zod contracts; server-owned keys are stripped. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOL_NAMES, TOOL_SCHEMAS } from "@/contracts";
import { anthropicTools, stripServerKeys, TOOL_DESCRIPTIONS, toolInputJsonSchema } from "@/agent";

type Shape = Record<string, z.ZodType>;

/** Top-level keys + required keys of a Zod input schema (object or discriminated union). */
function zodKeys(schema: z.ZodType): { keys: Set<string>; required: Set<string> } {
  const variants: z.ZodObject[] =
    schema instanceof z.ZodDiscriminatedUnion
      ? (schema.options as z.ZodObject[])
      : [schema as unknown as z.ZodObject];
  const keys = new Set<string>();
  const perVariant: Set<string>[] = [];
  for (const v of variants) {
    const shape = v.shape as Shape;
    const req = new Set<string>();
    for (const [k, s] of Object.entries(shape)) {
      keys.add(k);
      // optional() or default() → not required on input
      if (!s.safeParse(undefined).success) req.add(k);
    }
    perVariant.push(req);
  }
  const required = new Set<string>(
    [...(perVariant[0] ?? [])].filter((k) => perVariant.every((r) => r.has(k))),
  );
  return { keys, required };
}

describe("anthropic tool definitions", () => {
  it("has one definition per contract tool, in contract order, each with a description", () => {
    const tools = anthropicTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const t of tools) {
      expect(TOOL_DESCRIPTIONS[t.name as (typeof TOOL_NAMES)[number]].length).toBeGreaterThan(20);
      expect(t.input_schema.type).toBe("object");
    }
  });

  it.each(TOOL_NAMES)(
    "%s: JSON schema properties and required fields match the Zod contract",
    (name) => {
      const json = toolInputJsonSchema(name) as {
        type: string;
        properties: Record<string, unknown>;
        required?: string[];
      };
      const { keys, required } = zodKeys(TOOL_SCHEMAS[name].input);
      expect(json.type).toBe("object");
      expect(new Set(Object.keys(json.properties))).toEqual(keys);
      expect(new Set(json.required ?? [])).toEqual(required);
      expect(keys.has("reason")).toBe(true);
      expect(required.has("reason")).toBe(true);
      // businessId is never a tool input (server-injected).
      expect(JSON.stringify(json)).not.toMatch(/businessId|conversationId/);
    },
  );

  it("start_checkout union is flattened with both kinds", () => {
    const json = toolInputJsonSchema("start_checkout") as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(json.properties.kind?.enum?.sort()).toEqual(["product", "service"]);
    expect(Object.keys(json.properties).sort()).toEqual(["kind", "lines", "reason", "selection"]);
  });
});

describe("stripServerKeys", () => {
  it("removes businessId / conversationId at any depth", () => {
    const stripped: string[] = [];
    const out = stripServerKeys(
      {
        reason: "x",
        businessId: "flowline-plumbing",
        selection: { business_id: "x", serviceCode: "tv-mounting", conversationId: "c" },
        lines: [{ sku: "A", tenantId: "t" }],
      },
      stripped,
    );
    expect(out).toEqual({
      reason: "x",
      selection: { serviceCode: "tv-mounting" },
      lines: [{ sku: "A" }],
    });
    expect(stripped.sort()).toEqual(
      ["businessId", "business_id", "conversationId", "tenantId"].sort(),
    );
  });
});
