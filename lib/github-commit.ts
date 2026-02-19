const REPO = "snomiao/lianki";
const BRANCH = "main";
const GITHUB_API = "https://api.github.com";

function ghHeaders() {
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (!token) throw new Error("GITHUB_PERSONAL_ACCESS_TOKEN not set");
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function getFileSha(path: string): Promise<string | undefined> {
  const url = `${GITHUB_API}/repos/${REPO}/contents/${path}?ref=${BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { sha: string };
  return data.sha;
}

export async function commitFile(path: string, content: string, message: string): Promise<void> {
  const sha = await getFileSha(path);
  const url = `${GITHUB_API}/repos/${REPO}/contents/${path}`;

  const body: Record<string, string> = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: ghHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub commit failed: ${res.status} ${err}`);
  }
}
