import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

export interface Config {
  port: number;
}

export function readConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Config;
  } catch {
    return { port: 3000 };
  }
}

export function writeConfig(data: Config): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
}
