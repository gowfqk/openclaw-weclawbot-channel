// WeClawBot Bridge media helpers.
//
// Inbound: decode base64 media from the Bridge WS frame into a local file so
// OpenClaw can attach it to the agent turn (InboundMediaFacts.path).
// Outbound: load OpenClaw reply media (file:// or http(s) URLs) into a buffer
// and re-encode as the Bridge's base64 reply protocol.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---- types -----------------------------------------------------------------

export type InboundMediaKind = "image" | "video" | "audio" | "document";

export type SavedInboundMedia = {
  /** Absolute path of the file written to disk. */
  path: string;
  contentType: string;
  kind: InboundMediaKind;
  /** Basename of the written file (messageId.ext). */
  fileName: string;
};

export type OutboundReplyMedia = {
  data: Buffer;
  mediaType: string;
  mediaFileName?: string;
  mediaFormat?: string;
};

// ---- constants -------------------------------------------------------------

/** Safety cap for outbound media so an oversized reply cannot OOM the process. */
const MAX_OUTBOUND_MEDIA_BYTES = 25 * 1024 * 1024;
/** Upper bound on outbound attachments we are willing to walk. */
const MAX_OUTBOUND_MEDIA_ITEMS = 10;

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "svg", "ico",
]);
const VIDEO_EXTS = new Set([
  "mp4", "webm", "mov", "avi", "mkv", "m4v", "flv", "wmv",
]);
const VOICE_EXTS = new Set(["silk", "amr", "speex"]);
const AUDIO_EXTS = new Set([
  "mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "wma",
]);

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  m4v: "video/mp4",
  flv: "video/x-flv",
  wmv: "video/x-ms-wmv",
  silk: "audio/silk",
  amr: "audio/amr",
  speex: "audio/speex",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/opus",
  wma: "audio/x-ms-wma",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// ---- inbound: Bridge → OpenClaw -------------------------------------------

/**
 * Decode Bridge base64 media and persist it under the session store path so
 * OpenClaw can attach the local file to the agent turn. Returns null when the
 * frame carries no usable media.
 */
export async function saveInboundMedia(params: {
  storePath: string;
  media: unknown;
  mediaType?: string;
  mediaFileName?: string;
  mediaFormat?: string;
  messageId: string;
}): Promise<SavedInboundMedia | null> {
  const { storePath, media, mediaType, mediaFileName, mediaFormat, messageId } = params;
  const buf = decodeBase64Media(media);
  if (!buf || buf.length === 0) return null;

  const ext = resolveExtension({ mediaType, mediaFileName, mediaFormat, buf });
  const mediaDir = path.join(storePath, "media");
  await mkdir(mediaDir, { recursive: true });
  const fileName = `${messageId}.${ext}`;
  const filePath = path.join(mediaDir, fileName);
  await writeFile(filePath, buf);

  return {
    path: filePath,
    contentType: mimeForExtension(ext),
    kind: inboundKindFor(mediaType, ext),
    fileName,
  };
}

/** Placeholder text used when a media message arrives without a caption. */
export function mediaPlaceholder(media: SavedInboundMedia): string {
  switch (media.kind) {
    case "image":
      return "[图片]";
    case "video":
      return "[视频]";
    case "audio":
      return "[语音]";
    default:
      return `[文件:${media.fileName}]`;
  }
}

/** Bridge serializes media as base64; be liberal about what we accept. */
function decodeBase64Media(media: unknown): Buffer | null {
  if (!media) return null;
  if (typeof media === "string") return Buffer.from(media, "base64");
  if (Buffer.isBuffer(media)) return media;
  if (Array.isArray(media)) {
    return Buffer.from(media.filter((n): n is number => typeof n === "number"));
  }
  if (typeof media === "object") {
    const item = media as Record<string, unknown>;
    if (typeof item.data === "string") return Buffer.from(item.data, "base64");
    if (Buffer.isBuffer(item.data)) return item.data;
    if (Array.isArray(item.data)) {
      return Buffer.from(item.data.filter((n): n is number => typeof n === "number"));
    }
    if (Buffer.isBuffer(item.buffer)) return item.buffer;
  }
  return null;
}

/** Pick a file extension for the persisted media, from most to least reliable. */
function resolveExtension(params: {
  mediaType?: string;
  mediaFileName?: string;
  mediaFormat?: string;
  buf: Buffer;
}): string {
  const { mediaType, mediaFileName, mediaFormat, buf } = params;

  const formatExt = (mediaFormat ?? "").toLowerCase().replace(/^\./, "");
  if (formatExt && /^[a-z0-9]{1,10}$/.test(formatExt)) return formatExt;

  const nameExt = (mediaFileName ?? "").split(".").pop()?.toLowerCase();
  if (nameExt && /^[a-z0-9]{1,10}$/.test(nameExt)) return nameExt;

  const byType: Record<string, string> = {
    image: "png",
    video: "mp4",
    voice: "silk",
    audio: "mp3",
    file: "bin",
  };
  const typeExt = byType[(mediaType ?? "").toLowerCase()];
  if (typeExt) return typeExt;

  return sniffExtension(buf) ?? "bin";
}

