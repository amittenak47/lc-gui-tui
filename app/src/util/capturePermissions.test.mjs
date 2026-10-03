import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("installed capture command permissions", () => {
  it("grants the registered save/share/picker commands to the main window", () => {
    const capability = JSON.parse(readFileSync(new URL("../../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
    const permission = readFileSync(new URL("../../src-tauri/permissions/capture.toml", import.meta.url), "utf8");
    const handlers = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
    expect(capability.windows).toContain("main");
    expect(capability.windows).toEqual(["main"]);
    expect(capability.remote).toBeUndefined();
    expect(capability.permissions).toContain("allow-capture-export");
    expect(permission).toContain('identifier = "allow-capture-export"');
    // TOML arrays may end with a comma; JSON may not.
    const list = permission.match(/commands\.allow\s*=\s*(\[[^\]]*\])/)?.[1] ?? "[]";
    const allowed = JSON.parse(list.replace(/,\s*\]$/, "]"));
    const capture = ["save_png_bytes", "share_png_bytes", "pick_capture_folder"];
    const documentExport = ["begin_document_export", "append_document_export", "finish_document_export", "cancel_document_export"];
    expect(allowed).toEqual([...capture, ...documentExport]);
    for (const command of capture) expect(handlers).toContain(`capture_save::${command}`);
    for (const command of documentExport) expect(handlers).toContain(`document_export::${command}`);
  });

  it("registers the Android folder command and its result callback", () => {
    const pluginBuild = readFileSync(new URL("../../src-tauri/plugins/gallerysave/build.rs", import.meta.url), "utf8");
    const plugin = readFileSync(new URL("../../src-tauri/plugins/gallerysave/android/src/main/java/GallerySavePlugin.kt", import.meta.url), "utf8");
    expect(pluginBuild).toContain('"pick_folder"');
    expect(plugin).toMatch(/@Command\s+fun pick_folder\(/);
    expect(plugin).toContain('startActivityForResult(invoke, intent, "folderResult")');
    expect(plugin).toMatch(/@ActivityCallback\s+fun folderResult\(invoke: Invoke, result: ActivityResult\)/);
    expect(plugin).toContain('takePersistableUriPermission(uri, flags)');
  });
});
