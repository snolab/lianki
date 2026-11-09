import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { IMPORT, SELF_INTRO_FIELDS, emptyFields } from "@/lib/self-intro/import-config";
import {
  ImportFileError,
  PARSERS,
  decodeText,
  markupToText,
  mergeImport,
  parseImportFile,
  pickParser,
  type FileLike,
} from "@/lib/self-intro/import-parse";
import {
  FACTS_JSON_SCHEMA,
  ImportRequest,
  extractSelfIntro,
  importMessages,
  parseFactsAnswer,
} from "@/lib/self-intro/import-extract";
import { handleImport, selfIntroImportOn, type ImportDeps } from "@/lib/self-intro/import-handler";
import type { Complete } from "@/lib/read/gloss-server";
import { FLAGS } from "@/lib/flags";

// Made-up material only: no real person's data anywhere in this file.
const MATERIAL = "Mei Example-Tanaka, nurse in Exampleton. Likes bouldering and baking.";

const fileOf = (name: string, type: string, data: Uint8Array | string): FileLike => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
};

/** A one-page PDF with `text` on it (offsets computed, so the xref is valid). */
function makePdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

async function makeZip(entries: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(entries)) zip.file(name, text);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

describe("parser dispatch (pickParser)", () => {
  const id = (name: string, type: string) => pickParser(name, type)?.id ?? null;

  it("picks by MIME type first", () => {
    expect(id("cv", "application/pdf")).toBe("pdf");
    expect(
      id("cv.bin", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ).toBe("docx");
    expect(id("export", "application/zip")).toBe("zip");
    expect(id("note", "image/heic")).toBe("image");
    expect(id("note", "image/jpeg; charset=binary")).toBe("image");
    expect(id("about", "text/markdown")).toBe("text");
    expect(id("profile", "text/html")).toBe("html");
    expect(id("data", "application/json")).toBe("text");
  });

  it("falls back to the extension when the type is missing or generic", () => {
    expect(id("CV.PDF", "")).toBe("pdf");
    expect(id("cv.docx", "application/octet-stream")).toBe("docx");
    expect(id("connections.csv", "")).toBe("text");
    expect(id("page.htm", "")).toBe("html");
    expect(id("IMG_0001.HEIC", "")).toBe("image");
    expect(id("export.zip", "")).toBe("zip");
  });

  it("knows nothing else", () => {
    expect(id("song.mp3", "audio/mpeg")).toBeNull();
    expect(id("noext", "")).toBeNull();
    expect(id("sheet.xlsx", "application/octet-stream")).toBeNull();
  });

  it("every parser declares what it matches", () => {
    for (const p of PARSERS) expect(p.mimes.length + p.exts.length).toBeGreaterThan(0);
  });
});

describe("parsers", () => {
  it("reads plain text, UTF-8 and UTF-16 with a BOM", async () => {
    const parts = await parseImportFile(fileOf("about.txt", "text/plain", `  ${MATERIAL}\n`));
    expect(parts).toEqual([{ kind: "text", name: "about.txt", text: MATERIAL }]);
    const le = new Uint8Array([
      0xff,
      0xfe,
      ...new Uint8Array(new Uint16Array([0x48, 0x69]).buffer),
    ]);
    expect(decodeText(le)).toBe("Hi");
    expect(decodeText(new Uint8Array([0xfe, 0xff, 0, 0x48, 0, 0x69]))).toBe("Hi");
  });

  it("turns markup into text: blocks become lines, scripts and tags go, entities decode", () => {
    const html =
      "<h1>Mei</h1><script>alert(1)</script><p>Nurse &amp; baker&#33; &#x263A; &nbsp;</p><br/>end &bogus;";
    expect(markupToText(html)).toBe("Mei\nNurse & baker! ☺\n\nend &bogus;");
  });

  it("reads an HTML file", async () => {
    const parts = await parseImportFile(fileOf("p.html", "text/html", "<p>Hello</p>"));
    expect(parts[0]).toEqual({ kind: "text", name: "p.html", text: "Hello" });
  });

  it("reads a PDF's text", async () => {
    const parts = await parseImportFile(
      fileOf("cv.pdf", "application/pdf", makePdf("Mei Example nurse")),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]!.kind).toBe("text");
    expect((parts[0] as { text: string }).text).toContain("Mei Example nurse");
  });

  it("reads a Word file's body, headers and footers", async () => {
    const docx = await makeZip({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        "<w:document><w:body><w:p><w:r><w:t>Mei Example</w:t></w:r></w:p><w:p><w:r><w:t>Nurse</w:t><w:tab/><w:t>Exampleton</w:t></w:r></w:p></w:body></w:document>",
      "word/header1.xml": "<w:hdr><w:p><w:r><w:t>mei@example.com</w:t></w:r></w:p></w:hdr>",
      "word/styles.xml": "<w:styles><w:t>IGNORED</w:t></w:styles>",
    });
    const [part] = await parseImportFile(
      fileOf(
        "cv.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        docx,
      ),
    );
    const text = (part as { text: string }).text;
    expect(text.startsWith("Mei Example\nNurse\tExampleton")).toBe(true);
    expect(text).toContain("mei@example.com");
    expect(text).not.toContain("IGNORED");
  });

  it("reads a zip's text entries (a profile export) by the same list", async () => {
    const zip = await makeZip({
      "Profile.csv": "First Name,Headline\nMei,Nurse",
      "about/index.html": "<p>Bouldering</p>",
      "photo.jpg": "not text",
      "empty.txt": "   ",
    });
    const parts = await parseImportFile(fileOf("export.zip", "application/zip", zip));
    expect(parts).toEqual([
      { kind: "text", name: "export.zip/Profile.csv", text: "First Name,Headline\nMei,Nurse" },
      { kind: "text", name: "export.zip/about/index.html", text: "Bouldering" },
    ]);
  });

  it("hands an image to the page's shrinker, and refuses one too large after it", async () => {
    const png = fileOf("note.png", "image/png", new Uint8Array([1, 2, 3]));
    const parts = await parseImportFile(png, {
      shrinkImage: async () => "data:image/jpeg;base64,AAAA",
    });
    expect(parts).toEqual([
      { kind: "image", name: "note.png", dataUrl: "data:image/jpeg;base64,AAAA" },
    ]);
    await expect(
      parseImportFile(png, { shrinkImage: async () => "x".repeat(IMPORT.maxImageChars + 1) }),
    ).rejects.toMatchObject({ code: "too-large" });
    await expect(parseImportFile(png)).rejects.toMatchObject({ code: "unsupported" });
  });

  it("names each failure: too large, unsupported, unreadable, empty", async () => {
    const big: FileLike = {
      ...fileOf("big.txt", "text/plain", "x"),
      size: IMPORT.maxFileBytes + 1,
    };
    await expect(parseImportFile(big)).rejects.toMatchObject({
      code: "too-large",
      file: "big.txt",
    });
    await expect(parseImportFile(fileOf("a.mp3", "audio/mpeg", "x"))).rejects.toBeInstanceOf(
      ImportFileError,
    );
    await expect(parseImportFile(fileOf("bad.docx", "", "not a zip"))).rejects.toMatchObject({
      code: "unreadable",
    });
    await expect(parseImportFile(fileOf("blank.txt", "text/plain", " \n "))).rejects.toMatchObject({
      code: "empty",
    });
  });

  it("maps a zip over the decompressed limit to too-large", async () => {
    const huge = await makeZip({ "word/document.xml": "a".repeat(11 * 1024 * 1024) });
    await expect(parseImportFile(fileOf("bomb.docx", "", huge))).rejects.toMatchObject({
      code: "too-large",
    });
  });
});

