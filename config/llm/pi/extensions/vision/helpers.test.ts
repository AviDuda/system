import { describe, expect, test } from "bun:test";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import {
  buildVisionMessages,
  extractImageParts,
  formatDescription,
  hasImageContent,
  IMAGE_EXTENSIONS,
  imageLabel,
  isImageFile,
  mimeTypeForPath,
  modelSupportsImage,
} from "./helpers";

// ── isImageFile ──

describe("isImageFile", () => {
  test.each([
    ["photo.png", true],
    ["photo.JPG", true],
    ["photo.Jpeg", true],
    ["animation.gif", true],
    ["photo.webp", true],
    ["bitmap.bmp", true],
    ["icon.svg", true],
    ["icon.ico", true],
    ["scan.tiff", true],
    ["scan.tif", true],
    ["document.pdf", false],
    ["script.sh", false],
    ["noextension", false],
    [".gitignore", false],
    ["archive.tar.gz", false],
    ["photo.png.jpg", true],
  ])("%s → %s", (path, expected) => {
    expect(isImageFile(path)).toBe(expected);
  });

  test("handles dotfiles correctly", () => {
    // .gitignore has no extension (the whole name is the "extension" in split terms)
    expect(isImageFile(".gitignore")).toBe(false);
  });

  test("handles paths with directories", () => {
    expect(isImageFile("/tmp/screenshots/capture.png")).toBe(true);
    expect(isImageFile("relative/path/to/image.webp")).toBe(true);
  });
});

// ── IMAGE_EXTENSIONS ──

describe("IMAGE_EXTENSIONS", () => {
  test("has all expected extensions", () => {
    expect(IMAGE_EXTENSIONS.has(".png")).toBe(true);
    expect(IMAGE_EXTENSIONS.has(".jpg")).toBe(true);
    expect(IMAGE_EXTENSIONS.has(".jpeg")).toBe(true);
    expect(IMAGE_EXTENSIONS.has(".gif")).toBe(true);
    expect(IMAGE_EXTENSIONS.has(".webp")).toBe(true);
    expect(IMAGE_EXTENSIONS.has(".bmp")).toBe(true);
    expect(IMAGE_EXTENSIONS.has(".svg")).toBe(true);
    expect(IMAGE_EXTENSIONS.has(".ico")).toBe(true);
    expect(IMAGE_EXTENSIONS.has(".tiff")).toBe(true);
    expect(IMAGE_EXTENSIONS.has(".tif")).toBe(true);
  });

  test("does not have non-image extensions", () => {
    expect(IMAGE_EXTENSIONS.has(".pdf")).toBe(false);
    expect(IMAGE_EXTENSIONS.has(".txt")).toBe(false);
    expect(IMAGE_EXTENSIONS.has(".mp4")).toBe(false);
  });
});

// ── hasImageContent ──

describe("hasImageContent", () => {
  test("returns true for image content", () => {
    const content = [{ type: "image" as const, data: "abc", mimeType: "image/png" }];
    expect(hasImageContent(content)).toBe(true);
  });

  test("returns false for text-only content", () => {
    const content = [{ type: "text" as const, text: "hello" }];
    expect(hasImageContent(content)).toBe(false);
  });

  test("returns true for mixed content", () => {
    const content = [
      { type: "text" as const, text: "description" },
      { type: "image" as const, data: "abc", mimeType: "image/png" },
    ];
    expect(hasImageContent(content)).toBe(true);
  });

  test("returns false for empty array", () => {
    expect(hasImageContent([])).toBe(false);
  });
});

// ── extractImageParts ──

