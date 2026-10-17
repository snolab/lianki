/**
 * Persists generated blog translations as commits on one rolling PR.
 *
 * Why a PR: `main` cannot be committed to directly — branch protection has
 * `enforce_admins` on and requires CI (docs/shipping.md). The old keyv-github
 * cache wrote straight to `main`, so once the Worker took over (and with no
 * GITHUB_INTL_TOKEN set) nothing was saved at all.
 *
 * Why ONE branch: every translation also has to update lib/blog.corpus.json
 * (the Worker's only copy of the blog). Parallel PRs would all edit that file
 * and conflict; commits stacked on one branch, each rebuilt from the branch's
 * own corpus, never do. A person reviews and merges the PR; the next
 * translation after that resets the branch to `main` and opens a fresh one.
 *
 * Known gap: two translations finishing at the same moment with no PR open can
 * both reset the branch, and one commit may be lost. It is regenerated on the
 * next visit, so this is not worth a lock.
 *
 * Only finished translations are committed — partial saves are what left
 * truncated files in blog/ before.
 */
import { Octokit } from "octokit";
import { insertIntoCorpus } from "./blog-corpus-insert";

const OWNER = "snolab";
const REPO = "lianki";
export const TRANSLATIONS_BRANCH = "translations/auto";
const CORPUS_PATH = "lib/blog.corpus.json";

export function translationToken(): string | null {
  return process.env.GITHUB_INTL_TOKEN?.trim() || null;
}

const status = (e: unknown) => (e as { status?: number })?.status;

/**
 * Read a file as text. `raw` works up to 100 MB; the default JSON response
 * stops inlining content at 1 MB, which the corpus will eventually exceed.
 */
async function readText(gh: Octokit, path: string, ref: string): Promise<string | null> {
  try {
    const res = await gh.rest.repos.getContent({
      owner: OWNER,
      repo: REPO,
      path,
      ref,
      mediaType: { format: "raw" },
    });
    return res.data as unknown as string;
  } catch (e) {
    if (status(e) === 404) return null;
    throw e;
  }
}

/** A translation committed to the open PR but not yet deployed, if any. */
export async function getPendingTranslation(
  token: string,
  locale: string,
  slug: string,
): Promise<string | null> {
  const gh = new Octokit({ auth: token });
  return readText(gh, `blog/${locale}/${slug}.md`, TRANSLATIONS_BRANCH);
}

async function openPr(gh: Octokit) {
  const { data } = await gh.rest.pulls.list({
    owner: OWNER,
    repo: REPO,
    head: `${OWNER}:${TRANSLATIONS_BRANCH}`,
    state: "open",
  });
  return data[0] ?? null;
}

/** Point the branch at `main`, creating it if needed (a merged PR may leave it behind). */
async function resetBranchToMain(gh: Octokit) {
  const { data: main } = await gh.rest.git.getRef({ owner: OWNER, repo: REPO, ref: "heads/main" });
  try {
    await gh.rest.git.createRef({
      owner: OWNER,
      repo: REPO,
      ref: `refs/heads/${TRANSLATIONS_BRANCH}`,
      sha: main.object.sha,
    });
  } catch (e) {
    if (status(e) !== 422) throw e; // 422 = already exists
    await gh.rest.git.updateRef({
      owner: OWNER,
      repo: REPO,
      ref: `heads/${TRANSLATIONS_BRANCH}`,
      sha: main.object.sha,
      force: true,
    });
  }
}

/** One commit holding the translation and the corpus rebuilt from the branch's own copy. */
async function commitTranslation(gh: Octokit, locale: string, slug: string, content: string) {
  for (let attempt = 0; ; attempt++) {
    const { data: ref } = await gh.rest.git.getRef({
      owner: OWNER,
      repo: REPO,
      ref: `heads/${TRANSLATIONS_BRANCH}`,
    });
    const parent = ref.object.sha;
    const { data: commit } = await gh.rest.git.getCommit({
      owner: OWNER,
      repo: REPO,
      commit_sha: parent,
    });
    const corpus = await readText(gh, CORPUS_PATH, parent);
    if (corpus == null) throw new Error(`${CORPUS_PATH} missing on ${TRANSLATIONS_BRANCH}`);

    const { data: tree } = await gh.rest.git.createTree({
      owner: OWNER,
      repo: REPO,
      base_tree: commit.tree.sha,
      tree: [
        { path: `blog/${locale}/${slug}.md`, mode: "100644", type: "blob", content },
        {
          path: CORPUS_PATH,
          mode: "100644",
          type: "blob",
          content: insertIntoCorpus(corpus, `${locale}/${slug}`, content),
        },
      ],
    });
    const { data: next } = await gh.rest.git.createCommit({
      owner: OWNER,
      repo: REPO,
      message: `docs(blog): ${locale} translation of ${slug}`,
      tree: tree.sha,
      parents: [parent],
    });
    try {
      await gh.rest.git.updateRef({
        owner: OWNER,
        repo: REPO,
        ref: `heads/${TRANSLATIONS_BRANCH}`,
        sha: next.sha,
      });
      return;
    } catch (e) {
      // 422 = not a fast-forward: another translation landed first. Rebuild on top of it.
      if (status(e) !== 422 || attempt >= 2) throw e;
    }
  }
}

/** Opened for a human to review and merge — machine output never lands on `main` unreviewed. */
async function openReviewPr(gh: Octokit) {
  try {
    await gh.rest.pulls.create({
      owner: OWNER,
      repo: REPO,
      base: "main",
      head: TRANSLATIONS_BRANCH,
      title: "docs(blog): machine translations",
      body:
        "Translations generated on demand by `/api/translate`, one commit each.\n\n" +
        "Review and merge when ready; translations generated meanwhile are added to this PR.",
    });
  } catch (e) {
    // 422 = a concurrent request opened it first.
    if (status(e) !== 422) throw e;
  }
}

export async function persistTranslation(
  token: string,
  locale: string,
  slug: string,
  content: string,
): Promise<void> {
  const gh = new Octokit({ auth: token });
  const existing = await openPr(gh);
  if (!existing) await resetBranchToMain(gh);
  await commitTranslation(gh, locale, slug, content);
  if (!existing) await openReviewPr(gh);
}
