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
    const allowed = JSON.parse(permission.match(/commands\.allow\s*=\s*(\[[^\]]*\])/)?.[1] ?? "[]");
    expect(allowed).toEqual(["save_png_bytes", "share_png_bytes", "pick_capture_folder"]);
    for (const command of ["save_png_bytes", "share_png_bytes", "pick_capture_folder"]) {
      expect(permission).toContain(`"${command}"`);
      expect(handlers).toContain(`capture_save::${command}`);
    }
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