describe("extractImageParts", () => {
  test("extracts only image content", () => {
    const content: Array<TextContent | ImageContent> = [
      { type: "text", text: "hello" },
      { type: "image", data: "img1", mimeType: "image/png" },
      { type: "text", text: "world" },
      { type: "image", data: "img2", mimeType: "image/jpeg" },
    ];
    const images = extractImageParts(content);
    expect(images).toHaveLength(2);
    expect(images[0].data).toBe("img1");
    expect(images[1].data).toBe("img2");
  });

  test("returns empty array for text-only content", () => {
    const content = [{ type: "text" as const, text: "hello" }];
    expect(extractImageParts(content)).toHaveLength(0);
  });

  test("returns empty array for empty content", () => {
    expect(extractImageParts([])).toHaveLength(0);
  });
});

// ── mimeTypeForPath ──

describe("mimeTypeForPath", () => {
  test.each([
    ["photo.png", "image/png"],
    ["photo.jpg", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["animation.gif", "image/gif"],
    ["photo.webp", "image/webp"],
    ["bitmap.bmp", "image/bmp"],
    ["icon.svg", "image/svg+xml"],
    ["icon.ico", "image/x-icon"],
    ["scan.tiff", "image/tiff"],
    ["scan.tif", "image/tiff"],
  ])("%s → %s", (path, expected) => {
    expect(mimeTypeForPath(path)).toBe(expected);
  });

  test("returns octet-stream for unknown extension", () => {
    expect(mimeTypeForPath("file.xyz")).toBe("application/octet-stream");
  });

  test("returns octet-stream for no extension", () => {
    expect(mimeTypeForPath("noextension")).toBe("application/octet-stream");
  });

  test("case insensitive extension", () => {
    expect(mimeTypeForPath("photo.PNG")).toBe("image/png");
    expect(mimeTypeForPath("photo.Jpg")).toBe("image/jpeg");
  });

  test("handles paths with directories", () => {
    expect(mimeTypeForPath("/tmp/screenshots/capture.png")).toBe("image/png");
  });
});

// ── buildVisionMessages ──

describe("buildVisionMessages", () => {
  test("builds user message with image and prompt", () => {
    const image: ImageContent = { type: "image", data: "base64data", mimeType: "image/png" };
    const messages = buildVisionMessages(image, "Describe this");

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toHaveLength(2);
    expect(messages[0].content[0]).toEqual({ type: "image", data: "base64data", mimeType: "image/png" });
    expect(messages[0].content[1]).toEqual({ type: "text", text: "Describe this" });
  });

  test("includes timestamp", () => {
    const image: ImageContent = { type: "image", data: "x", mimeType: "image/png" };
    const before = Date.now();
    const messages = buildVisionMessages(image, "test");
    const after = Date.now();
    expect(messages[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(messages[0].timestamp).toBeLessThanOrEqual(after);
  });
});

// ── imageLabel ──

describe("imageLabel", () => {
  test("single image", () => {
    expect(imageLabel(1, 0)).toBe("this image");
  });

  test("first of multiple", () => {
    expect(imageLabel(3, 0)).toBe("image 1");
  });

  test("second of multiple", () => {
    expect(imageLabel(3, 1)).toBe("image 2");
  });

  test("last of multiple", () => {
    expect(imageLabel(3, 2)).toBe("image 3");
  });
});

// ── formatDescription ──

describe("formatDescription", () => {
  test("with description", () => {
    expect(formatDescription("this image", "A blue square")).toBe("[Vision: this image]\nA blue square");
  });

  test("without description (null)", () => {
    expect(formatDescription("image 2", null)).toBe("[Vision: image 2 — vision model unavailable, cannot describe]");
  });

  test("with multi-word label", () => {
    expect(formatDescription("image 3", "Some text")).toBe("[Vision: image 3]\nSome text");
  });
});

// ── modelSupportsImage ──

describe("modelSupportsImage", () => {
  test("returns true when image in capabilities", () => {
    expect(modelSupportsImage(["text", "image"])).toBe(true);
  });

  test("returns false for text-only", () => {
    expect(modelSupportsImage(["text"])).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(modelSupportsImage(undefined)).toBe(false);
  });

  test("returns false for empty array", () => {
    expect(modelSupportsImage([])).toBe(false);
  });
});
