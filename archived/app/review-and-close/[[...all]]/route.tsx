import { fsrsHandlerWithAuth } from "./fsrsHandlerWithAuth";
export const dynamic = "force-dynamic";
// export const runtime = 'edge'
export const GET = fsrsHandlerWithAuth;
export const POST = fsrsHandlerWithAuth;
export const DELETE = fsrsHandlerWithAuth;
