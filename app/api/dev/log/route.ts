import { NextRequest, NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";

/**
 * The owner's device, live: a page opened with ?debug=1 posts what it is
 * doing here, and it lands in the Worker logs (`wrangler tail lianki`) for a
 * remote debugging session. Owner only; anyone else gets a 404.
 */
const MAX_BODY = 4096;

export const POST = async (req: NextRequest) => {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await req.text()).slice(0, MAX_BODY);
  console.log(JSON.stringify({ msg: "dev.client", ua: req.headers.get("user-agent"), body }));
  return new NextResponse(null, { status: 204 });
};
