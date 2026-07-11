import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const destHome = `${process.env.HOME}/.pi/pi-docker`;
const srcConfigDir = `${process.env.HOME}/.pi/agent`;
const destConfigDir = `${destHome}/seed/agent`;

/**
 * Get the necessary configuration files to build pi agent in docker container.
 * We intentionally copy only git-tracked/unignored files from ~/.pi/agent so
 * sessions, auth.json, npm/node_modules, caches, logs, etc. are not seeded into
 * the container.
 */
function getConfigFiles(baseDir: string): Array<string> {
  try {
    const output = execSync("git ls-files -c -o --exclude-standard", {
      cwd: baseDir,
      encoding: "utf8",
    });

    return output
      .split("\n")
      .map((file) => file.trim())
      .filter(Boolean)
      .filter((file) => !file.startsWith("npm/"));
  } catch (error) {
    console.error("Execute git failed.", error);
    return [];
  }
}

function copyFile(srcPath: string, destPath: string) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  try {
    fs.chmodSync(destPath, fs.statSync(srcPath).mode & 0o777);
  } catch {
    // Best effort only.
  }
}

/** Copy the configuration files to docker-pi's seed directory. */
function copyConfig(srcDir: string, destDir: string) {
  const configFiles = getConfigFiles(srcDir);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  for (const file of configFiles) {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(destDir, file);

    if (!fs.existsSync(srcPath)) {
      console.warn(`no file exists - ${srcPath}`);
      continue;
    }

    try {
      copyFile(srcPath, destPath);
    } catch (error) {
      console.error(`copy failed: ${file}`, error);
    }
  }
}

function requirePreparedFile(filePath: string, message: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${message}: ${filePath}`);
  }
}

function movePreparedFile(relativePath: string, destinationFileName?: string) {
  const srcPath = path.join(destConfigDir, relativePath);
  const destPath = path.join(
    destHome,
    destinationFileName ?? path.basename(relativePath),
  );
  requirePreparedFile(srcPath, "Prepared file is missing");
  fs.rmSync(destPath, { force: true });
  fs.renameSync(srcPath, destPath);
  return destPath;
}

/** Use less strict permission config for docker container. */
function preparePermissionConfig() {
  const permissionDir = path.join(
    destConfigDir,
    "extensions/pi-permission-system",
  );
  const dockerConfig = path.join(permissionDir, "config.docker.json");
  const activeConfig = path.join(permissionDir, "config.json");

  requirePreparedFile(dockerConfig, "Docker permission config is missing");
  fs.rmSync(activeConfig, { force: true });
  fs.copyFileSync(dockerConfig, activeConfig);
}

function prepareDockerFiles() {
  fs.mkdirSync(destHome, { recursive: true });
  copyConfig(srcConfigDir, destConfigDir);

  preparePermissionConfig();

  movePreparedFile("extensions/sandbox/Dockerfile.pi", "Dockerfile.pi");
  const entrypointPath = movePreparedFile(
    "extensions/sandbox/pi-entrypoint.sh",
    "pi-entrypoint.sh",
  );
  fs.chmodSync(entrypointPath, 0o755);

  const buildScriptPath = movePreparedFile(
    "extensions/sandbox/build.sh",
    "build.sh",
  );
  fs.chmodSync(buildScriptPath, 0o755);

  const runScriptPath = movePreparedFile("extensions/sandbox/run.sh", "run.sh");
  fs.chmodSync(runScriptPath, 0o755);

  const resetVolumeScriptPath = movePreparedFile(
    "extensions/sandbox/reset-volumes.sh",
    "reset-volumes.sh",
  );
  fs.chmodSync(resetVolumeScriptPath, 0o755);

  const updateConfigScriptPath = movePreparedFile(
    "extensions/sandbox/update-config.sh",
    "update-config.sh",
  );
  fs.chmodSync(updateConfigScriptPath, 0o755);

  fs.rmSync(path.join(destConfigDir, "extensions/sandbox"), {
    recursive: true,
    force: true,
  });
}

export default async function (pi: ExtensionAPI) {
  pi.registerCommand("sandbox:build", {
    description: "Build the Pi Docker sandbox image.",
    handler: async (_, ctx) => {
      prepareDockerFiles();
      ctx.ui.notify(
        `Build script created under ${destHome}/build.sh, now build image yourself.`,
        "info",
      );
    },
  });

  pi.registerCommand("sandbox:update-config", {
    description: "Update configuration files for Pi in Docker.",
    handler: async (_, ctx) => {
      try {
        prepareDockerFiles();
        execFileSync(path.join(destHome, "update-config.sh"), {
          cwd: destHome,
          stdio: "inherit",
        });
        ctx.ui.notify("Config of Pi in docker updated.", "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("sandbox:update-config failed:", message);
        ctx.ui.notify(`Failed to update config: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("sandbox:refresh-config", {
    description: "Totally refresh configuration files for Pi in Docker.",
    handler: async (_, ctx) => {
      prepareDockerFiles();
      execFileSync(path.join(destHome, "reset-volumes.sh"), {
        cwd: destHome,
        stdio: "inherit",
      });
      ctx.ui.notify("Config of Pi in docker refreshed.", "info");
    },
  });

  pi.registerFlag("sandbox", {
    description: "Start pi in sandbox (docker container)",
    type: "boolean",
    default: false,
  });

  if (process.argv.includes("--sandbox")) {
    console.log("Starting Pi in sandbox mode...");
    const result = spawnSync(path.join(destHome, "run.sh"), [], {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: false,
    });

    if (result.error) {
      console.error("Failed to run sandbox:", result.error);
      process.exit(1);
    }

    if (result.signal) {
      console.error(`Sandbox process terminated by signal: ${result.signal}`);
      const signalNum =
        os.constants.signals?.[
          result.signal as keyof typeof os.constants.signals
        ];
      process.exit(128 + (typeof signalNum === "number" ? signalNum : 1));
    }

    process.exit(result.status ?? 1);
  }
}
