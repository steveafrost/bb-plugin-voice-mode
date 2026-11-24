import { useCallback, useEffect, useMemo, useState } from "react";
import { type PluginSettingsSectionProps, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { VoiceModelOption, VoiceModelSelection, voiceModeRpcContract } from "./contract";

const DEFAULT_REALTIME_MODEL = "gpt-realtime-2";
const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const MODEL_SETTINGS_CHANNEL = "voice-mode:model-settings";

const SELECT_CLASS =
  "h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60";

const BUTTON_CLASS =
  "inline-flex h-7 shrink-0 cursor-pointer select-none items-center justify-center rounded-md border border-input bg-transparent px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50";

const VENDOR_LABELS: Record<string, string> = {
  alibaba: "Qwen",
  amazon: "Amazon",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  fireworks: "Fireworks",
  google: "Google",
  groq: "Groq",
  meta: "Meta",
  minimax: "MiniMax",
  moonshot: "Moonshot",
  openai: "OpenAI",
  "openai-oss": "OpenAI OSS",
  qwen: "Qwen",
  xai: "xAI",
  zai: "Z.ai",
};

function vendorLabel(vendor: string): string {
  const known = VENDOR_LABELS[vendor.toLowerCase()];
  if (known) return known;
  return vendor ? vendor.charAt(0).toUpperCase() + vendor.slice(1) : "Other";
}

function modelLabel(model: VoiceModelOption): string {
  return model.name !== model.id ? `${model.name} (${model.id})` : model.id;
}

function groupByProvider(
  models: ReadonlyArray<VoiceModelOption>,
): Array<{ label: string; models: VoiceModelOption[] }> {
  const groups = new Map<string, VoiceModelOption[]>();
  for (const model of models) {
    const label = model.groupLabel?.trim() || vendorLabel(model.vendor);
    const bucket = groups.get(label);
    if (bucket) {
      bucket.push(model);
    } else {
      groups.set(label, [model]);
    }
  }
  return [...groups.entries()].map(([label, list]) => ({ label, models: list }));
}

function retainedLabel(model: string, loading: boolean, filtered: boolean): string {
  if (loading) return `${model} (loading catalog...)`;
  return filtered ? `${model} (hidden by filter)` : `${model} (not in live catalog)`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ScopeCatalogState {
  models: VoiceModelOption[];
  latestModelsOnly: boolean;
}

const EMPTY_CATALOG: ScopeCatalogState = {
  models: [],
  latestModelsOnly: false,
};

export function VoiceModelSelectRow({
  id,
  label,
  description,
  value,
  catalog,
  loading,
  disabled,
  emptyOptionLabel,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  value: string;
  catalog: ScopeCatalogState;
  loading: boolean;
  disabled: boolean;
  emptyOptionLabel?: string;
  onChange: (next: string) => void;
}) {
  const groups = useMemo(() => groupByProvider(catalog.models), [catalog.models]);
  const listed = (!value && Boolean(emptyOptionLabel)) || catalog.models.some((m) => m.id === value);
  const missing = Boolean(value) && !loading && !listed;
  const filtered = catalog.latestModelsOnly;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <label htmlFor={id} className="block text-sm text-foreground">
          {label}
        </label>
        <p className="text-xs leading-snug text-subtle-foreground">{description}</p>
        {missing ? (
          filtered ? (
            <p className="text-xs text-subtle-foreground">
              "{value}" is hidden by Latest models only. It continues to work until you pick another model.
            </p>
          ) : (
            <p className="text-xs text-destructive">
              Selected model "{value}" is not in the live catalog. Refresh the models or pick another.
            </p>
          )
        ) : null}
      </div>
      <div className="w-72 max-w-[45%] shrink-0">
        <select
          id={id}
          className={SELECT_CLASS}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {emptyOptionLabel ? <option value="">{emptyOptionLabel}</option> : null}
          {value && !listed ? <option value={value}>{retainedLabel(value, loading, filtered)}</option> : null}
          {groups.length === 1
            ? groups[0]!.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {modelLabel(m)}
                </option>
              ))
            : groups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {modelLabel(m)}
                    </option>
                  ))}
                </optgroup>
              ))}
        </select>
      </div>
    </div>
  );
}

