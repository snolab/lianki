import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const require = createRequire(import.meta.url);
const runtime = createRequire(require.resolve("wrangler"))("miniflare") as {
  Miniflare: new (options: unknown) => {
    dispatchFetch(url: string): Promise<Response>;
    dispose(): Promise<void>;
  };
  convertV4MiniflareOptions(options: unknown): unknown;
};

test("workerd deadline cancels service-binding work, not only the caller's promise", async () => {
  const build = await Bun.build({
    entrypoints: [resolve("lib/bounded-sessions.ts")],
    target: "browser",
  });
  if (!build.success) throw new AggregateError(build.logs, "fixture build failed");
  const script = `${await build.outputs[0]!.text()}
export default {async fetch(request,env) {
 let pending=0;
 const work={async run(method,fn){pending++;try{return await fn()}finally{pending--}}};
 const rpc=boundedSessions(env.SESSIONS,work);
 const started=Date.now();let error='';
 try{await rpc.polishLines({})}catch(e){error=String(e)}
 const remote=await env.SESSIONS.fetch('https://sessions/state').then(r=>r.json());
 return Response.json({error,elapsed:Date.now()-started,pending,remote});
}};`;
  const config = await Bun.file("wrangler.jsonc").text();
  const flags = JSON.parse(
    config.match(/"compatibility_flags"\s*:\s*(\[[^\]]*\])/)![1]!,
  ) as string[];
  expect(flags).toContain("enable_request_signal");
  const transport = await Bun.build({
    entrypoints: [resolve("lib/sessions-http.ts")],
    target: "browser",
  });
  if (!transport.success)
    throw new AggregateError(transport.logs, "transport fixture build failed");
  const sessions = `import {WorkerEntrypoint} from 'cloudflare:workers';
${await transport.outputs[0]!.text()}
let cancelled=0,pending=0;export class DebugSessions extends WorkerEntrypoint{async fetch(r){
 if(new URL(r.url).pathname==='/state')return Response.json({cancelled,pending});
 return sessionsHttp(r,async(method,args,signal)=>{if(method==='config')return 500;
 pending++;try{return await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>resolve('late'),60000);
 signal.addEventListener('abort',()=>{clearTimeout(timer);cancelled++;reject(signal.reason)},{once:true});
 })}finally{pending--}})}};`;
  const mf = new runtime.Miniflare(
    runtime.convertV4MiniflareOptions({
      workers: [
        {
          name: "caller",
          modules: true,
          script,
          compatibilityDate: "2026-10-01",
          serviceBindings: { SESSIONS: { name: "sessions", entrypoint: "DebugSessions" } },
        },
        {
          name: "sessions",
          modules: true,
          script: sessions,
          compatibilityDate: "2026-10-01",
          compatibilityFlags: flags,
        },
      ],
    }),
  );
  try {
    const result = (await (await mf.dispatchFetch("http://localhost/run")).json()) as {
      error: string;
      elapsed: number;
      pending: number;
      remote: { cancelled: number; pending: number };
    };
    expect(result.error).toContain("TimeoutError");
    expect(result.elapsed).toBeGreaterThanOrEqual(450);
    expect(result.elapsed).toBeLessThan(5000);
    expect(result.pending).toBe(0);
    expect(result.remote).toEqual({ cancelled: 1, pending: 0 });
  } finally {
    await mf.dispose();
  }
}, 15_000);
