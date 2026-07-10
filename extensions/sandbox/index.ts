import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const destHome = `${process.env.HOME}/.pi/pi-docker`;
const srcConfigDir = `${process.env.HOME}/.pi/agent`;
const destConfigDir = `${destHome}/seed/agent`;
const imageName = "pi-agent-sandbox";

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

/** Write docker env file*/
function writeGatewayEnv() {
  const providerBaseUrl = process.env.PROVIDER_BASE_URL ?? "";
  const providerApiKey = process.env.PROVIDER_API_KEY ?? "";
  const envPath = path.join(destHome, "gateway.env");

  fs.writeFileSync(
    envPath,
    `PROVIDER_BASE_URL=${providerBaseUrl}\nPROVIDER_API_KEY=${providerApiKey}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  fs.chmodSync(envPath, 0o600);

  if (!providerBaseUrl || !providerApiKey) {
    console.warn(
      "PROVIDER_BASE_URL or PROVIDER_API_KEY is empty. Edit ~/.pi/pi-docker/gateway.env before running the container.",
    );
  }
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

  writeGatewayEnv();
}

export default async function (pi: ExtensionAPI) {
  pi.registerCommand("sandbox:build", {
    description: "Build the Pi Docker sandbox image.",
    handler: async (_, ctx) => {
      prepareDockerFiles();
      execFileSync(path.join(destHome, "build.sh"), {
        cwd: destHome,
        stdio: "inherit",
      });
      ctx.ui.notify(`Built Docker image: ${imageName}`, "info");
    },
  });

  pi.registerCommand("sandbox:update-config", {
    description: "Update configuration files for Pi in Docker.",
    handler: async (_, ctx) => {
      prepareDockerFiles();
      execSync(
        "docker run --rm -it --entrypoint /bin/bash pi-agent-sandbox -c 'rm -f ~/.pi/agent/.seeded'",
      );
      ctx.ui.notify("Config of Pi in docker updated.", "info");
    },
  });

  pi.registerCommand("sandbox:refersh-config", {
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

  if (pi.getFlag("sandbox")) {
    execFileSync(path.join(destHome, "run.sh"), {
      cwd: process.cwd(),
      stdio: "inherit",
    });
  }
}