describe("mergeImport", () => {
  it("puts the typed text first, then each file under its name, and the images apart", () => {
    const m = mergeImport("  I am Mei. ", [
      { kind: "text", name: "cv.pdf", text: "Nurse" },
      { kind: "image", name: "a.png", dataUrl: "data:image/jpeg;base64,AA" },
    ]);
    expect(m).toEqual({
      text: "I am Mei.\n\n--- cv.pdf ---\nNurse",
      images: ["data:image/jpeg;base64,AA"],
      truncated: false,
    });
  });

  it("caps the text and the images, and says so", () => {
    const imgs = Array.from({ length: IMPORT.maxImages + 2 }, (_, i) => ({
      kind: "image" as const,
      name: `${i}.png`,
      dataUrl: `data:image/jpeg;base64,${i}`,
    }));
    const m = mergeImport("x".repeat(IMPORT.maxTextChars + 10), imgs);
    expect(m.text.length).toBe(IMPORT.maxTextChars);
    expect(m.images).toHaveLength(IMPORT.maxImages);
    expect(m.truncated).toBe(true);
    expect(mergeImport("", imgs.slice(0, 1)).truncated).toBe(false);
  });
});

describe("the extraction schema and its validation", () => {
  it("the schema names exactly the self-intro fields", () => {
    expect(FACTS_JSON_SCHEMA.properties.facts.items.properties.field.enum).toEqual([
      ...SELF_INTRO_FIELDS,
    ]);
    expect(Object.values(emptyFields())).toEqual(SELF_INTRO_FIELDS.map(() => ""));
  });

  it("keeps valid facts, trims them, drops unknown fields, empties and repeats", () => {
    const facts = parseFactsAnswer(
      JSON.stringify({
        facts: [
          { field: "name", value: "  Mei   Example ", certain: true },
          { field: "hobby", value: "bouldering", certain: true },
          { field: "hobby", value: "Bouldering", certain: true },
          { field: "salary", value: "secret", certain: true },
          { field: "age", value: "", certain: true },
          { field: "from", value: "Exampleton", certain: false },
          { field: "occupation", value: 42 },
          "junk",
          { field: "languages", value: "x".repeat(500) },
        ],
      }),
    );
    expect(facts).toEqual([
      { field: "name", value: "Mei Example", certain: true },
      { field: "hobby", value: "bouldering", certain: true },
      { field: "from", value: "Exampleton", certain: false },
      { field: "languages", value: "x".repeat(IMPORT.maxFieldChars), certain: true },
    ]);
  });

  it("tolerates a code fence or prose around the JSON", () => {
    const body = '{"facts":[{"field":"age","value":"30","certain":true}]}';
    expect(parseFactsAnswer("```json\n" + body + "\n```")).toHaveLength(1);
    expect(parseFactsAnswer("Here you go: " + body + " done")).toHaveLength(1);
  });

  it("is null for anything that is not {facts: [...]}", () => {
    expect(parseFactsAnswer("no json here")).toBeNull();
    expect(parseFactsAnswer("{broken")).toBeNull();
    expect(parseFactsAnswer("oops {not: json}")).toBeNull();
    expect(parseFactsAnswer('{"name":"Mei"}')).toBeNull();
    expect(parseFactsAnswer("null")).toBeNull();
  });

  it("keeps at most maxFacts", () => {
    const many = Array.from({ length: IMPORT.maxFacts + 5 }, (_, i) => ({
      field: "hobby",
      value: `h${i}`,
      certain: true,
    }));
    expect(parseFactsAnswer(JSON.stringify({ facts: many }))).toHaveLength(IMPORT.maxFacts);
  });

  it("checks the request: image data URLs only, within the caps", () => {
    expect(ImportRequest.safeParse({ text: "hi" }).success).toBe(true);
    expect(ImportRequest.safeParse({ images: ["https://example.com/a.png"] }).success).toBe(false);
    expect(ImportRequest.safeParse({ images: ["data:image/svg+xml;base64,AA"] }).success).toBe(
      false,
    );
    expect(ImportRequest.safeParse({ text: "x".repeat(IMPORT.maxTextChars + 1) }).success).toBe(
      false,
    );
    expect(ImportRequest.safeParse({ text: "a", locale: "en; drop" }).success).toBe(false);
  });
});

