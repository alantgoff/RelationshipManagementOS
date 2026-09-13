"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  DEAL_SOURCE_QUALITIES,
  LP_STAGES,
  LP_STAGE_LABELS,
  ROLES,
  ROLE_LABELS,
  type DealSourceQuality,
  type LpStage,
  type Role,
} from "@/domain/enums";
import { defaultCadenceForRoles } from "@/domain/health";
import { createPerson, updatePerson } from "@/server/actions/people";
import type { PersonInput } from "@/server/validation";

export interface PersonFormValues {
  id?: string;
  fullName: string;
  preferredName: string;
  email: string;
  phone: string;
  company: string;
  title: string;
  location: string;
  howWeMet: string;
  notes: string;
  roles: Role[];
  tags: string;
  cadenceDays: string;
  lpStage: LpStage | "";
  dealSourceQuality: DealSourceQuality | "";
}

export const emptyPerson: PersonFormValues = {
  fullName: "",
  preferredName: "",
  email: "",
  phone: "",
  company: "",
  title: "",
  location: "",
  howWeMet: "",
  notes: "",
  roles: [],
  tags: "",
  cadenceDays: "",
  lpStage: "",
  dealSourceQuality: "",
};

function toInput(v: PersonFormValues): PersonInput {
  return {
    fullName: v.fullName,
    preferredName: v.preferredName,
    email: v.email,
    phone: v.phone,
    company: v.company,
    title: v.title,
    location: v.location,
    howWeMet: v.howWeMet,
    notes: v.notes,
    roles: v.roles,
    tags: v.tags.split(",").map((t) => t.trim()).filter(Boolean),
    cadenceDays: v.cadenceDays === "" ? null : Number(v.cadenceDays),
    lpStage: v.lpStage === "" ? null : v.lpStage,
    dealSourceQuality: v.dealSourceQuality === "" ? null : v.dealSourceQuality,
  };
}

export function PersonForm({ initial, cadenceOverrides = {} }: { initial: PersonFormValues; cadenceOverrides?: Partial<Record<Role, number>> }) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof PersonFormValues>(k: K, val: PersonFormValues[K]) => setV((s) => ({ ...s, [k]: val }));
  const suggested = defaultCadenceForRoles(v.roles, cadenceOverrides);
  const isLp = v.roles.includes("prospective_lp") || v.roles.includes("committed_lp");
  const isDealSource = v.roles.includes("deal_source");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      try {
        if (v.id) {
          await updatePerson(v.id, toInput(v));
          router.push(`/people/${v.id}`);
        } else {
          const { id } = await createPerson(toInput(v));
          router.push(`/people/${id}`);
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save");
      }
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-4 md:grid-cols-2" aria-label={v.id ? "Edit person" : "New person"}>
      <div className="md:col-span-2">
        <label className="label" htmlFor="fullName">Full name</label>
        <input id="fullName" className="input" required value={v.fullName} onChange={(e) => set("fullName", e.target.value)} />
      </div>
      <Field id="preferredName" label="Preferred name" value={v.preferredName} onChange={(x) => set("preferredName", x)} />
      <Field id="email" label="Email" type="email" value={v.email} onChange={(x) => set("email", x)} />
      <Field id="phone" label="Phone" value={v.phone} onChange={(x) => set("phone", x)} />
      <Field id="company" label="Company" value={v.company} onChange={(x) => set("company", x)} />
      <Field id="title" label="Title" value={v.title} onChange={(x) => set("title", x)} />
      <Field id="location" label="Location" value={v.location} onChange={(x) => set("location", x)} />
      <div className="md:col-span-2">
        <span className="label">Roles</span>
        <div className="flex flex-wrap gap-2">
          {ROLES.map((r) => (
            <label key={r} className={`btn cursor-pointer ${v.roles.includes(r) ? "btn-primary" : ""}`}>
              <input
                type="checkbox"
                className="sr-only"
                checked={v.roles.includes(r)}
                onChange={(e) => set("roles", e.target.checked ? [...v.roles, r] : v.roles.filter((x) => x !== r))}
              />
              {ROLE_LABELS[r]}
            </label>
          ))}
        </div>
      </div>
      <Field id="tags" label="Tags (comma separated)" value={v.tags} onChange={(x) => set("tags", x)} />
      <div>
        <label className="label" htmlFor="cadenceDays">Cadence in days</label>
        <input
          id="cadenceDays"
          className="input"
          type="number"
          min={1}
          inputMode="numeric"
          placeholder={suggested ? `Default ${suggested}` : "No cadence"}
          value={v.cadenceDays}
          onChange={(e) => set("cadenceDays", e.target.value)}
        />
      </div>
      {isLp && (
        <div>
          <label className="label" htmlFor="lpStage">LP stage</label>
          <select id="lpStage" className="input" value={v.lpStage} onChange={(e) => set("lpStage", e.target.value as LpStage | "")}>
            <option value="">Not set</option>
            {LP_STAGES.map((s) => (
              <option key={s} value={s}>{LP_STAGE_LABELS[s]}</option>
            ))}
          </select>
        </div>
      )}
      {isDealSource && (
        <div>
          <label className="label" htmlFor="dealSourceQuality">Deal-source quality</label>
          <select id="dealSourceQuality" className="input" value={v.dealSourceQuality} onChange={(e) => set("dealSourceQuality", e.target.value as DealSourceQuality | "")}>
            <option value="">Not set</option>
            {DEAL_SOURCE_QUALITIES.map((q) => (
              <option key={q} value={q}>{q}</option>
            ))}
          </select>
        </div>
      )}
      <Field id="howWeMet" label="How we met" value={v.howWeMet} onChange={(x) => set("howWeMet", x)} />
      <div className="md:col-span-2">
        <label className="label" htmlFor="notes">Notes</label>
        <textarea id="notes" className="input min-h-28" value={v.notes} onChange={(e) => set("notes", e.target.value)} />
      </div>
      {error && <p role="alert" className="md:col-span-2 text-sm text-red-700">{error}</p>}
      <div className="md:col-span-2 flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : v.id ? "Save changes" : "Create person"}
        </button>
        <button type="button" className="btn" onClick={() => router.back()}>Cancel</button>
      </div>
    </form>
  );
}

function Field({ id, label, value, onChange, type = "text" }: { id: string; label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} className="input" type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
