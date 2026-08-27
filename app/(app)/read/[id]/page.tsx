import { appLocale } from "@/lib/app-locale.server";
import { ReadViewClient } from "./ReadViewClient";
import { authUserOrNull } from "@/app/signInEmail";

export default async function ReadMaterialPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const locale = await appLocale();
  const user = await authUserOrNull();

  return (
    <div className="flex flex-col">
      <div className="flex-grow px-4 sm:px-6 lg:px-8 py-8">
        <div className="max-w-4xl mx-auto">
          <ReadViewClient id={id} locale={locale} isLoggedIn={!!user} />
        </div>
      </div>
    </div>
  );
}
