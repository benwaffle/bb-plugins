import { homedir } from "node:os";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { REALTIME_CHANNEL } from "./channel.js";
import { rpcContract, type ApplyInput, type WallpaperState } from "./contract.js";
import { ImageFileError, createImageReader } from "./image.js";
import {
  BLUR_MAX,
  DIM_MAX,
  blurSchema,
  dimSchema,
  imagePathSchema,
  imageUrl,
  resolveImagePath,
} from "./model.js";

export { rpcContract };

/** Long enough that a hashed URL never revalidates; a new file gets a new URL. */
const IMMUTABLE = "private, max-age=31536000, immutable";

export default function plugin(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Show wallpaper",
      default: true,
    },
    imagePath: {
      type: "string",
      label: "Image path",
      description: "Absolute path to a JPEG, PNG, WebP, GIF, or AVIF file. Empty shows no wallpaper.",
      experimental_schema: imagePathSchema,
      default: "",
    },
    dim: {
      type: "number",
      label: "Dim (%)",
      description: `Darkens the image, 0 to ${DIM_MAX}.`,
      experimental_schema: dimSchema,
      default: 0,
    },
    blur: {
      type: "number",
      label: "Blur (px)",
      description: `Blurs the image, 0 to ${BLUR_MAX}.`,
      experimental_schema: blurSchema,
      default: 0,
    },
  });
  const images = createImageReader();

  settings.onChange(() => bb.realtime.publish(REALTIME_CHANNEL, null));

  async function state(): Promise<WallpaperState> {
    const { enabled, imagePath, dim, blur } = await settings.get();
    const base = { enabled, path: imagePath, dim, blur };
    if (imagePath === "") return { ...base, image: null, error: null };
    try {
      const file = await images.describe(imagePath);
      return {
        ...base,
        image: { url: imageUrl(bb.pluginId, file.hash), hash: file.hash, mime: file.mime, bytes: file.bytes },
        error: null,
      };
    } catch (error) {
      if (error instanceof ImageFileError) return { ...base, image: null, error: error.message };
      throw error;
    }
  }

  async function apply(input: ApplyInput, cwd: string | undefined): Promise<WallpaperState> {
    const path = resolveImagePath(input.path, homedir(), cwd);
    if (path === null) {
      throw new PluginCliError(`${input.path} is relative`, {
        code: "relative_path",
        hint: "Pass an absolute path or one starting with `~/`.",
      });
    }
    try {
      await images.describe(path);
    } catch (error) {
      if (error instanceof ImageFileError) throw new PluginCliError(error.message, { code: error.code });
      throw error;
    }
    await settings.experimental_set({
      imagePath: path,
      enabled: true,
      ...(input.dim === undefined ? {} : { dim: input.dim }),
      ...(input.blur === undefined ? {} : { blur: input.blur }),
    });
    // Re-applying the same path after the file changed leaves the settings
    // equal, so onChange stays quiet; windows still need the new hash.
    bb.realtime.publish(REALTIME_CHANNEL, null);
    return state();
  }

  async function clear(): Promise<WallpaperState> {
    await settings.experimental_set({ imagePath: "" });
    return state();
  }

  bb.rpc.register(rpcContract, {
    get: () => state(),
    apply: (input) => apply(input, undefined),
    clear: () => clear(),
  });

  bb.http.route("GET", "/image", async (c) => {
    const { imagePath } = await settings.get();
    if (imagePath === "") return c.text("no wallpaper is set", 404);
    let image;
    try {
      image = await images.read(imagePath);
    } catch (error) {
      if (error instanceof ImageFileError) return c.text(error.message, 404);
      throw error;
    }
    const { file, bytes } = image;
    const etag = `"${file.hash}"`;
    // A URL naming an older hash still gets today's file, but must not be
    // cached under that stale name.
    const cacheControl = c.req.query("v") === file.hash ? IMMUTABLE : "no-cache";
    const headers = { "Cache-Control": cacheControl, ETag: etag };
    if (c.req.header("If-None-Match") === etag) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { ...headers, "Content-Type": file.mime, "Content-Length": String(file.bytes) },
    });
  });

  const jsonOption = {
    json: { type: "boolean", description: "Print the wallpaper state as JSON" },
  } as const;

  function formatState(value: WallpaperState): string {
    const lines = [
      `enabled\t${value.enabled}`,
      `path\t${value.path === "" ? "(none)" : value.path}`,
      `dim\t${value.dim}%`,
      `blur\t${value.blur}px`,
    ];
    if (value.image !== null) lines.push(`hash\t${value.image.hash}`, `bytes\t${value.image.bytes}`);
    if (value.error !== null) lines.push(`error\t${value.error}`);
    return `${lines.join("\n")}\n`;
  }

  function output(value: WallpaperState, json: boolean | undefined) {
    return { exitCode: 0, stdout: json ? `${JSON.stringify(value)}\n` : formatState(value) };
  }

  bb.cli.register(
    defineCli({
      name: "wallpaper",
      summary: "Show a local image behind bb's thread and New thread panes",
      commands: {
        apply: cliCommand({
          summary: "Show an image file as the wallpaper and turn the wallpaper on",
          positionals: [
            {
              name: "path",
              description: "JPEG, PNG, WebP, GIF, or AVIF file; relative paths resolve against the current directory",
              required: true,
            },
          ],
          options: {
            dim: { type: "integer", min: 0, max: DIM_MAX, description: `Darken the image by this percentage (0-${DIM_MAX})` },
            blur: { type: "integer", min: 0, max: BLUR_MAX, description: `Blur radius in pixels (0-${BLUR_MAX})` },
            ...jsonOption,
          },
          async run(input, ctx) {
            const value = await apply(
              { path: input.positionals.path, dim: input.options.dim, blur: input.options.blur },
              ctx.cwd,
            );
            return output(value, input.options.json);
          },
        }),
        show: cliCommand({
          summary: "Print the wallpaper's path, dim, blur, and content hash",
          options: jsonOption,
          async run(input) {
            return output(await state(), input.options.json);
          },
        }),
        clear: cliCommand({
          summary: "Remove the wallpaper image; dim and blur are kept",
          options: jsonOption,
          async run(input) {
            return output(await clear(), input.options.json);
          },
        }),
      },
    }),
  );
}
