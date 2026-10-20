// Browser check for Converse autosave. Drives the REAL <Converse> under React
// StrictMode (as main.tsx does) in headless Chromium, through a Vite dev server.
// Every /api call and WebRTC is stubbed, so nothing leaves the machine.
//
//   node web/scripts/converse-autosave-check.mjs        # CHROMIUM=<path> to pick a browser
//
// Fails (exit 1) unless, WITHOUT the close button:
//   - a typed chat (with a tool call) longer than the 60-entry screen window is saved whole, each turn once;
//   - a voice chat (placeholder, streamed reply, late user transcript) is saved, each turn once;
//   - hiding the page posts a save.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  configFile: join(WEB, "vite.config.ts"),
  root: WEB,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, hmr: false },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

const failures = [];
const check = (what, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) failures.push(`${what}\n      ${JSON.stringify(detail)}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function openConverse() {
  const page = await browser.newPage();
  const saves = [];
  let replies = 0;
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.addInitScript(() => {
    // WebRTC stand-ins: the test plays the model's events through window.__dc.
    window.RTCPeerConnection = class {
      connectionState = "new";
      addTrack() {}
      createDataChannel() {
        window.__dc = { readyState: "open", send() {}, close() {} };
        return window.__dc;
      }
      async createOffer() {
        return { type: "offer", sdp: "v=0" };
      }
      async setLocalDescription() {}
      async setRemoteDescription() {}
      close() {}
    };
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => new MediaStream() } });
  });
  await page.route("https://api.openai.com/**", (r) => r.fulfill({ body: "v=0" }));
  await page.route("**/api/**", (r) => {
    const p = new URL(r.request().url()).pathname;
    if (p === "/api/converse/conversations" && r.request().method() === "POST") {
      saves.push(JSON.parse(r.request().postData()));
      return r.fulfill({ json: { ok: true } });
    }
    if (p === "/api/chat/config")
      return r.fulfill({
        json: { settings: { provider: "openai", model: "m" }, providers: [{ id: "openai", label: "OpenAI", models: ["m"] }] },
      });
    if (p === "/api/voice/rt/chat") {
      const n = ++replies;
      const toolCalls = n === 1 ? [{ name: "search", args: { query: "pitch" }, ok: true, result: "{}" }] : [];
      return r.fulfill({ json: { text: `Reply ${n}.`, toolCalls } });
    }
    if (p === "/api/voice/rt/token") return r.fulfill({ json: { value: "ek" } });
    return r.fulfill({ json: {} });
  });
  await page.route(`${base}/check.html`, (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><script type="module">
import R from "/@react-refresh"; R.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (t) => t; window.__vite_plugin_react_preamble_installed__ = true;
</script></head><body><div id="root"></div><script type="module" src="/scripts/converse-autosave-harness.tsx"></script></body></html>`,
    }),
  );
  await page.goto(`${base}/check.html`);
  await page.locator("textarea").waitFor({ timeout: 60_000 });
  return { page, saves };
}

const turnsOf = (rec) => (rec?.turns ?? []).filter((t) => t.role !== "system").map((t) => `${t.role}:${t.text}`);
const hide = (page) =>
  page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });

try {
  // ---- typed: 32 turns = 64 entries, past the 60-entry screen window ----
  {
    const { page, saves } = await openConverse();
    const want = [];
    for (let i = 1; i <= 32; i++) {
      await page.locator("textarea").fill(`Question ${i}`);
      await page.locator('button[aria-label="Send"]').click();
      await page.getByText(`Reply ${i}.`).first().waitFor({ timeout: 10_000 });
      want.push(`you:Question ${i}`, ...(i === 1 ? ["tool:Searched the vault for “pitch”"] : []), `assistant:Reply ${i}.`);
    }
    await page.waitForTimeout(2_000); // past the 1.5 s save delay
    const n = saves.length;
    check("typed chat saves after a turn, without the close button", n > 0, { saves: n });
    check("typed chat is saved whole, each turn once", same(turnsOf(saves.at(-1)), want), turnsOf(saves.at(-1)));
    await hide(page);
    await page.waitForTimeout(300);
    check("hiding the page posts a save", saves.length > n, { before: n, after: saves.length });
    check("close was never pressed", !(await page.evaluate(() => window.__closed)), {});
    await page.close();
  }

  // ---- voice: placeholder, streamed reply, late user transcript, a dropped placeholder ----
  {
    const { page, saves } = await openConverse();
    await page.locator('button[aria-label="Start voice mode"]').click();
    await page.waitForFunction(() => window.__dc?.onopen && window.__dc?.onmessage);
    const say = (ev) => page.evaluate((e) => window.__dc.onmessage({ data: JSON.stringify(e) }), ev);
    await page.evaluate(() => window.__dc.onopen());
    await say({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    await say({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "Hel" });
    await say({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "lo." });
    await say({ type: "response.output_audio_transcript.done", item_id: "a1", transcript: "Hello." });
    await say({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "Hi there" });
    await say({ type: "input_audio_buffer.speech_started", item_id: "u2" }); // never transcribed (noise)
    await page.waitForTimeout(9_500); // the placeholder's 9 s timeout, then the save delay
    await say({ type: "conversation.item.input_audio_transcription.completed", item_id: "u3", transcript: "Bye" });
    await page.waitForTimeout(2_000);
    const want = ["you:Hi there", "assistant:Hello.", "you:Bye"];
    check("voice chat is saved, each turn once, in order", same(turnsOf(saves.at(-1)), want), turnsOf(saves.at(-1)));
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nall passed");
