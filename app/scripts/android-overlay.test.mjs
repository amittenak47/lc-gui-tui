import { describe, expect, it } from "vitest";

import { withExecOperations, withNetworkSecurityConfig } from "./android-overlay.mjs";

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:icon="@mipmap/ic_launcher"
        android:label="lc-whiteboard">
        <activity android:name=".MainActivity" />
    </application>
</manifest>
`;

describe("withNetworkSecurityConfig", () => {
  it("points <application> at the cleartext config", () => {
    const patched = withNetworkSecurityConfig(MANIFEST);
    expect(patched).toContain('android:networkSecurityConfig="@xml/network_security_config"');
    // The rest of the manifest is untouched.
    expect(patched).toContain('android:label="lc-whiteboard"');
    expect(patched).toContain('<activity android:name=".MainActivity" />');
  });

  it("is idempotent — the script runs before every build", () => {
    const once = withNetworkSecurityConfig(MANIFEST);
    expect(withNetworkSecurityConfig(once)).toBe(once);
    expect(once.match(/networkSecurityConfig/g)).toHaveLength(1);
  });

  it("refuses a manifest it does not recognise rather than writing junk", () => {
    expect(() => withNetworkSecurityConfig("<manifest/>")).toThrow(/<application>/);
  });
});

const BUILD_TASK = `package dev.lc.whiteboard.kotlin

import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    fun runTauriCli(executable: String) {
        project.exec {
            workingDir(File(project.projectDir, rootDirRel))
            executable(executable)
        }.assertNormalExitValue()
    }
}
`;

describe("withExecOperations", () => {
  it("replaces Project.exec with injected ExecOperations", () => {
    const patched = withExecOperations(BUILD_TASK);
    expect(patched).toContain("import org.gradle.process.ExecOperations");
    expect(patched).toContain("import javax.inject.Inject");
    expect(patched).toContain("abstract class BuildTask : DefaultTask()");
    expect(patched).toContain("abstract val execOperations: ExecOperations");
    expect(patched).toContain("execOperations.exec {");
    expect(patched).not.toMatch(/\bproject\.exec\s*\{/);
  });

  it("is idempotent — overlay runs before every apk build", () => {
    const once = withExecOperations(BUILD_TASK);
    expect(withExecOperations(once)).toBe(once);
    expect(once.match(/execOperations\.exec/g)).toHaveLength(1);
  });

  it("refuses a file it does not recognise rather than writing junk", () => {
    expect(() => withExecOperations("open class Other")).toThrow(/project\.exec/);
  });
});
