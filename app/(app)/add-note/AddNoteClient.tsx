"use client";
import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { FSRSNote } from "@/app/fsrs";
import { firstUrl } from "@/lib/nav/nav-core";

/**
 *
 * @author: snomiao <snomiao@gmail.com>
 */
export default function AddNoteClient() {
  const { adding } = useIntlayer("add-note-page");
  // The url from the hash (the userscript, the nav's search), once; else from
  // the query, where the PWA share target puts it (public/manifest.json). A
  // share sheet often sends the link inside `text` rather than `url`.
  const sp = new URLSearchParams(globalThis.location?.hash?.slice(1) ?? "");
  const q = new URLSearchParams(globalThis.location?.search ?? "");
  const url = sp.get("url") || q.get("url") || firstUrl(q.get("text"));
  const title = sp.get("title") || q.get("title");
  const [resp, setResp] = useState<FSRSNote & { _id: string }>();
  useEffect(() => {
    if (!url) return;
    // add url to database
    // ...
    (async function () {
      const note = await (
        await fetch("/api/fsrs/add", {
          method: "POST",
          body: JSON.stringify({ url, title }),
          headers: { "content-type": "application/json" },
        })
      ).json();
      setResp(note);

      const q = new URLSearchParams({
        id: note._id.toString(),
      }).toString();
      if (globalThis?.location?.href) {
        window.location.href = `/repeat/?${q}`;
      }
    })();
    // redirect to home page
    // window.location.href = "/";
  }, [url, title]);

  return (
    <>
      <>
        {adding} {url}
      </>
      <br />
      {resp && <pre>{JSON.stringify(resp, null, 2)}</pre>}
    </>
  );
}
