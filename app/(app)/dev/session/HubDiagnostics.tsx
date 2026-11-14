import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { hubDiagnostics } from "@/lib/hub-diagnostics";
/** An explicit page visit wakes the hub; this is not proof it was continuously active. */
export async function HubDiagnostics() {
  const locale = await appLocale();
  const d = getIntlayer("hub-diagnostics", locale as never);
  const data = await hubDiagnostics();
  return (
    <section className="rounded-lg border border-[oklch(70%_0_0/0.3)] p-4 space-y-3">
      <h2 className="text-xl font-semibold">{d.title}</h2>
      <p className="text-sm">{d.note}</p>
      {data ? (
        <pre className="overflow-auto text-xs">{JSON.stringify(data, null, 2)}</pre>
      ) : (
        <p>{d.unavailable}</p>
      )}
    </section>
  );
}
