import ContactForm from "./ContactForm";

export default function LandingPage() {
  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="py-4 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Lianki</h1>
          <nav className="flex items-center gap-6">
            <a href="/en/blog" className="text-lg font-medium hover:underline">
              Blog
            </a>
            <a href="/list" className="text-lg font-medium hover:underline">
              Go to App
            </a>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-grow">
        {/* Hero Section */}
        <section className="py-12 px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-4xl font-bold mb-4">
            Supercharge Your Learning with Spaced Repetition
          </h2>
          <p className="text-lg mb-8 max-w-2xl mx-auto">
            Lianki is a modern spaced repetition system designed for efficient flashcard review and
            long-term memorization.
          </p>
          <a
            href="/list"
            className="bg-blue-600 text-white font-bold py-3 px-6 rounded-lg hover:bg-blue-700"
          >
            Get Started for Free
          </a>
        </section>

        {/* Features Section */}
        <section className="py-12 bg-gray-100 dark:bg-gray-900 px-4 sm:px-6 lg:px-8">
          <div className="max-w-4xl mx-auto">
            <h3 className="text-3xl font-bold text-center mb-8">Key Features</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div className="text-center">
                <h4 className="text-xl font-semibold mb-2">FSRS Algorithm</h4>
                <p>Utilizes the powerful FSRS algorithm for optimal review scheduling.</p>
              </div>
              <div className="text-center">
                <h4 className="text-xl font-semibold mb-2">Browser Integration</h4>
                <p>Add flashcards from any webpage with our Tampermonkey userscript.</p>
              </div>
              <div className="text-center">
                <h4 className="text-xl font-semibold mb-2">Multi-User Support</h4>
                <p>
                  Sign in with Email, GitHub, or Google and keep your learning progress private.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* How to Use Section */}
        <section className="py-12 px-4 sm:px-6 lg:px-8">
          <div className="max-w-4xl mx-auto text-center">
            <h3 className="text-3xl font-bold mb-8">How It Works</h3>
            <ol className="list-decimal list-inside text-left max-w-lg mx-auto">
              <li className="mb-4">
                <a href="/lianki.user.js" className="text-blue-600 hover:underline">
                  Install the userscript
                </a>{" "}
                in your browser (Tampermonkey or Violentmonkey required).
              </li>
              <li className="mb-4">
                Use keyboard shortcuts (e.g., Alt+F) to add a webpage as a flashcard.
              </li>
              <li className="mb-4">Review your due cards daily with our simple interface.</li>
              <li className="mb-4">
                The FSRS algorithm schedules the next review based on your performance.
              </li>
            </ol>
          </div>
        </section>

        {/* Contact Section */}
        <ContactForm />
      </main>

      {/* Footer */}
      <footer className="py-4 px-4 sm:px-6 lg:px-8 text-center">
        <p>© {new Date().getFullYear()} Lianki</p>
      </footer>
    </div>
  );
}
