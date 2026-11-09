// Connection plugins panel, rendered by bb below this plugin's settings form
// (app.slots.settingsSection). The host draws the heading and subheading from
// the registration; everything below is ours. Content mirrors the README's
// "Connection plugins" section — keep the two in step.
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
  return (
    <div className="space-y-4 text-xs">
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
