"use client";

export default function ListError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="max-w-xl w-full bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6">
        <h2 className="text-xl font-bold text-red-800 dark:text-red-200 mb-2">List page error</h2>
        <pre className="text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap break-words mb-4">
          {error.message}
        </pre>
        {error.digest && (
          <p className="text-xs text-red-500 mb-4">Digest: {error.digest}</p>
        )}
        <button
          onClick={reset}
          className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
