"use client";
import { useEffect, useState } from "react";
import { FSRSNote } from "@/app/fsrs";

/**
 *
 * @author: snomiao <snomiao@gmail.com>
 */
export default function AddNoteClient() {
  // read url from url's hash, once
  const sp = new URLSearchParams(globalThis.location?.hash?.slice(1) ?? "");
  const url = sp.get("url");
  const title = sp.get("title");
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
      <>Adding... {url}</>
      <br />
      {resp && <pre>{JSON.stringify(resp, null, 2)}</pre>}
    </>
  );
}
