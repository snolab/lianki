// export const runtime = "edge";
export const dynamic = "force-dynamic";

export const GET = async () => {
  try {
    const { db } = await import("../db");
    return new Response(String(await db.collection("test").countDocuments({})));
  } catch {
    return new Response("Database connection error", { status: 500 });
  }
};
