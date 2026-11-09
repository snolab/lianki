import { squareCrop } from "@/lib/profile/avatar";
import { PROFILE } from "@/lib/profile/config";

/** Why a picked file was refused; the page words it. */
export type PickError = "bad-type" | "too-big";

const toBlob = (c: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((done) => c.toBlob(done, type, quality));

/**
 * The picked picture as a centred square, at most PROFILE.avatarSide px, in
 * WebP (JPEG where the browser can't encode WebP). Going through a canvas also
 * leaves behind EXIF, location included. The server still checks what it gets.
 */
export async function downscaleAvatar(file: File): Promise<Blob | PickError> {
  if (file.size > PROFILE.pickMaxBytes) return "too-big";
  if (/svg/i.test(file.type) || /\.svgz?$/i.test(file.name)) return "bad-type";
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return "bad-type"; // not an image this browser can decode
  }
  const { sx, sy, crop, out } = squareCrop(bitmap.width, bitmap.height, PROFILE.avatarSide);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "bad-type";
  // JPEG has no transparency; a transparent PNG would turn black.
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, out, out);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, crop, crop, 0, 0, out, out);
  bitmap.close();
  const webp = await toBlob(canvas, "image/webp", 0.85);
  const blob = webp?.type === "image/webp" ? webp : await toBlob(canvas, "image/jpeg", 0.85);
  if (!blob) return "bad-type";
  return blob.size > PROFILE.avatarMaxBytes ? "too-big" : blob;
}
