import { fsrsHandlerWithAuth } from "./fsrsHandlerWithAuth";
export const dynamic = "force-dynamic";
// export const runtime = 'edge'
export const GET = async () => {
  return new Response("405 method not allowed", { status: 405 });
};
export const POST = fsrsHandlerWithAuth;
export const DELETE = fsrsHandlerWithAuth;
