import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const srcDir = `${process.env.HOME}/.pi/agent`;
const destHome = `${process.env.HOME}/.pi/pi-docker`;
const destDir = `${destHome}/seed/agent`;

/**
 * Get the necessary configuration files to build pi agent in docker container.
 * @param baseDir The base directory to search for configuration files.
 * @returns An array of configuration file paths.
 */
function getConfigFiles(baseDir: string): Array<string> {
  try {
    // get all git tracked files, which are necessary for build the pi agent in new environment.
    const output = execSync("git ls-files -c -o --exclude-standard", {
      cwd: baseDir,
      encoding: "utf8",
    });

    return output.split("\n").filter(Boolean);
  } catch (error) {
    console.error("Execute git failed.", error);
    return [];
  }
}

/**
 * Copy the configuration files to docker-pi's seed directory.
 */
function copyConfig(srcDir: string, destDir: string) {
  const configFiles = getConfigFiles(srcDir);
  fs.mkdirSync(destDir, { recursive: true });

  for (const file of configFiles) {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(destDir, file);

    if (!fs.existsSync(srcPath)) {
      console.warn(`no file exists - ${srcPath}`);
      continue;
    }

    try {
      const destDirPath = path.dirname(destPath);
      if (!fs.existsSync(destDirPath)) {
        fs.mkdirSync(destDirPath, { recursive: true });
      }

      fs.copyFileSync(srcPath, destPath);
    } catch (error) {
      if (error) {
        console.error(`copy failed: ${file}`, error);
      }
    }
  }
}

function prepareDockerFiles() {
  copyConfig(srcDir, destDir);
  // use less strict pi permission config for pi in docker
  fs.rmSync(`${destDir}/extensions/pi-permission-system/config.json`);
  fs.renameSync(
    `${destDir}/extensions/pi-permission-system/config.docker.json`,
    `${destDir}/extensions/pi-permission-system/config.json`,
  );
  // move Dockerfile.pi and pi-entrypoint.sh to destination home dir
  fs.renameSync(
    `${destDir}/extensions/sandbox/Dockerfile.pi`,
    `${destHome}/Dockerfile.pi`,
  );
  fs.renameSync(
    `${destDir}/extensions/sandbox/pi-entrypoint.sh`,
    `${destHome}/pi-entrypoint.sh`,
  );
  // add env file
  fs.writeFileSync(
    `${destHome}/gateway.env`,
    `PROVIDER_BASE_URL=${process.env.PROVIDER_BASE_URL}
PROVIDER_API_KEY=${process.env.PROVIDER_API_KEY}`,
    {
      encoding: "utf8",
      mode: 0o600, // 等同于 Bash 中的 chmod 600
    },
  );
}

export default async function () {
  prepareDockerFiles();
}
