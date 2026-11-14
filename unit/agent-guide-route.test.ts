import { expect, test } from "bun:test";
import { GET } from "../app/api/agent-guide/route";

test("the public guide starts with chat scopes and study remains an explicit documentation choice", async () => {
  const response = GET(new Request("https://lianki.com/api/agent-guide?lang=en"));
  expect(response.status).toBe(200);
  const chat = await response.text();
  for (const scope of ["chat:read", "chat:write", "chat:ask"])
    expect(chat).toContain(`\`${scope}\``);
  expect(chat).not.toContain("GET /api/fsrs/due");
  expect(chat).not.toContain("`eval`");
  const study = await GET(
    new Request("https://lianki.com/api/agent-guide?scopes=study&lang=en"),
  ).text();
  expect(study).toContain("GET /api/fsrs/due");
  expect(study).not.toContain("POST /api/version/chat");
});
