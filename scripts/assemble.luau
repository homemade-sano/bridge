-- Builds a deploy place: base place + the map place's Workspace and Terrain.
-- Invoked by the bridge (src/deploy.ts) via `lune run`.
--
-- usage: lune run assemble.luau <base.rbxl> <map.rbxl|-> <out.rbxl>
--   map "-" = no graft: only check the base (nothing written).
--
-- Rule (out = base, modified):
--   1. remove base Workspace children except "Assets", Camera, Terrain
--   2. move in map Workspace children except "Assets", Camera, Terrain
--   3. replace base Terrain with the map's (whole instance reparented —
--      Lune can't read Terrain.MaterialColors, so copying properties loses it)
--   4. tag every Workspace descendant with a "map_class" attribute "MapClass"
-- Workspace properties and everything outside Workspace stay the base's.
--
-- Prints one JSON line on stdout:
--   { hasContents, assembled, tagged, warnings: [string] }
local roblox = require("@lune/roblox")
local fs = require("@lune/fs")
local serde = require("@lune/serde")
local process = require("@lune/process")

local basePath, mapPath, outPath = process.args[1], process.args[2], process.args[3]

local function emit(result)
	print(serde.encode("json", result))
	process.exit(0)
end

local base = roblox.deserializePlace(fs.readFile(basePath))
local warnings = {}

if base:GetService("ReplicatedStorage"):FindFirstChild("Contents") == nil then
	emit({ hasContents = false, assembled = false, tagged = 0, warnings = warnings })
end

if mapPath == "-" then
	emit({ hasContents = true, assembled = false, tagged = 0, warnings = warnings })
end

local map = roblox.deserializePlace(fs.readFile(mapPath))
local bws, mws = base:GetService("Workspace"), map:GetService("Workspace")

local function kept(child)
	return child.Name == "Assets" or child.ClassName == "Camera" or child.ClassName == "Terrain"
end

for _, child in bws:GetChildren() do
	if not kept(child) then
		child:Destroy()
	end
end

for _, child in mws:GetChildren() do
	if child.Name == "Assets" then
		table.insert(warnings, `map Workspace.{child.Name} ({child.ClassName}) ignored — "Assets" always comes from the base`)
	elseif not kept(child) then
		child.Parent = bws
	end
end

local mapTerrain = mws:FindFirstChildOfClass("Terrain")
if mapTerrain then
	for _, child in bws:GetChildren() do
		if child.ClassName == "Terrain" then
			child:Destroy()
		end
	end
	mapTerrain.Parent = bws
else
	table.insert(warnings, "map has no Terrain — base Terrain kept")
end

local tagged = 0
for _, d in bws:GetDescendants() do
	if d:GetAttribute("map_class") ~= nil then
		d:AddTag("MapClass")
		tagged += 1
	end
end

fs.writeFile(outPath, roblox.serializePlace(base))
emit({ hasContents = true, assembled = true, tagged = tagged, warnings = warnings })
