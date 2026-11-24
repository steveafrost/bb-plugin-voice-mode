import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VoiceModeModelSettings, VoiceModelSelectRow } from "../settings";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => ({ call: vi.fn(() => new Promise(() => {})) }),
  useRealtime: () => {},
}));

describe("model settings before the live catalog loads", () => {
  const html = renderToStaticMarkup(<VoiceModeModelSettings />);

  const optionsOf = (id: string) => {
    const select = new RegExp(`<select id="${id}"[^>]*>(.*?)</select>`, "s").exec(html)?.[1] ?? "";
    return [...select.matchAll(/<option value="([^"]*)"( selected="")?>([^<]*)<\/option>/g)].map((m) => ({
      value: m[1],
      selected: m[2] !== undefined,
      label: m[3],
    }));
  };

  it("defaults the realtime picker to connection plugin default with API key fallback", () => {
    expect(optionsOf("vm-realtime-model")).toEqual([
      { value: "", selected: true, label: "Use connection plugin default (API key: gpt-realtime-2)" },
    ]);
  });

  it("explains that a picked realtime model overrides the connection default when supported", () => {
    expect(html).toContain("overrides the connection plugin&#x27;s realtime model when supported");
  });

  it("defaults the delegation picker to Auto", () => {
    expect(optionsOf("vm-delegation-model")).toEqual([
      { value: "", selected: true, label: "Auto (fastest live OpenAI model)" },
    ]);
    expect(html).toContain("Delegation backend model");
    expect(html).toContain("gpt-live-*");
  });

  it("shows the retained transcription model, selected", () => {
    expect(optionsOf("vm-transcribe-model")).toEqual([
      { value: "gpt-4o-mini-transcribe", selected: true, label: "gpt-4o-mini-transcribe (loading catalog...)" },
    ]);
  });
});

describe("VoiceModelSelectRow grouping and latestModelsOnly", () => {
  it("groups multiple providers by groupLabel or normalized vendor in server order and keeps the empty realtime option", () => {
    const html = renderToStaticMarkup(
      <VoiceModelSelectRow
        id="vm-realtime-model"
        label="Realtime voice model"
        description="desc"
        value=""
        catalog={{
          models: [
            { id: "provider-rt", name: "Provider RT", vendor: "proxy", groupLabel: "Provider Models" },
            { id: "fallback-rt", name: "Fallback RT", vendor: "proxy" },
            { id: "gpt-realtime-2", name: "gpt-realtime-2", vendor: "openai" },
          ],
          latestModelsOnly: false,
        }}
        loading={false}
        disabled={false}
        emptyOptionLabel="Use connection plugin default (API key: gpt-realtime-2)"
        onChange={() => {}}
      />,
    );
    expect(html).toContain(
      '<option value="" selected="">Use connection plugin default (API key: gpt-realtime-2)</option>',
    );
    expect(html).toContain('<optgroup label="Provider Models">');
    expect(html).toContain('<optgroup label="Proxy">');
    expect(html).toContain('<optgroup label="OpenAI">');
    expect(html.indexOf('label="Provider Models"')).toBeLessThan(html.indexOf('label="OpenAI"'));
  });

  it("omits optgroup when only one group is returned", () => {
    const html = renderToStaticMarkup(
      <VoiceModelSelectRow
        id="vm-transcribe-model"
        label="Input transcription model"
        description="desc"
        value="gpt-transcribe"
        catalog={{
          models: [{ id: "gpt-transcribe", name: "gpt-transcribe", vendor: "openai", groupLabel: "OpenAI" }],
          latestModelsOnly: false,
        }}
        loading={false}
        disabled={false}
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain("<optgroup");
    expect(html).toContain('<option value="gpt-transcribe" selected="">gpt-transcribe</option>');
  });

  it("shows a calm muted note instead of a destructive error when latestModelsOnly hides a retained model", () => {
    const html = renderToStaticMarkup(
      <VoiceModelSelectRow
        id="vm-transcribe-model"
        label="Input transcription model"
        description="desc"
        value="gpt-4o-mini-transcribe"
        catalog={{
          models: [{ id: "gpt-transcribe", name: "gpt-transcribe", vendor: "openai", groupLabel: "OpenAI" }],
          latestModelsOnly: true,
        }}
        loading={false}
        disabled={false}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("gpt-4o-mini-transcribe (hidden by filter)");
    expect(html).toContain("hidden by Latest models only");
    expect(html).toContain("text-subtle-foreground");
    expect(html).not.toContain("text-destructive");
    expect(html).not.toContain("not in the live catalog");
  });

  it("shows a destructive error when a missing retained model is not filtered by latestModelsOnly", () => {
    const html = renderToStaticMarkup(
      <VoiceModelSelectRow
        id="vm-transcribe-model"
        label="Input transcription model"
        description="desc"
        value="gpt-4o-mini-transcribe"
        catalog={{
          models: [{ id: "gpt-transcribe", name: "gpt-transcribe", vendor: "openai", groupLabel: "OpenAI" }],
          latestModelsOnly: false,
        }}
        loading={false}
        disabled={false}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("gpt-4o-mini-transcribe (not in live catalog)");
    expect(html).toContain("text-destructive");
  });

  it("imports contract as types only in settings.tsx", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "settings.tsx"), "utf8");
    const runtimeImports = [...src.matchAll(/^import\s+(type\s+)?(?:[^;]*?\s+from\s+)?"([^"]+)";/gms)]
      .filter((m) => !m[1])
      .map((m) => m[2]);
    expect(runtimeImports).toEqual(["react", "@get-bb/plugin-sdk/app"]);
  });
});
