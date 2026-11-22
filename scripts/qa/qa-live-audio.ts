/** Silent synthetic PCM/real-panel test. Optional --origin tests a real hosted origin.
 * --gateway-module may point at Rechrome's actual audio-stream-server.ts for cross-project verification.
 * Nothing starts a physical microphone, speaker or paid model. Tickets never enter logs/storage.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import type { LiveTicket } from "../../packages/debug-chat/src/live-audio-core";
const args = process.argv.slice(2),
  value = (key: string) => {
    const i = args.indexOf(key);
    return i < 0 ? undefined : args[i + 1];
  };
const realOrigin = value("--origin"),
  origin = realOrigin ?? "https://live-audio.fixture.invalid";
const gatewayModule = value("--gateway-module");
let checks = 0;
const check = (condition: unknown, label: string) => {
  assert(condition, label);
  checks++;
  console.log(`✓ ${label}`);
};
const pcm = { sampleRate: 16000 as const, channels: 1 as const, format: "s16le" as const };
let inputs = 0,
  outputs = 0,
  afterEofOutputs = 0,
  ended = false,
  lastFrame: Uint8Array | null = null;
const receivedFrames: Uint8Array[] = [];
let holdCredits = false;
const pendingCredits: (() => unknown)[] = [];
const until = async (f: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!f() && Date.now() < deadline) await Bun.sleep(10);
  assert(f(), "fixture condition timed out");
};
let stop: () => void = () => {};
let ticket: LiveTicket;
if (gatewayModule) {
  const { createPcmGateway } = await import(gatewayModule);
  let gateway: any;
  gateway = createPcmGateway(
    {
      sourceId: "li-source",
      destinationId: "synthetic-a",
      clientOrigin: origin,
      pcm,
      maxSeconds: 30,
    },
    async (base: string, key: string) => {
      const request = (path: string, method = "GET", body?: unknown) =>
        fetch(base + path, {
          method,
          headers: { authorization: "Bearer " + key, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      await request("/start", "POST");
      while (!gateway.closed) {
        const r = (await (await request("/input")).json()) as any;
        if (r.stop) return;
        if (r.data) {
          inputs++;
          lastFrame = Uint8Array.from(Buffer.from(r.data, "base64"));
          receivedFrames.push(lastFrame);
          const ack = async () => {
            await request("/ack", "POST");
          };
          if (holdCredits) pendingCredits.push(ack);
          else await ack();
          outputs++;
          await request("/output", "POST", { frames: [r.data] });
        }
        if (r.endInput) {
          ended = true;
          await request("/ended", "POST");
          if (lastFrame) {
            afterEofOutputs++;
            outputs++;
            await request("/output", "POST", {
              frames: [Buffer.from(lastFrame).toString("base64")],
            });
          }
        }
      }
    },
  );
  ticket = gateway.ticket;
  stop = () => gateway.stop("cancelled");
} else {
  const capability = "fixture-capability-not-a-real-secret";
  let consumed = false,
    sequence = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (req.headers.get("origin") !== origin || consumed)
        return new Response("Unavailable", { status: 403 });
      return srv.upgrade(req) ? undefined : new Response("Unavailable", { status: 400 });
    },
    websocket: {
      message(ws, data) {
        const frame = (pcmBytes: Uint8Array) => {
          const n = sequence++;
          outputs++;
          ws.send(
            JSON.stringify({
              type: "frame",
              sequence: n,
              sampleOffset: n * 320,
              byteLength: 640,
              sourceId: "synthetic-a",
              destinationId: "li-source",
            }),
          );
          ws.send(pcmBytes);
        };
        if (typeof data !== "string") {
          assert.equal(data.byteLength, 640);
          inputs++;
          lastFrame = new Uint8Array(data);
          receivedFrames.push(lastFrame);
          frame(lastFrame);
          const inputSequence = inputs - 1;
          const ack = () => ws.send(JSON.stringify({ type: "credit", bytes: 640, inputSequence }));
          if (holdCredits) pendingCredits.push(ack);
          else ack();
          return;
        }
        const m = JSON.parse(data);
        if (m.type === "hello") {
          assert.equal(m.capability, capability);
          consumed = true;
          ws.send(
            JSON.stringify({
              type: "ready",
              version: 1,
              sourceId: "li-source",
              destinationId: "synthetic-a",
              input: pcm,
              output: pcm,
              frameMs: 20,
              maxFrameBytes: 640,
              inputWindowBytes: 5120,
              outputWindowBytes: 5120,
            }),
          );
        }
        if (m.type === "end-input") {
          ended = true;
          ws.send(JSON.stringify({ type: "input-ended" }));
          if (lastFrame) {
            afterEofOutputs++;
            frame(lastFrame);
          }
        }
        if (m.type === "cancel") ws.close();
      },
    },
  });
  ticket = {
    version: 1,
    url: `ws://127.0.0.1:${server.port}/stream`,
    capability,
    clientOrigin: origin,
    expiresAt: Date.now() + 30000,
    sourceId: "li-source",
    destinationId: "synthetic-a",
    input: pcm,
    output: pcm,
    frameMs: 20,
    maxFrameBytes: 640,
    inputWindowBytes: 5120,
  };
  stop = () => server.stop(true);
}
const built = await Bun.build({
  entrypoints: [join(import.meta.dir, "qa-live-audio.page.tsx")],
  target: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
  // This standalone React fixture uses fixed switch words; actual SealSwitch
  // behavior is retained without bundling Next's server-side dictionary loader.
  plugins: [
    {
      name: "live-fixture-locales",
      setup(build) {
        build.onResolve({ filter: /^next-intlayer$/ }, () => ({
          path: "switch-words",
          namespace: "live-fixture",
        }));
        build.onLoad({ filter: /.*/, namespace: "live-fixture" }, () => ({
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
  await context.addInitScript(() => {
    (globalThis as any).__livePhysicalMic = 0;
    (globalThis as any).__livePhysicalOutput = 0;
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (this: AudioNode, ...args: any[]) {
      if (args[0] === this.context.destination) (globalThis as any).__livePhysicalOutput++;
      return Reflect.apply(connect, this, args);
    } as any;
    if (navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async () => {
        (globalThis as any).__livePhysicalMic++;
        throw Error("fixture-device-denied");
      };
  });
  const page = await context.newPage();
  if (!realOrigin)
    await page.route(origin + "/**", (route: any) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body>synthetic fixture</body></html>",
      }),
    );
  await page.goto(origin + (realOrigin ? "/en" : "/"), {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.addScriptTag({ content: await built.outputs[0].text() });
  await page.getByTestId("live-ticket").waitFor();
  const importTicket = async (value: LiveTicket) =>
    page.getByTestId("live-ticket").setInputFiles({
      name: "ticket.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(value)),
    });
  await importTicket(ticket);
  await page.getByTestId("live-start").waitFor({ state: "visible" });
  check(inputs === 0, "import never starts the route automatically");
  check(
    (await page.getByTestId("live-source").textContent()) === "li-source",
    "explicit source displayed",
  );
  check(
    (await page.getByTestId("live-target").textContent()) === "synthetic-a",
    "valid target colliding with an internal alias still works",
  );
  check(
    !(await page.locator("body").textContent())!.includes(ticket.capability),
    "capability never rendered",
  );
  await page.getByTestId("live-route-b").click();
  await page.getByTestId("live-start").click();
  await page.waitForFunction(
    () => Number(document.querySelector('[data-testid="live-outputFrames"]')?.textContent) > 3,
  );
  check(!ended && inputs > 0 && outputs > 0, "actual PCM is bidirectional before input EOF");
  const before = inputs;
  holdCredits = true;
  await until(() => inputs >= before + 8);
  check(pendingCredits.length === 8, "slow credits fill exactly the negotiated input window");
  await page.getByTestId("live-route-a").click();
  holdCredits = false;
  for (const release of pendingCredits.splice(0)) await release();
  await until(() => inputs > before + 11);
  check(
    (await page.getByTestId("live-state").textContent()) === "ready",
    "route change during backpressure does not close the connection",
  );
  const amplitude = (frequency: number) => {
    const view = new DataView(lastFrame!.buffer, lastFrame!.byteOffset, lastFrame!.byteLength);
    let sin = 0,
      cos = 0;
    for (let i = 0; i < 320; i++) {
      const sample = view.getInt16(i * 2, true) / 32768;
      sin += sample * Math.sin((2 * Math.PI * frequency * i) / 16000);
      cos += sample * Math.cos((2 * Math.PI * frequency * i) / 16000);
    }
    return (Math.hypot(sin, cos) * 2) / 320;
  };
  check(
    amplitude(880) > 3 * amplitude(440) && amplitude(880) > 0.05,
    "only source B remains in actual PCM after source A cancellation",
  );
  check(inputs > before, "removing source A leaves source B and the route running");
  check(await page.getByTestId("live-route-mic").isDisabled(), "mic route cannot open a device");
  check(
    (await page.evaluate(() => (globalThis as any).__livePhysicalOutput)) === 0,
    "monitor is silent by default",
  );
  await page.evaluate(() => (globalThis as any).__liveFixtureMic(true));
  await page.getByTestId("live-route-mic").click();
  await until(() => amplitude(660) > 0.06 && amplitude(880) < 0.03);
  check(
    amplitude(660) > 0.06,
    "already-on mic PCM reaches named destination and replaces test tones",
  );
  holdCredits = true;
  await until(() => pendingCredits.length === 8);
  const beforeMicOff = inputs;
  await page.evaluate(() => (globalThis as any).__liveFixtureMic(false));
  holdCredits = false;
  for (const ack of pendingCredits.splice(0)) await ack();
  await until(() => inputs > beforeMicOff);
  check(
    receivedFrames[beforeMicOff]?.every((byte) => byte === 0) &&
      (await page.getByTestId("live-state").textContent()) === "ready",
    "mic off retracts backpressured capture without closing the route",
  );
  await page.evaluate(() => (globalThis as any).__liveFixtureMic(true));
  await until(() => amplitude(660) > 0.06);
  await page.getByTestId("live-monitor").click();
  await page.waitForFunction(() => (globalThis as any).__livePhysicalOutput > 0);
  check(true, "explicit monitor schedules returned PCM through muted test graph");
  await page.evaluate(() => {
    localStorage.setItem("lk:agent-chat-speak", "0");
    localStorage.setItem("lk:debug-chat-speak", "0");
  });
  await page.waitForTimeout(60);
  const mutedNodes = await page.evaluate(() => (globalThis as any).__livePhysicalOutput);
  await page.waitForTimeout(100);
  check(
    (await page.evaluate(() => (globalThis as any).__livePhysicalOutput)) === mutedNodes,
    "read-aloud mute prevents further monitor output while transport continues",
  );
  await page.getByTestId("live-monitor").click();
  await page.evaluate(() => (globalThis as any).__liveFixtureMic(false));
  await page.getByTestId("live-end-input").click();
  await page.getByTestId("live-state").filter({ hasText: "input-ended" }).waitFor();
  await until(() => ended && afterEofOutputs > 0);
  check(ended && afterEofOutputs > 0, "half-close keeps output active");
  await page.getByTestId("live-stop").click();
  check(
    (await page.getByTestId("live-state").textContent()) === "closed",
    "explicit Stop closes the route",
  );
  check(
    (await page.evaluate(() => (globalThis as any).__livePhysicalMic)) === 0,
    "no physical microphone requested",
  );

  console.log(
    JSON.stringify({
      checks,
      origin,
      browser: browser.version(),
      inputs,
      outputs,
      renderer: gatewayModule ? "synthetic via actual gateway" : "synthetic fixture",
      physicalPlayback: false,
      monitorGraph: "muted synthetic only",
    }),
  );
} finally {
  await browser.close();
  stop();
}
