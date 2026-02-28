import { fsrsHandler } from "@/app/fsrs";
import { authEmailOrToken } from "@/lib/authEmailOrToken";

export const dynamic = "force-dynamic";
// export const runtime = 'edge'

const handle = async (req: Request) => {
  const email = await authEmailOrToken(req);
  if (!email) return Response.json({ error: "Login required" }, { status: 401 });

  return fsrsHandler(req, email).catch((error) => {
    // Generate unique error ID for tracking
    const errorId = crypto.randomUUID();

    // Structured error logging
    console.error(`[ERROR ${errorId}]`, {
      error: error?.message || String(error),
      stack: error?.stack,
      email,
      url: req.url,
      method: req.method,
      timestamp: new Date().toISOString(),
      cause: error?.cause,
    });

    // Return structured error response
    return Response.json(
      {
        error: "Internal server error",
        errorId,
        timestamp: new Date().toISOString(),
        // Include error details in development mode
        ...(process.env.NODE_ENV === "development" && {
          message: error?.message,
          details: String(error),
        }),
      },
      { status: 500 }
    );
  });
};

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const PATCH = handle;
