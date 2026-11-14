import { authUserOrNull } from "@/app/signInEmail";
import { isDev } from "@/lib/permissions";
import { hubDiagnostics } from "@/lib/hub-diagnostics";
export async function GET() {
  if (!isDev((await authUserOrNull())?.email)) return new Response(null, { status: 404 });
  const diagnostics = await hubDiagnostics();
  return Response.json(diagnostics ?? { error: "unavailable" }, {
    status: diagnostics ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
