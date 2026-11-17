"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { disconnectPhone, startPhoneBinding, updateAgentSettings } from "@/server/actions/channel";

interface Props {
  configured: boolean;
  line: string | null;
  phoneMasked: string | null;
  connectedAt: string | null;
  prefs: { briefTime: string; quietStart: string; quietEnd: string; proactiveEnabled: boolean; dailyUnpromptedLimit: number; pausedUntil: string | null };
}

export function AgentSettings({ configured, line, phoneMasked, connectedAt, prefs }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [p, setP] = useState({ ...prefs, dailyUnpromptedLimit: String(prefs.dailyUnpromptedLimit) });

  const run = (fn: () => Promise<void>) =>
    start(async () => {
      setError(null);
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    });

  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <h3 className="text-sm font-medium">iMessage line</h3>
        {!configured && (
          <p className="text-sm text-muted">The messaging provider isn&apos;t configured on the server yet (Sendblue keys).</p>
        )}
        {phoneMasked ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span data-testid="agent-connected">
              Connected to {phoneMasked}
              {connectedAt ? ` since ${new Date(connectedAt).toLocaleDateString()}` : ""}.
            </span>
            <button type="button" className="btn" disabled={pending} onClick={() => run(() => disconnectPhone())}>
              Disconnect
            </button>
          </div>
        ) : (
          <div className="grid gap-2 text-sm">
            <p className="text-muted">Connect your phone so you can text the agent and get your morning brief.</p>
            {code ? (
              <p data-testid="binding-code">
                Text <strong className="font-mono text-base">{code.code}</strong> to {line ?? "the agent's line"} from your iPhone within 15
                minutes.
              </p>
            ) : null}
            <button
              type="button"
              className="btn btn-primary w-fit"
              disabled={pending || !configured}
              onClick={() =>
                run(async () => {
                  const r = await startPhoneBinding();
                  setCode({ code: r.code, expiresAt: r.expiresAt });
                })
              }
            >
              {code ? "New code" : "Connect my phone"}
            </button>
          </div>
        )}
      </div>

      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await updateAgentSettings({ ...p, dailyUnpromptedLimit: Number(p.dailyUnpromptedLimit) });
            setSaved(true);
          });
        }}
      >
        <h3 className="text-sm font-medium">When the agent may text you first</h3>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.proactiveEnabled} onChange={(e) => setP({ ...p, proactiveEnabled: e.target.checked })} />
          Morning brief and nudges
        </label>
        {p.pausedUntil && new Date(p.pausedUntil) > new Date() && (
          <p className="text-xs text-muted">Paused until {new Date(p.pausedUntil).toLocaleString()}. Saving with this on resumes now.</p>
        )}
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <label className="label" htmlFor="briefTime">Brief time</label>
            <input id="briefTime" className="input" type="time" value={p.briefTime} onChange={(e) => setP({ ...p, briefTime: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="quietStart">Quiet from</label>
            <input id="quietStart" className="input" type="time" value={p.quietStart} onChange={(e) => setP({ ...p, quietStart: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="quietEnd">Quiet until</label>
            <input id="quietEnd" className="input" type="time" value={p.quietEnd} onChange={(e) => setP({ ...p, quietEnd: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="dailyLimit">Max per day</label>
            <input
              id="dailyLimit"
              className="input"
              type="number"
              min={0}
              max={10}
              value={p.dailyUnpromptedLimit}
              onChange={(e) => setP({ ...p, dailyUnpromptedLimit: e.target.value })}
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={pending}>Save agent settings</button>
          {saved && <span className="text-sm text-muted">Saved</span>}
        </div>
      </form>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