/** Minimal magic-byte sniffing so unnamed media keeps a usable extension. */
function sniffExtension(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") return "wav";
  if (buf.toString("ascii", 4, 8) === "ftyp") return "mp4";
  if (buf.toString("ascii", 0, 3) === "ID3") return "mp3";
  if (buf.toString("ascii", 0, 4) === "OggS") return "ogg";
  if (buf.toString("ascii", 0, 5) === "%PDF-") return "pdf";
  return null;
}

function inboundKindFor(mediaType: string | undefined, ext: string): InboundMediaKind {
  const t = (mediaType ?? "").toLowerCase();
  if (t === "image" || IMAGE_EXTS.has(ext)) return "image";
  if (t === "video" || VIDEO_EXTS.has(ext)) return "video";
  if (t === "voice" || t === "audio" || VOICE_EXTS.has(ext) || AUDIO_EXTS.has(ext)) return "audio";
  return "document";
}

function mimeForExtension(ext: string): string {
  return EXT_MIME[ext] ?? "application/octet-stream";
}

// ---- outbound: OpenClaw → Bridge -------------------------------------------

/**
 * Load OpenClaw reply media into the Bridge reply protocol. Only the first
 * attachment can ride one WeChat reply; the remaining file names are returned
 * as a note so the user knows more media were produced.
 */
export async function loadOutboundReplyMedia(params: {
  mediaUrls: string[];
  log?: { warn?: (message: string) => void };
}): Promise<{ media: OutboundReplyMedia | null; note: string }> {
  const { mediaUrls, log } = params;
  const urls = mediaUrls
    .filter((u): u is string => typeof u === "string" && u.trim().length > 0)
    .slice(0, MAX_OUTBOUND_MEDIA_ITEMS);
  if (urls.length === 0) return { media: null, note: "" };

  let first: { data: Buffer; contentType?: string; fileName?: string } | null = null;
  const extraNames: string[] = [];

  for (const url of urls) {
    const loaded = await loadOutboundMedia(url.trim());
    if (!loaded) continue;
    if (!first) {
      first = loaded;
    } else {
      extraNames.push(loaded.fileName ?? urlFileName(url));
    }
  }

  if (!first) {
    log?.warn?.(`WeClawBot: could not load outbound media from any of ${urls.length} URL(s)`);
    return { media: null, note: "" };
  }
  if (first.data.length === 0) return { media: null, note: "" };
  if (first.data.length > MAX_OUTBOUND_MEDIA_BYTES) {
    log?.warn?.(`WeClawBot: outbound media exceeds ${MAX_OUTBOUND_MEDIA_BYTES} bytes, skipping`);
    return { media: null, note: "" };
  }

  const primaryUrl = urls[0];
  const mediaType = outboundMediaType(first.contentType, primaryUrl);
  const mediaFormat = urlExtension(primaryUrl);
  const mediaFileName = first.fileName ?? urlFileName(primaryUrl);

  const note =
    extraNames.length > 0
      ? `\n（另外 ${extraNames.length} 个附件：${extraNames.join("、")}。微信一次只能发送一个文件。）`
      : "";

  return {
    media: { data: first.data, mediaType, mediaFileName, mediaFormat },
    note,
  };
}

/** Load one outbound media reference (file:// URL, plain path, or http(s) URL). */
async function loadOutboundMedia(
  url: string,
): Promise<{ data: Buffer; contentType?: string; fileName?: string } | null> {
  try {
    if (url.startsWith("file://")) {
      const filePath = fileURLToPath(url);
      const data = await readFile(filePath);
      return { data, fileName: path.basename(filePath) };
    }
    if (/^https?:\/\//i.test(url)) {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = Buffer.from(await res.arrayBuffer());
      return {
        data,
        contentType: res.headers.get("content-type") ?? undefined,
        fileName: urlFileName(url),
      };
    }
    // Plain local path (OpenClaw workspace or absolute path).
    const data = await readFile(url);
    return { data, fileName: path.basename(url) };
  } catch {
    return null;
  }
}

function outboundMediaType(contentType: string | undefined, url: string): string {
  const ext = urlExtension(url);
  const t = (contentType ?? "").toLowerCase();
  if (t.startsWith("image/") || IMAGE_EXTS.has(ext)) return "image";
  if (t.startsWith("video/") || VIDEO_EXTS.has(ext)) return "video";
  if (VOICE_EXTS.has(ext)) return "voice";
  if (t.startsWith("audio/") || AUDIO_EXTS.has(ext)) return "audio";
  return "file";
}

function urlExtension(url: string): string {
  const clean = url.split(/[?#]/)[0] ?? url;
  const base = clean.split("/").pop() ?? "";
  const ext = base.includes(".") ? (base.split(".").pop() ?? "") : "";
  return ext.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function urlFileName(url: string): string {
  const clean = url.split(/[?#]/)[0] ?? url;
  const base = clean.split("/").pop() ?? "";
  try {
    return decodeURIComponent(base) || "file.bin";
  } catch {
    return base || "file.bin";
  }
}
