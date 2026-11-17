import { expect, test } from "@playwright/test";

const SIGNING = { "sb-signing-secret": "e2e-signing-secret", "content-type": "application/json" };
const LINE = "+13055550999";

function webhookBody(text: string, from: string, id = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`) {
  return {
    message_handle: id,
    content: text,
    from_number: from,
    to_number: LINE,
    sendblue_number: LINE,
    is_outbound: false,
    date_sent: new Date().toISOString(),
    service: "iMessage",
  };
}

test.describe("headless agent routes", () => {
  test("webhook rejects unsigned requests and answers unknown senders identically", async ({ request }) => {
    const unsigned = await request.post("/api/channels/sendblue", { data: webhookBody("hi", "+14155550100") });
    expect(unsigned.status()).toBe(401);

    const wrong = await request.post("/api/channels/sendblue", {
      headers: { ...SIGNING, "sb-signing-secret": "nope" },
      data: webhookBody("hi", "+14155550100"),
    });
    expect(wrong.status()).toBe(401);

    const unknown = await request.post("/api/channels/sendblue", { headers: SIGNING, data: webhookBody("hi", "+14155550100") });
    expect(unknown.status()).toBe(200);
    expect(await unknown.json()).toEqual({ ok: true });

    const bad = await request.post("/api/channels/sendblue", { headers: SIGNING, data: "not json" });
    expect([400, 200]).toContain(bad.status());
  });

  test("cron tick requires the secret", async ({ request }) => {
    expect((await request.get("/api/cron/tick")).status()).toBe(401);
    expect((await request.get("/api/cron/tick", { headers: { authorization: "Bearer wrong" } })).status()).toBe(401);
    const ok = await request.get("/api/cron/tick?dryRun=1", { headers: { authorization: "Bearer e2e-cron-secret" } });
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, dryRun: true });
  });

  test("connect a phone: code in Settings, texted in through the webhook", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "binding state is shared; run once");
    await page.goto("/settings");
    const disconnect = page.getByRole("button", { name: "Disconnect" });
    if (await disconnect.isVisible()) {
      await disconnect.click();
      await expect(page.getByRole("button", { name: "Connect my phone" })).toBeVisible();
    }
    await page.getByRole("button", { name: "Connect my phone" }).click();
    const codeText = await page.getByTestId("binding-code").innerText();
    expect(codeText).toContain(LINE);
    const code = /\b(\d{6})\b/.exec(codeText)?.[1];
    expect(code).toBeTruthy();

    const phone = "+14155550142";
    const res = await request.post("/api/channels/sendblue", { headers: SIGNING, data: webhookBody(code!, phone) });
    expect(res.status()).toBe(200);

    await page.reload();
    await expect(page.getByTestId("agent-connected")).toContainText("•••• 0142");

    // The used code doesn't work for another phone.
    const reuse = await request.post("/api/channels/sendblue", { headers: SIGNING, data: webhookBody(code!, "+14155550143") });
    expect(reuse.status()).toBe(200);
    await page.reload();
    await expect(page.getByTestId("agent-connected")).toContainText("•••• 0142");
  });

  test("agent preferences save", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "shared settings; run once");
    await page.goto("/settings");
    await page.getByLabel("Brief time").fill("08:15");
    await page.getByRole("button", { name: "Save agent settings" }).click();
    await expect(page.getByText("Saved", { exact: true }).last()).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Brief time")).toHaveValue("08:15");
  });
});