/** A model stand-in: records each call's body, answers `content`. */
function fakeModel(
  content: string | Error,
  usage = { prompt_tokens: 1000, completion_tokens: 100 },
) {
  const calls: Record<string, unknown>[] = [];
  const complete: Complete = async (body) => {
    calls.push(body);
    if (content instanceof Error) throw content;
    return { choices: [{ message: { content } }], usage };
  };
  return { calls, complete };
}

let logs: string[] = [];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
/** Capture console.log/error for each test of the calling describe (scoped there, not file-wide). */
function captureLogs() {
  beforeEach(() => {
    logs = [];
    const rec = (...a: unknown[]) =>
      void logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    logSpy = spyOn(console, "log").mockImplementation(rec);
    errSpy = spyOn(console, "error").mockImplementation(rec);
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
}

describe("extractSelfIntro (mocked model)", () => {
  captureLogs();
  const answer = JSON.stringify({
    facts: [
      { field: "name", value: "Mei Example-Tanaka", certain: true },
      { field: "occupation", value: "nurse", certain: true },
    ],
  });

  it("sends one call with the material, the images and the schema; answers the facts", async () => {
    const m = fakeModel(answer);
    const r = await extractSelfIntro(
      { text: MATERIAL, images: ["data:image/jpeg;base64,AAAA"], locale: "ja" },
      { userId: "u1", complete: m.complete, now: new Date("2026-11-05T00:00:00Z") },
    );
    expect(r).toEqual({
      ok: true,
      facts: [
        { field: "name", value: "Mei Example-Tanaka", certain: true },
        { field: "occupation", value: "nurse", certain: true },
      ],
    });
    expect(m.calls).toHaveLength(1);
    const body = m.calls[0] as {
      messages: { role: string; content: unknown }[];
      response_format: { json_schema: { schema: unknown } };
    };
    expect(body.response_format.json_schema.schema).toBe(FACTS_JSON_SCHEMA);
    expect(String(body.messages[0]!.content)).toContain("Japanese");
    expect(String(body.messages[0]!.content)).toContain("2026-11-05");
    const user = body.messages[1]!.content as { type: string }[];
    expect(user.map((p) => p.type)).toEqual(["text", "image_url"]);
  });

  it("logs the cost only: never the material, never the answer", async () => {
    await extractSelfIntro(
      { text: MATERIAL, images: [] },
      { userId: "u1", complete: fakeModel(answer).complete },
    );
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      event: "credits.unmetered",
      what: "self-intro.import",
    });
    for (const l of logs) {
      expect(l).not.toContain("Mei");
      expect(l).not.toContain("nurse");
    }
  });

  it("an image-only import says the material is in the images", () => {
    const msgs = importMessages({ text: "", images: ["data:image/png;base64,AA"] }, "2026-11-05");
    const user = msgs[1]!.content as { type: string; text?: string }[];
    expect(user[0]!.text).toContain("image");
    expect(String(msgs[0]!.content)).toContain("the language of the material");
  });

  it("empty material makes no call; a failed or unusable answer is model-failed, logged without content", async () => {
    const m = fakeModel(answer);
    expect(
      await extractSelfIntro({ text: "  ", images: [] }, { userId: "u", complete: m.complete }),
    ).toEqual({
      ok: false,
      error: "empty",
    });
    expect(m.calls).toHaveLength(0);
    const boom = fakeModel(new Error(`provider echoed: ${MATERIAL}`));
    expect(
      await extractSelfIntro(
        { text: MATERIAL, images: [] },
        { userId: "u", complete: boom.complete },
      ),
    ).toEqual({ ok: false, error: "model-failed" });
    expect(logs.join("\n")).not.toContain("Mei");
    const junk = fakeModel("I cannot help", { prompt_tokens: 0, completion_tokens: 0 });
    expect(
      await extractSelfIntro(
        { text: MATERIAL, images: [] },
        { userId: "u", complete: junk.complete },
      ),
    ).toEqual({ ok: false, error: "model-failed" });
  });
});

