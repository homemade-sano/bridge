"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readConfig = readConfig;
exports.writeConfig = writeConfig;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const CONFIG_PATH = path_1.default.join(__dirname, "..", "config.json");
const DEFAULT_DEPLOY = {
    downloadTimeoutMs: 60000,
    publishTimeoutMs: 120000,
};
function readConfig() {
    let raw = {};
    try {
        raw = JSON.parse(fs_1.default.readFileSync(CONFIG_PATH, "utf8"));
    }
    catch {
        // missing/corrupt file → all defaults
    }
    return {
        port: raw.port || 3000,
        deploy: { ...DEFAULT_DEPLOY, ...raw.deploy },
    };
}
function writeConfig(data) {
    const merged = { ...readConfig(), ...data };
    fs_1.default.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
}
