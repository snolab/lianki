import { db } from "../db-edge";
export const runtime = "edge";
export const GET = async () => {
  return new Response(String(await db.collection("test").countDocuments({})));
};
