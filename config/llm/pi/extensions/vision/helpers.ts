/**
 * Pure logic for the vision extension.
 * No pi imports — testable independently.
 */

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

// ── Image detection ──

export const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".ico",
  ".tiff",
  ".tif",
]);

export function isImageFile(filePath: string): boolean {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return false;
  return IMAGE_EXTENSIONS.has(filePath.slice(lastDot).toLowerCase());
}

// ── Content analysis ──

export function hasImageContent(content: (TextContent | ImageContent)[]): boolean {
  return content.some((c) => c.type === "image");
}

export function extractImageParts(content: (TextContent | ImageContent)[]): ImageContent[] {
  return content.filter((c): c is ImageContent => c.type === "image");
}

// ── MIME type ──

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
};

export function mimeTypeForPath(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return "application/octet-stream";
  return MIME_MAP[filePath.slice(lastDot).toLowerCase()] ?? "application/octet-stream";
}

// ── Vision prompt construction ──

export const VISION_SYSTEM_PROMPT = `You are a vision assistant. Describe the provided image accurately and concisely.
Follow the user's instructions for what to focus on. If no specific instructions, provide:
- A clear description of what's visible
- Any text content (OCR) if present
- Layout/structure if it's a UI screenshot or diagram
Be factual. Don't guess at content you can't see clearly.`;

/** Build the messages array for a vision sidecar call. */
export function buildVisionMessages(image: ImageContent, prompt: string) {
  return [
    {
      role: "user" as const,
      content: [
        { type: "image" as const, data: image.data, mimeType: image.mimeType },
        { type: "text" as const, text: prompt },
      ],
      timestamp: Date.now(),
    },
  ];
}

/** Build the description label for image replacement in read results. */
export function imageLabel(total: number, index: number): string {
  return total === 1 ? "this image" : `image ${index + 1}`;
}

/** Format a vision description for embedding in tool result. */
export function formatDescription(label: string, description: string | null): string {
  if (description) {
    return `[Vision: ${label}]\n${description}`;
  }
  return `[Vision: ${label} — vision model unavailable, cannot describe]`;
}

// ── Model support check (pure version) ──

export function modelSupportsImage(inputCapabilities: string[] | undefined): boolean {
  return inputCapabilities?.includes("image") ?? false;
}
