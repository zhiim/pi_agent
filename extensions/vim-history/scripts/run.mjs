import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let host = process.env.PI_HOST_PACKAGE;
if (!host) {
  // npm prepends ancestor node_modules/.bin; those contain an older Pi here.
  const cliPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((p) => !p.endsWith("node_modules/.bin"))
    .join(path.delimiter);
  const executable = execFileSync("which", ["pi"], {
    encoding: "utf8",
    env: { ...process.env, PATH: cliPath },
  }).trim();
  let candidate = path.dirname(fs.realpathSync(executable));
  while (candidate !== path.dirname(candidate)) {
    const pkg = path.join(candidate, "package.json");
    if (
      fs.existsSync(pkg) &&
      JSON.parse(fs.readFileSync(pkg, "utf8")).name ===
        "@earendil-works/pi-coding-agent"
    ) {
      host = candidate;
      break;
    }
    candidate = path.dirname(candidate);
  }
}
if (!host)
  throw new Error(
    "Cannot locate Pi host. Set PI_HOST_PACKAGE to the running Pi package directory.",
  );
const version = JSON.parse(
  fs.readFileSync(path.join(host, "package.json"), "utf8"),
).version;
const hostRequire = createRequire(path.join(host, "package.json"));
const alias = {
  "@earendil-works/pi-coding-agent": path.join(host, "dist/index.js"),
  "@earendil-works/pi-tui": hostRequire.resolve("@earendil-works/pi-tui"),
  "#host-keybindings": path.join(host, "dist/core/keybindings.js"),
  "#host-theme": path.join(host, "dist/modes/interactive/theme/theme.js"),
};
process.env.PI_HOST_PACKAGE = host;
console.log(
  `Validating against host Pi ${version}, not parent extension dependencies`,
);

if (process.argv[2] === "test") {
  const { createJiti } = await import(
    pathToFileURL(hostRequire.resolve("jiti")).href
  );
  const jiti = createJiti(import.meta.url, {
    alias,
    fsCache: false,
    moduleCache: true,
  });
  const { initTheme } = await jiti.import(alias["#host-theme"]);
  initTheme("dark", false);
  for (const file of fs
    .readdirSync(path.join(root, "tests"))
    .filter((f) => f.endsWith(".test.ts"))
    .sort()) {
    await jiti.import(path.join(root, "tests", file));
  }
} else if (process.argv[2] === "check") {
  const ts = (await import("typescript")).default;
  const files = fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(root, f));
  files.push(
    ...fs
      .readdirSync(path.join(root, "tests"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join(root, "tests", f)),
  );
  // The bridge is part of the modal-paste integration exercised by smoke.py.
  files.push(path.resolve(root, "../nvim-bridge.ts"));
  const program = ts.createProgram(files, {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ["node"],
    typeRoots: [path.join(root, "node_modules/@types")],
    baseUrl: root,
    paths: Object.fromEntries(
      Object.entries(alias).map(([name, entry]) => [
        name,
        [entry.replace(/\.js$/, ".d.ts")],
      ]),
    ),
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    console.error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => root,
        getNewLine: () => "\n",
      }),
    );
    process.exitCode = 1;
  } else console.log("Type check passed.");
} else throw new Error("Usage: node scripts/run.mjs test|check");
