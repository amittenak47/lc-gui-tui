import { describe, expect, it } from "vitest";

import { withNetworkSecurityConfig } from "./android-overlay.mjs";

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
