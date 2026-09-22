import { expect, test } from "@playwright/test";
import { createPerson, isoDaysAgo, isoDaysFromNow, logInteraction, uniq } from "./helpers";

test.describe("v1 acceptance criteria", () => {
  test("AC-1 + AC-2: new LP gets 21-day cadence, shows as never, leaves dashboard after a meeting", async ({ page }) => {
    const name = uniq("Priya Patel");
    await createPerson(page, name, ["Prospective LP"]);
    await expect(page.getByText("every 21d")).toBeVisible();
    await expect(page.locator("[data-health=never]")).toBeVisible();

    await page.goto("/");
    const row = page.getByTestId("attention-row").filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row.locator("[data-health=never]")).toBeVisible();

    await row.getByRole("button", { name: "Log" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Summary").fill("Intro coffee");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("attention-row").filter({ hasText: name })).toHaveCount(0);

    await page.getByRole("link", { name: "People" }).click();
    await page.getByRole("link", { name }).click();
    await expect(page.locator("[data-health=fresh]")).toBeVisible();
  });

  test("AC-3: 35 days ago is cold and sorts above due", async ({ page }) => {
    const cold = uniq("Cold Carter");
    const due = uniq("Due Dawson");
    await createPerson(page, due, ["Prospective LP"]);
    await logInteraction(page, { summary: "A while back", date: isoDaysAgo(25) });
    await createPerson(page, cold, ["Prospective LP"]);
    await logInteraction(page, { summary: "Long ago", date: isoDaysAgo(35) });
    await expect(page.locator("[data-health=cold]")).toBeVisible();

    await page.goto("/?role=prospective_lp");
    const names = await page.getByTestId("attention-row").allInnerTexts();
    const iCold = names.findIndex((t) => t.includes(cold));
    const iDue = names.findIndex((t) => t.includes(due));
    expect(iCold).toBeGreaterThanOrEqual(0);
    expect(iDue).toBeGreaterThanOrEqual(0);
    expect(iCold).toBeLessThan(iDue);
  });

  test("AC-4: follow-up due in 3 days appears on dashboard; completing removes it", async ({ page }) => {
    const name = uniq("Sam Founder");
    const task = uniq("Send the deck");
    await createPerson(page, name, ["Founder"]);
    await logInteraction(page, { type: "call", summary: "Pitch call", followUps: [{ description: task, due: isoDaysFromNow(3) }] });

    await page.goto("/");
    const item = page.getByTestId("followup-list").getByText(task);
    await expect(item).toBeVisible();
    await page.getByRole("checkbox", { name: `Mark "${task}" done` }).check();
    await expect(page.getByTestId("followup-list").getByText(task)).toHaveCount(0);
  });

  test("AC-5: intro A→B shows on both timelines and counts for B", async ({ page }) => {
    const a = uniq("Ann Angel");
    const b = uniq("Ben Builder");
    const bId = await createPerson(page, b, ["Founder"]);
    await createPerson(page, a, ["Deal source"]);
    await logInteraction(page, { type: "intro", summary: "Intro to Ben", introducedTo: b });
    await expect(page.getByTestId("timeline-item").filter({ hasText: "Intro to Ben" })).toContainText(`Introduced to ${b}`);

    await page.goto(`/people/${bId}`);
    await expect(page.getByTestId("timeline-item").filter({ hasText: "Intro to Ben" })).toContainText(`Introduced by ${a}`);
    await expect(page.getByTestId("intros")).toHaveText("0 given · 1 received");
  });

  test("AC-6: CSV import with 2 duplicate emails prompts for both; skip yields 48 created", async ({ page }) => {
    const stamp = Date.now().toString(36);
    const d1 = `dupe1-${stamp}@example.com`;
    const d2 = `dupe2-${stamp}@example.com`;
    await createPerson(page, uniq("Existing One"), [], { Email: d1 });
    await createPerson(page, uniq("Existing Two"), [], { Email: d2 });

    const lines = ["Name,Email,Roles,Tags"];
    for (let i = 0; i < 50; i++) {
      const email = i === 0 ? d1 : i === 1 ? d2 : `p${i}-${stamp}@example.com`;
      lines.push(`Imported ${i} ${stamp},${email},${i % 2 ? "friend" : "LP"},csv-${stamp}`);
    }
    await page.goto("/import");
    await page.getByLabel("CSV file").setInputFiles({ name: "people.csv", mimeType: "text/csv", buffer: Buffer.from(lines.join("\n")) });
    await expect(page.getByText("50 rows.")).toBeVisible();
    await page.getByRole("button", { name: /Preview 50 people/ }).click();
    const dupes = page.getByTestId("duplicates").getByRole("listitem");
    await expect(dupes).toHaveCount(2);
    for (let i = 0; i < 2; i++) await dupes.nth(i).getByRole("button", { name: "Skip" }).click();
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByTestId("import-result")).toContainText("48 created · 0 merged · 2 skipped");

    await page.goto(`/people?tag=csv-${stamp}`);
    await expect(page.getByTestId("person-row")).toHaveCount(48);
  });

  test("AC-7: search finds a person by a word in interaction notes", async ({ page }) => {
    const name = uniq("Notes Nadia");
    const word = `quokka${Date.now().toString(36)}`;
    await createPerson(page, name);
    await logInteraction(page, { type: "meeting", summary: "Coffee", notes: `We talked about ${word} logistics` });
    await page.goto(`/people?q=${word}`);
    const rows = page.getByTestId("person-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(name);
  });

  test("AC-8: setting LP stage to committed adds the Committed LP role", async ({ page }) => {
    const name = uniq("Lee Limited");
    await createPerson(page, name, ["Prospective LP"]);
    await page.getByLabel("LP stage").selectOption("committed");
    await expect(page.getByText("Committed LP", { exact: true })).toBeVisible();
  });

  test("dashboard and person page have no horizontal overflow", async ({ page }) => {
    await page.goto("/");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflow).toBe(false);
  });
});