export function VoiceModeModelSettings(_props: PluginSettingsSectionProps) {
  const rpc = useRpc<typeof voiceModeRpcContract>();
  const [selection, setSelection] = useState<VoiceModelSelection | null>(null);
  const [realtimeCatalog, setRealtimeCatalog] = useState<ScopeCatalogState>(EMPTY_CATALOG);
  const [transcribeCatalog, setTranscribeCatalog] = useState<ScopeCatalogState>(EMPTY_CATALOG);
  const [delegationCatalog, setDelegationCatalog] = useState<ScopeCatalogState>(EMPTY_CATALOG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSelection = useCallback(async () => {
    try {
      setSelection(await rpc.call("modelSettings.get", null));
    } catch (err) {
      setError(errorText(err));
    }
  }, [rpc]);

  const loadModels = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const [rt, stt, delegation] = await Promise.allSettled([
          rpc.call("models.list", { scope: "realtime", refresh }),
          rpc.call("models.list", { scope: "transcription", refresh }),
          rpc.call("models.list", { scope: "delegation", refresh }),
        ]);
        const errors: string[] = [];
        if (rt.status === "fulfilled") {
          setRealtimeCatalog({ models: rt.value.models, latestModelsOnly: Boolean(rt.value.latestModelsOnly) });
        } else {
          setRealtimeCatalog((prev) => ({ ...prev, latestModelsOnly: false }));
          errors.push(errorText(rt.reason));
        }
        if (stt.status === "fulfilled") {
          setTranscribeCatalog({ models: stt.value.models, latestModelsOnly: Boolean(stt.value.latestModelsOnly) });
        } else {
          setTranscribeCatalog((prev) => ({ ...prev, latestModelsOnly: false }));
          errors.push(errorText(stt.reason));
        }
        if (delegation.status === "fulfilled") {
          setDelegationCatalog({
            models: delegation.value.models,
            latestModelsOnly: Boolean(delegation.value.latestModelsOnly),
          });
        } else {
          setDelegationCatalog((prev) => ({ ...prev, latestModelsOnly: false }));
          errors.push(errorText(delegation.reason));
        }
        if (errors.length) {
          setError([...new Set(errors)].join(" "));
        }
      } finally {
        setLoading(false);
      }
    },
    [rpc],
  );

  useEffect(() => {
    void loadSelection();
    void loadModels(false);
  }, [loadSelection, loadModels]);

  useRealtime(MODEL_SETTINGS_CHANNEL, () => {
    void loadSelection();
  });

  const save = useCallback(
    async (patch: Partial<VoiceModelSelection>) => {
      setSaving(true);
      setError(null);
      try {
        setSelection(await rpc.call("modelSettings.set", patch));
      } catch (err) {
        setError(errorText(err));
      } finally {
        setSaving(false);
      }
    },
    [rpc],
  );

  const current = selection ?? {
    realtimeModel: "",
    transcribeModel: DEFAULT_TRANSCRIBE_MODEL,
    delegationModel: "",
  };

  return (
    <div className="rounded-lg border border-border bg-surface-recessed px-3 py-3">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-subtle-foreground">
            Scoped to live OpenAI realtime voice, speech transcription, and delegation models.
          </p>
          <button type="button" className={BUTTON_CLASS} disabled={loading} onClick={() => void loadModels(true)}>
            {loading ? "Loading..." : "Refresh models"}
          </button>
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <VoiceModelSelectRow
          id="vm-realtime-model"
          label="Realtime voice model"
          description="Supports gpt-realtime-* and gpt-live-* models. Used for OpenAI API key connections. Picking a model here also overrides the connection plugin's realtime model when supported."
          value={current.realtimeModel}
          catalog={realtimeCatalog}
          loading={loading}
          disabled={selection === null || saving}
          emptyOptionLabel={`Use connection plugin default (API key: ${DEFAULT_REALTIME_MODEL})`}
          onChange={(realtimeModel) => void save({ realtimeModel })}
        />

        <VoiceModelSelectRow
          id="vm-transcribe-model"
          label="Input transcription model"
          description="OpenAI transcription model for gpt-realtime-* sessions. GPT-Live models transcribe speech natively and ignore this setting."
          value={current.transcribeModel}
          catalog={transcribeCatalog}
          loading={loading}
          disabled={selection === null || saving}
          onChange={(transcribeModel) => void save({ transcribeModel })}
        />

        <VoiceModelSelectRow
          id="vm-delegation-model"
          label="Delegation backend model"
          description="GPT-Live (gpt-live-*) models use this OpenAI Responses model to invoke the agent tools."
          value={current.delegationModel}
          catalog={delegationCatalog}
          loading={loading}
          disabled={selection === null || saving}
          emptyOptionLabel="Auto (fastest live OpenAI model)"
          onChange={(delegationModel) => void save({ delegationModel })}
        />
      </div>
    </div>
  );
}
