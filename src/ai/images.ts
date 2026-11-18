import { describeError, logger } from "../logger.js";
import type { ImageInput } from "./providers/index.js";

export interface AttachmentLike {
  url: string;
  contentType: string | null;
  size: number;
}

const SUPPORTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;

function mimeTypeOf(attachment: AttachmentLike): string | undefined {
  return attachment.contentType?.split(";")[0]?.trim().toLowerCase();
}

/** Picks up to MAX_IMAGES supported, reasonably small image attachments. */
export function selectImageAttachments<T extends AttachmentLike>(attachments: Iterable<T>): T[] {
  const selected: T[] = [];
  for (const attachment of attachments) {
    const type = mimeTypeOf(attachment);
    if (!type || !SUPPORTED_TYPES.has(type) || attachment.size > MAX_IMAGE_BYTES) continue;
    selected.push(attachment);
    if (selected.length >= MAX_IMAGES) break;
  }
  return selected;
}

/** Downloads images for vision models. Failed downloads are skipped, not fatal. */
export async function downloadImages(attachments: readonly AttachmentLike[]): Promise<ImageInput[]> {
  const results = await Promise.allSettled(attachments.map(async attachment => {
    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Image download failed with HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("Image is larger than the limit");
    return { mimeType: mimeTypeOf(attachment) ?? "image/png", data: buffer.toString("base64") };
  }));

  const images: ImageInput[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") images.push(result.value);
    else logger.warn("ai.image_download_failed", describeError(result.reason));
  }
  return images;
}
