import { getIntlayer } from "intlayer";
import { getLocale } from "next-intlayer/server";
import Link from "next/link";
import ContactForm from "../ContactForm";
import { LanguageSwitcher } from "../components/LanguageSwitcher";

export default async function LandingPage() {
  const locale = await getLocale();
  const { appName, nav, hero, features, howItWorks, footer } = getIntlayer("landing-page", locale);
  const contactData = getIntlayer("contact-form", locale);

  // Ensure all values are serializable strings for SSR using template literals
  const contactContent = {
    title: `${contactData.title}`,
    nameLabel: `${contactData.nameLabel}`,
    namePlaceholder: `${contactData.namePlaceholder}`,
    emailLabel: `${contactData.emailLabel}`,
    emailPlaceholder: `${contactData.emailPlaceholder}`,
    phoneLabel: `${contactData.phoneLabel}`,
    phonePlaceholder: `${contactData.phonePlaceholder}`,
    messageLabel: `${contactData.messageLabel}`,
    messagePlaceholder: `${contactData.messagePlaceholder}`,
    optional: `${contactData.optional}`,
    template1: `${contactData.template1}`,
    template2: `${contactData.template2}`,
    template3: `${contactData.template3}`,
    sendButton: `${contactData.sendButton}`,
    sending: `${contactData.sending}`,
    successMessage: `${contactData.successMessage}`,
    errorMessage: `${contactData.errorMessage}`,
  };

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="py-4 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">{appName}</h1>
          <nav className="flex items-center gap-6">
            <Link href={`/${locale}/blog`} className="text-lg font-medium hover:underline">
              {nav.blog}
            </Link>
            <Link href={`/${locale}/polyglot`} className="text-lg font-medium hover:underline">
              {nav.polyglot}
            </Link>
            <Link href={`/${locale}/list`} className="text-lg font-medium hover:underline">
              {nav.learn}
            </Link>
            <LanguageSwitcher />
          </nav>
        </div>
      </header>

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
            <ol className="list-decimal list-inside text-left max-w-lg mx-auto">
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
