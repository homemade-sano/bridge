import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

export interface DeployConfig {
  downloadTimeoutMs: number;
  publishTimeoutMs: number;
}

export interface PlacesConfig {
  createTimeoutMs: number;
  defaultTemplatePlaceId: number;
}

export interface StudioConfig {
  lunePath: string;
  cookieTimeoutMs: number;
}

export interface Config {
  port: number;
  deploy: DeployConfig;
  places: PlacesConfig;
  studio: StudioConfig;
}

const DEFAULT_DEPLOY: DeployConfig = {
  downloadTimeoutMs: 60000,
  publishTimeoutMs: 120000,
};

const DEFAULT_PLACES: PlacesConfig = {
  createTimeoutMs: 30000,
  defaultTemplatePlaceId: 95206881,
};

const DEFAULT_STUDIO: StudioConfig = {
  lunePath: "lune",
  cookieTimeoutMs: 15000,
};

export function readConfig(): Config {
  let raw: Partial<Config> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
  } catch {
    // missing/corrupt file → all defaults
  }
  return {
    port: raw.port || 3000,
    deploy: { ...DEFAULT_DEPLOY, ...raw.deploy },
    places: { ...DEFAULT_PLACES, ...raw.places },
    studio: { ...DEFAULT_STUDIO, ...raw.studio },
  };
}

export function writeConfig(data: Partial<Config>): void {
  const merged = { ...readConfig(), ...data };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
}
