import { expect, type Page } from "@playwright/test";

export const isoDaysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
export const isoDaysFromNow = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

let counter = 0;
/** Unique names keep tests independent even when the DB is shared across projects. */
export function uniq(base: string): string {
  counter += 1;
  return `${base} ${Date.now().toString(36)}${counter}`;
}

export async function createPerson(page: Page, name: string, roles: string[] = [], extra: Record<string, string> = {}): Promise<string> {
  await page.goto("/people/new");
  await page.getByLabel("Full name").fill(name);
  for (const r of roles) {
    // Role checkboxes are visually hidden inside a styled label; click the label text.
    await page.getByText(r, { exact: true }).click();
    await expect(page.getByRole("checkbox", { name: r })).toBeChecked();
  }
  for (const [label, value] of Object.entries(extra)) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole("button", { name: "Create person" }).click();
  await page.waitForURL(/\/people\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(name);
  return page.url().split("/").pop()!;
}

export interface LogOptions {
  type?: string;
  summary: string;
  date?: string;
  notes?: string;
  introducedTo?: string;
  followUps?: { description: string; due?: string }[];
}

/** Opens the log dialog on the current page (person page) and saves an interaction. */
export async function logInteraction(page: Page, opts: LogOptions): Promise<void> {
  await page.getByRole("button", { name: "Log interaction" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  if (opts.type) await dialog.getByLabel("Type").selectOption(opts.type);
  await dialog.getByLabel("Summary").fill(opts.summary);
  if (opts.date) await dialog.getByLabel("Date").fill(opts.date);
  if (opts.notes) await dialog.getByRole("textbox", { name: "Notes" }).fill(opts.notes);
  if (opts.introducedTo) await dialog.getByLabel("Introduced to").selectOption({ label: opts.introducedTo });
  for (const [i, f] of (opts.followUps ?? []).entries()) {
    await dialog.getByRole("button", { name: "+ Add follow-up" }).click();
    await dialog.getByLabel(`Follow-up ${i + 1}`, { exact: true }).fill(f.description);
    if (f.due) await dialog.getByLabel(`Follow-up ${i + 1} due date`).fill(f.due);
  }
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
}
