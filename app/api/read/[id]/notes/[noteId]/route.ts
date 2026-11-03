import { NextResponse } from "next/server";
import { badRequest, bodyOf, json, notFound, readerCtx } from "@/lib/read/reader-route";
import { deleteNote, NOTE_MAX_CHARS, updateNote } from "@/lib/read/reader-store";

type Params = { params: Promise<{ id: string; noteId: string }> };

/** PATCH /api/read/[id]/notes/[noteId] — new text; the old one goes to its history. */
export async function PATCH(req: Request, { params }: Params) {
  const { id, noteId } = await params;
  const ctx = await readerCtx(id);
  if (ctx instanceof NextResponse) return ctx;
  const b = (await bodyOf(req)) as { text?: unknown } | null;
  const text = typeof b?.text === "string" ? b.text.trim() : "";
  if (!text) return badRequest("text is required");
  if (text.length > NOTE_MAX_CHARS) return badRequest("note too long");
  const note = await updateNote(ctx.db, ctx.userId, ctx.ref.bookHash, noteId, text, new Date());
  return note ? json(note) : notFound();
}

/** DELETE /api/read/[id]/notes/[noteId] — soft delete. */
export async function DELETE(_req: Request, { params }: Params) {
  const { id, noteId } = await params;
  const ctx = await readerCtx(id);
  if (ctx instanceof NextResponse) return ctx;
  const ok = await deleteNote(ctx.db, ctx.userId, ctx.ref.bookHash, noteId, new Date());
  return ok ? json({ success: true }) : notFound();
}
