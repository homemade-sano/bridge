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
function readConfig() {
    try {
        return JSON.parse(fs_1.default.readFileSync(CONFIG_PATH, "utf8"));
    }
    catch {
        return { port: 3000 };
    }
}
function writeConfig(data) {
    fs_1.default.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
}
