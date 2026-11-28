/** Cross-project interactive consent smoke. All chat/audio endpoints are synthetic and muted.
 * --pairing-module <audio-pairing.ts> --gateway-module <audio-stream-server.ts>
 * Optional --chrome --origin https://<hosted-origin>; no security flags are disabled.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
const args = process.argv.slice(2),
  value = (key: string) => args[args.indexOf(key) + 1];
const pairModule = args.includes("--pairing-module") ? value("--pairing-module") : "";
const gatewayModule = args.includes("--gateway-module") ? value("--gateway-module") : "";
if (!pairModule || !gatewayModule)
  throw Error("Provide compatible local pairing and gateway modules");
const origin = args.includes("--origin") ? value("--origin")! : "https://voice.fixture.invalid";
const { createAudioPairing } = await import(pairModule);
const { createPcmGateway } = await import(gatewayModule);
let checks = 0,
  inputs = 0,
  outputs = 0,
  cookiesLeaked = false;
const gateways: any[] = [];
const frames: Uint8Array[] = [];
const check = (ok: unknown, label: string) => {
  assert(ok, label);
  checks++;
  console.log("✓ " + label);
};
const until = async (test: () => boolean) => {
  const end = Date.now() + 10000;
  while (!test() && Date.now() < end) await Bun.sleep(10);
  assert(test(), "fixture condition timed out");
};
const pairing = createAudioPairing({
  targets: async () => [
    {
      id: "fixture-stable-chat",
      title: "Selected test chat",
      origin: "https://chat.fixture.invalid",
    },
  ],
  grant: async (target: string, options: any) => {
    assert.equal(target, "fixture-stable-chat");
    let gateway: any;
    gateway = createPcmGateway(
      {
        sourceId: options.sourceId,
        destinationId: "chat-selected",
        clientOrigin: options.origin,
        pcm: options.pcm,
        maxSeconds: 60,
      },
      async (base: string, key: string) => {
        const call = (path: string, body?: unknown) =>
          fetch(base + path, {
            method: body === undefined ? "GET" : "POST",
            headers: { authorization: "Bearer " + key, "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        await call("/start", {});
        while (!gateway.closed) {
          const next = (await (await call("/input")).json()) as any;
          if (next.stop) break;
          if (next.data) {
            inputs++;
            frames.push(Uint8Array.from(Buffer.from(next.data, "base64")));
            await call("/ack", {});
            outputs++;
            await call("/output", { frames: [next.data] });
          }
          if (next.endInput) await call("/ended", {});
        }
      },
    );
    gateways.push(gateway);
    return {
      ticket: gateway.ticket,
      isActive: () => inputs > 0 && !gateway.closed,
      revoke: () => gateway.stop("cancelled"),
    };
  },
});
let base = "";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (
      [
        "/audio/pair/discovery",
        "/audio/pair/request",
        "/audio/pair/status",
        "/audio/pair/cancel",
      ].includes(path) &&
      req.headers.get("cookie")
    )
      cookiesLeaked = true;
    return pairing.handle(req, base);
  },
});
base = `http://127.0.0.1:${server.port}`;
const built = await Bun.build({
  entrypoints: [join(import.meta.dir, "qa-live-audio.page.tsx")],
  target: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "voice-fixture-locales",
      setup(build) {
        build.onResolve({ filter: /^next-intlayer$/ }, () => ({
          path: "words",
          namespace: "voice-fixture",
        }));
        build.onLoad({ filter: /.*/, namespace: "voice-fixture" }, () => ({
          loader: "js",
          contents:
            'export const useIntlayer = () => ({ on: { value: "On" }, off: { value: "Off" } });',
        }));
      },
    },
  ],
});
if (!built.success) throw new AggregateError(built.logs, "fixture build failed");
const browser = await launchSilent(
  chromium,
  args.includes("--chrome") ? { channel: "chrome" } : {},
);
try {
  const context = await newSilentContext(browser);
  await context.grantPermissions(["local-network-access"], { origin });
  await context.addInitScript(
    ({ base }) => {
      (globalThis as any).__livePairBase = base;
      (globalThis as any).__voiceMicRequests = 0;
      (globalThis as any).__voiceOutputNodes = 0;
      const connect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (this: AudioNode, ...args: any[]) {
        if (args[0] === this.context.destination) (globalThis as any).__voiceOutputNodes++;
        return Reflect.apply(connect, this, args);
      } as any;
      if (navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = async () => {
          (globalThis as any).__voiceMicRequests++;
          throw Error("No physical capture in fixture");
        };
    },
    { base },
  );
  if (!args.includes("--origin"))
    await context.route(origin + "/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Voice fixture</title>",
      }),
    );
  const anon = await fetch(base + "/audio/pair/targets", { headers: { origin: base } });
  check(anon.status === 403, "chat list cannot be read without local operator consent");
  const operator = await context.newPage();
  await operator.goto(base + "/audio/pair/approve");
  const initialized = await operator.evaluate(async (token) => {
    const response = await fetch("/audio/pair/operator", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    return response.ok;
  }, pairing.bootstrap());
  check(initialized, "trusted one-time fixture companion initialization succeeds");
  check(
    !(await operator.evaluate(() => document.cookie)).includes("rech_audio_operator"),
    "operator cookie is HttpOnly",
  );
  await operator.close();
  const page = await context.newPage();
  await page.goto(origin + (args.includes("--origin") ? "/en" : "/"), {
    waitUntil: "domcontentloaded",
  });
  await page.addScriptTag({ content: await built.outputs[0].text() });
  await page.getByTestId("voice-connect").waitFor();
  check(
    !(await page.getByTestId("live-ticket").isVisible()),
    "ordinary connection does not ask for a file or ticket",
  );
  await page.getByTestId("voice-connect").click();
  await page.getByTestId("voice-approve").waitFor();
  check(
    gateways.length === 0 && inputs === 0,
    "Connect requests permission without granting audio",
  );
  await page.getByTestId("voice-cancel").click();
  check(
    await page.getByTestId("voice-connect").isVisible(),
    "pending consent can be cancelled and retried",
  );
  await page.getByTestId("voice-connect").click();
  await page.getByTestId("voice-approve").waitFor();
  const opened = context.waitForEvent("page");
  await page.getByTestId("voice-approve").click();
  const panel = await opened;
  await panel.getByRole("button", { name: "Connect selected chat" }).waitFor();
  check(
    (await panel.locator("select").innerText()).includes("Selected test chat"),
    "local confirmation offers actual chat titles",
  );
  await panel.getByRole("button", { name: "Connect selected chat" }).click();
  await panel.close();
  await page.bringToFront();
  await page.getByTestId("voice-chat-name").waitFor();
  check(
    (await page.getByTestId("voice-chat-name").textContent()) === "Selected test chat",
    "Li displays the approved chat instead of an opaque ID",
  );
  await until(() => inputs >= 3);
  check(
    frames.every((frame) => frame.every((byte) => byte === 0)),
    "approved stream is open, but Li microphone input remains silent until Start talking",
  );
  check(
    await page.getByTestId("voice-begin").isDisabled(),
    "call waits for the user-enabled Li microphone",
  );
  check(
    (await page.evaluate(() => (globalThis as any).__voiceOutputNodes)) === 0,
    "approval alone never enables monitoring",
  );
  await page.evaluate(() => (globalThis as any).__liveFixtureMic(true));
  await page.getByTestId("voice-begin").click();
  await until(() => frames.some((frame) => frame.some((byte) => byte !== 0)));
  await page.waitForFunction(() => (globalThis as any).__voiceOutputNodes > 0);
  check(
    outputs > 0,
    "explicit Start talking routes synthetic mic and returned PCM through the muted monitor",
  );
  await page.getByTestId("live-advanced-toggle").click();
  await page.getByTestId("live-advanced-toggle").click();
  check(
    await page.getByTestId("voice-disconnect").isVisible(),
    "closing diagnostics never ends an ordinary call",
  );
  await page.getByTestId("voice-disconnect").click();
  await until(() => gateways.every((gateway) => gateway.closed));
  check(
    await page.getByTestId("voice-connect").isVisible(),
    "Disconnect cancels the local grant and permits a fresh connection",
  );
  check(!cookiesLeaked, "Li pairing requests omit even the companion's local cookie");
  check(
    (await page.evaluate(() => (globalThis as any).__voiceMicRequests)) === 0,
    "no physical mic or model call was started by the test",
  );
  await page.evaluate(() => (globalThis as any).__liveFixtureMic(false));
  console.log(
    JSON.stringify({
      checks,
      origin,
      browser: browser.version(),
      inputs,
      outputs,
      renderer: "synthetic via actual pairing and gateway modules",
      physicalPlayback: false,
    }),
  );
} finally {
  await browser.close();
  pairing.close();
  for (const gateway of gateways) gateway.stop("fixture-end");
  server.stop(true);
}
