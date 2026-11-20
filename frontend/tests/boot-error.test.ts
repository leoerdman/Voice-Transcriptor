import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyBootError } from "../src/boot-error";

describe("classifyBootError — FQ-14", () => {
  it("WinError 5 is access denied, but WinError 50/53 are not", () => {
    expect(classifyBootError("OSError: [WinError 5] Access is denied").headline)
      .toBe("Transcriptor couldn't access its data directory.");
    expect(classifyBootError("OSError: [WinError 53] The network path was not found").headline)
      .toBe("Backend failed to start.");
    expect(classifyBootError("OSError: [WinError 50] The request is not supported").headline)
      .toBe("Backend failed to start.");
  });

  it("WinError 10013 (a reserved or firewalled port) has its own diagnosis", () => {
    const out = classifyBootError(
      "OSError: [WinError 10013] An attempt was made to access a socket in a way forbidden by its access permissions",
    );
    expect(out.headline).toBe("Windows blocked the backend port.");
  });

  it("the port-in-use family is unchanged", () => {
    expect(classifyBootError("OSError: [Errno 48] Address already in use").headline).toBe("The backend port is already in use.");
    expect(classifyBootError("[WinError 10048] Only one usage of each socket address").headline).toBe("The backend port is already in use.");
  });

  it("the Python copy states no version the project does not declare", () => {
    const pythonVersion = readFileSync(resolve(process.cwd(), "../.python-version"), "utf8").trim();
    const detail = classifyBootError("Python 3 interpreter was not found on PATH").detail;
    expect(detail).not.toMatch(/3\.10/);
    // Either no minor version at all, or the SSOT's own.
    const stated = /Python (\d+\.\d+)/.exec(detail)?.[1];
    if (stated) expect(pythonVersion.startsWith(stated)).toBe(true);
  });

  it("an empty error and an unknown one get the generic copy", () => {
    expect(classifyBootError("").headline).toBe("Backend failed to start.");
    expect(classifyBootError("Segmentation fault").headline).toBe("Backend failed to start.");
  });
});
