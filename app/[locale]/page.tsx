import { getIntlayer } from "intlayer";
import { locale as getLocale } from "next-intlayer/server";
import Link from "next/link";
import ContactForm from "../ContactForm";
import { Header } from "../components/Header";
import { authUser } from "../signInEmail";

export default async function LandingPage() {
  const locale = getLocale;
  const { appName, nav, hero, features, howItWorks, footer } = getIntlayer("landing-page", locale);
  const rawContact = getIntlayer("contact-form", locale);

  // Create plain object to ensure proper serialization to client component
  const contactContent = {
    title: rawContact.title,
    nameLabel: rawContact.nameLabel,
    namePlaceholder: rawContact.namePlaceholder,
    emailLabel: rawContact.emailLabel,
    emailPlaceholder: rawContact.emailPlaceholder,
    phoneLabel: rawContact.phoneLabel,
    phonePlaceholder: rawContact.phonePlaceholder,
    messageLabel: rawContact.messageLabel,
    messagePlaceholder: rawContact.messagePlaceholder,
    optional: rawContact.optional,
    template1: rawContact.template1,
    template2: rawContact.template2,
    template3: rawContact.template3,
    sendButton: rawContact.sendButton,
    sending: rawContact.sending,
    successMessage: rawContact.successMessage,
    errorMessage: rawContact.errorMessage,
  } as const;

  // Try to get user if logged in (optional)
  let user = null;
  try {
    user = await authUser();
  } catch (e) {
    // User not logged in, that's ok for landing page
  }

  return (
    <div className="flex flex-col min-h-screen">
      <Header
        locale={locale}
        appName={appName}
        blogLabel={nav.blog}
        learnLabel={nav.learn}
        user={user}
      />

      {/* Main Content */}
      <main className="flex-grow">
        {/* Hero Section */}
        <section className="py-12 px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-4xl font-bold mb-4">{hero.title}</h2>
          <p className="text-lg mb-8 max-w-2xl mx-auto">{hero.description}</p>
          <Link
            href={`/${locale}/list`}
            className="bg-blue-600 text-white font-bold py-3 px-6 rounded-lg hover:bg-blue-700"
          >
            {hero.cta}
          </Link>
        </section>

        {/* Features Section */}
        <section className="py-12 bg-gray-100 dark:bg-gray-900 px-4 sm:px-6 lg:px-8">
          <div className="max-w-4xl mx-auto">
            <h3 className="text-3xl font-bold text-center mb-8">{features.title}</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div className="text-center">
                <h4 className="text-xl font-semibold mb-2">{features.fsrs.title}</h4>
                <p>{features.fsrs.description}</p>
              </div>
              <div className="text-center">
                <h4 className="text-xl font-semibold mb-2">{features.browser.title}</h4>
                <p>{features.browser.description}</p>
              </div>
              <div className="text-center">
                <h4 className="text-xl font-semibold mb-2">{features.multiUser.title}</h4>
                <p>{features.multiUser.description}</p>
              </div>
            </div>
          </div>
        </section>

        {/* How to Use Section */}
        <section className="py-12 px-4 sm:px-6 lg:px-8">
          <div className="max-w-4xl mx-auto text-center">
            <h3 className="text-3xl font-bold mb-8">{howItWorks.title}</h3>
            <ol className="list-decimal list-inside max-w-lg mx-auto">
              <li className="mb-4">
                <a href="/lianki.user.js" className="text-blue-600 hover:underline">
                  {howItWorks.installLink}
                </a>{" "}
                {howItWorks.step1}
              </li>
              <li className="mb-4">{howItWorks.step2}</li>
              <li className="mb-4">{howItWorks.step3}</li>
              <li className="mb-4">{howItWorks.step4}</li>
            </ol>
          </div>
        </section>

        {/* Contact Section */}
        <ContactForm content={contactContent} />
      </main>

      {/* Footer */}
      <footer className="py-4 px-4 sm:px-6 lg:px-8 text-center">
        <p>
          © {new Date().getFullYear()} {footer.brand}
        </p>
      </footer>
    </div>
  );
}