describe("POST /api/self-intro/import (handleImport)", () => {
  captureLogs();
  const answer = JSON.stringify({ facts: [{ field: "hobby", value: "baking", certain: true }] });
  let n = 0;
  const deps = (over: Partial<ImportDeps> = {}): ImportDeps => ({
    user: { id: `user-${++n}`, email: "someone@example.com" },
    owner: false,
    flags: { "self-intro.import": true },
    configured: true,
    complete: fakeModel(answer).complete,
    ...over,
  });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://lianki.com/api/self-intro/import", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://lianki.com",
        host: "lianki.com",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("answers the facts", async () => {
    const r = await handleImport(post({ text: MATERIAL }), deps());
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ facts: [{ field: "hobby", value: "baking", certain: true }] });
  });

  it("refuses a cross-site post, a guest, and anyone but the owner while the flag is off", async () => {
    expect(
      (await handleImport(post({ text: "a" }, { origin: "https://evil.example" }), deps())).status,
    ).toBe(403);
    expect((await handleImport(post({ text: "a" }), deps({ user: null }))).status).toBe(401);
    expect((await handleImport(post({ text: "a" }), deps({ flags: {} }))).status).toBe(404);
    expect((await handleImport(post({ text: "a" }), deps({ flags: {}, owner: true }))).status).toBe(
      200,
    );
  });

  it("gates on the flag: on for all, else the owner only", () => {
    expect(selfIntroImportOn({}, false)).toBe(false);
    expect(selfIntroImportOn({}, true)).toBe(true);
    expect(selfIntroImportOn({ "self-intro.import": true }, false)).toBe(true);
    expect(FLAGS["self-intro.import"].default).toBe(false);
  });

  it("refuses a too-large body, bad JSON, a bad image, empty material and an unconfigured model", async () => {
    expect(
      (
        await handleImport(
          post({ text: "a" }, { "content-length": String(IMPORT.maxBodyBytes + 1) }),
          deps(),
        )
      ).status,
    ).toBe(413);
    expect(
      (await handleImport(post({ text: "x".repeat(IMPORT.maxTextChars + 1) }), deps())).status,
    ).toBe(413);
    expect((await handleImport(post("{nope"), deps())).status).toBe(400);
    expect((await handleImport(post({ images: ["file:///etc/passwd"] }), deps())).status).toBe(400);
    expect((await handleImport(post({ text: " " }), deps())).status).toBe(400);
    expect((await handleImport(post({ text: "a" }), deps({ configured: false }))).status).toBe(503);
    const failing = deps({ complete: fakeModel(new Error("down")).complete });
    expect((await handleImport(post({ text: "a" }), failing)).status).toBe(502);
  });

  it("rate-limits per user", async () => {
    const d = deps();
    let last = 0;
    for (let i = 0; i <= IMPORT.rate.max; i++)
      last = (await handleImport(post({ text: "a" }), d)).status;
    expect(last).toBe(429);
  });

  it("writes nothing anywhere: no D1 or R2 in its code, the material in no log", async () => {
    // The model is the injected stand-in: the handler has no other way out.
    const r = await handleImport(
      post({ text: MATERIAL, images: ["data:image/jpeg;base64,AAAA"] }),
      deps(),
    );
    expect(r.status).toBe(200);
    expect(logs.join("\n")).not.toContain("Mei");
    expect(logs.join("\n")).not.toContain("AAAA");
    // The import's server code holds no storage: no D1, no R2 bucket, no cache, no put.
    for (const f of [
      "lib/self-intro/import-handler.ts",
      "lib/self-intro/import-extract.ts",
      "lib/self-intro/import-config.ts",
      "app/api/self-intro/import/route.ts",
    ]) {
      // Code only: the comments may well say "nothing is written to D1 or R2".
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(src).not.toMatch(
        /@\/lib\/d1|getD1|getCloudflareContext|BLOBS|R2|\.put\(|\.prepare\(|caches\.|ttsCache|inbox\/store/,
      );
    }
  });
});
