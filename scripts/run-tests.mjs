// Runs the compiled tests with the built-in test runner. The files are passed explicitly because
// directory and glob arguments behave differently across Node.js 18 to 24.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function findTests(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return findTests(path);
    }
    return entry.endsWith(".test.js") ? [path] : [];
  });
}

const only = process.argv[2];
const files = findTests(".test-build/test").filter((f) => !only || f.includes(only));
const result = spawnSync(process.execPath, ["--enable-source-maps", "--test", ...files], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
