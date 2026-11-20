// Connection plugins panel, rendered by bb below this plugin's settings form
// (app.slots.settingsSection). The host draws the heading and subheading from
// the registration; everything below is ours. Content mirrors the README's
// "Connection plugins" section — keep the two in step.
import { useEffect, useState, useSyncExternalStore } from "react";
import { useSdk, useSettings } from "@get-bb/plugin-sdk/app";
import { activeCallRoute, subscribeAll } from "./session";
import type { PluginSettingsSectionProps } from "@get-bb/plugin-sdk/app";

interface ConnectionPlugin {
  readonly name: string;
  /** Secondary label: the plugin id and author, when it is not ours. */
  readonly note?: string;
  readonly summary: string;
  readonly commands: readonly string[];
  /** What the trailing command in `commands` proves. */
  readonly commandsNote?: string;
  readonly docsUrl: string;
  readonly docsLabel: string;
  readonly caveat?: string;
}

const PLUGINS: readonly ConnectionPlugin[] = [
  {
    name: "Realtime Gateway",
    summary:
      "Runs sessions through a Vercel AI Gateway key, so voice bills to one gateway account and the bb host never needs an OpenAI key.",
    commands: [
      "bb plugin install 'git:github.com/steveafrost/bb-plugin-realtime-gateway@^0.1.1'",
      "bb realtime-gateway test",
    ],
    commandsNote: "The test command mints a secret and opens one real session, which checks the handshake.",
    docsUrl: "https://github.com/steveafrost/bb-plugin-realtime-gateway",
    docsLabel: "github.com/steveafrost/bb-plugin-realtime-gateway",
  },
  {
    name: "ChatGPT Realtime Connection",
    note: "codex-realtime, by gpambrozio",
    summary:
      "Hands Voice Mode the ChatGPT token that codex login already stores on disk. This is the subscription path.",
    commands: [
      "bb plugin install 'git:github.com/gpambrozio/bb-plugins@>=0.1.0' --plugin codex-realtime --tag-prefix codex-realtime/",
    ],
    docsUrl: "https://github.com/gpambrozio/bb-plugins/tree/main/codex-realtime",
    docsLabel: "github.com/gpambrozio/bb-plugins/tree/main/codex-realtime",
    caveat:
      "A community plugin, not maintained here. Sending that token to the Realtime API is undocumented by OpenAI, so it can stop working without notice.",
  },
];

export function ConnectionPluginsSection(_props: PluginSettingsSectionProps) {
  const { values } = useSettings();
  const sdk = useSdk();
  const [providers, setProviders] = useState<string[]>();
  const [realtimeModel, setRealtimeModel] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const call = useSyncExternalStore(subscribeAll, activeCallRoute);
  useEffect(() => {
    let alive = true;
    setProviders(undefined);
    setFailed(false);
    setRealtimeModel(undefined);
    sdk.plugins.experimental_discoverRpc({ method: "realtimeConnection" }).then(async rows => {
      const ids = rows.filter(r => r.pluginId !== "voice-mode" && r.method === "realtimeConnection").map(r => r.pluginId);
      if (!alive) return;
      setProviders(ids);
      if (ids.includes("codex-realtime")) {
        const settings = await sdk.plugins.getSettings({ pluginId: "codex-realtime" }).catch(() => undefined);
        if (alive && settings) setRealtimeModel(String(settings.values.model || "gpt-realtime-2.1"));
      }
    }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [sdk, revision]);
  const provider = providers?.[0];
  const direct = String(values?.model ?? "gpt-realtime-2") + " · project API key";
  const providerLabel = provider === "codex-realtime" && realtimeModel ? realtimeModel + " · " + provider : provider;
  const subscription = "Realtime 2.1 · codex-realtime" + (providers && !providers.includes("codex-realtime")
    ? " (provider missing)" : realtimeModel && realtimeModel !== "gpt-realtime-2.1" ? " (requires provider model gpt-realtime-2.1)" : "");
  const voice = String(values?.voice ?? "marin");
  const stages: Record<string, string[]> = {
    "codex-live-first": ["Live 1.1 · Codex login · " + String(values?.codexLiveVoice ?? "cove"), subscription + " · " + voice],
    "live-first": ["Live 1 · project API key · " + voice, subscription + " · " + voice],
    "openai-live": ["Live 1 · project API key · " + voice],
    "openai-api-key": [direct + " · " + voice],
    plugin: [providerLabel ?? "Connection plugin"],
    auto: [providerLabel ?? "Connection plugin if available", direct],
  };
  return (
    <div className="space-y-4 text-xs">
      <dl className="space-y-1" aria-live="polite">
        <dt className="font-medium">Next call · primary → fallback</dt>
        <dd>{values ? stages[String(values.connection ?? "auto")]?.join(" → ") : "Loading settings…"}</dd>
        <dt className="font-medium">Current call</dt><dd>{call}</dd>
        <dt className="font-medium">Realtime providers</dt>
        <dd>{failed ? "Discovery unavailable" : providers ? providers.map(id => id === "codex-realtime" && realtimeModel ? id + " (" + realtimeModel + ")" : id).join(", ") || "None detected" : "Checking…"}{" "}
          <button type="button" onClick={() => setRevision(n => n + 1)}>Refresh</button></dd>
      </dl>
      {PLUGINS.map((plugin) => (
        <div key={plugin.name} className="space-y-1.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-medium text-foreground">{plugin.name}</span>
            {plugin.note ? <span className="text-subtle-foreground">{plugin.note}</span> : null}
          </div>
          <p className="text-muted-foreground">{plugin.summary}</p>
          <code className="block space-y-1 rounded-md bg-state-hover px-2 py-1.5 font-mono text-foreground/80">
            {plugin.commands.map((command) => (
              <span key={command} className="block break-all select-all">
                {command}
              </span>
            ))}
          </code>
          {plugin.commandsNote ? <p className="text-subtle-foreground">{plugin.commandsNote}</p> : null}
          <p className="text-muted-foreground">
            Docs:{" "}
            <a
              href={plugin.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              {plugin.docsLabel}
            </a>
          </p>
          {plugin.caveat ? <p className="text-subtle-foreground">{plugin.caveat}</p> : null}
        </div>
      ))}
      <p className="text-subtle-foreground">
        Only one connection plugin can serve a session: if two are installed, Voice Mode asks the first one
        discovery returns and ignores the rest. Uninstall the other, or set Connection explicitly.
      </p>
    </div>
  );
}
