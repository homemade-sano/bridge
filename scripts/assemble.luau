-- Builds a deploy place: the base (code, services, Workspace.Assets) + the map place's
-- Workspace.Maps and Terrain, with a MaterialService rebuilt from what the result uses.
-- The output is a build artifact: Studio places stay the source, nothing is written back.
-- Invoked by the bridge (src/deploy.ts) via `lune run`.
--
-- usage: lune run assemble.luau <base.rbxl> <map.rbxl|-> <out.rbxl>
--   map "-" = no graft: the base's Workspace is kept, MaterialService is still rebuilt.
--
-- Layout (every place): Workspace.Maps = the map's instances, MaterialService.Base = the base's
-- MaterialVariants, MaterialService.Maps = the map's own MaterialVariants.
--
-- Rule (out = base, modified):
--   1. [map] remove base Workspace children except "Assets", Camera, Terrain
--   2. [map] move in the map's Workspace.Maps — nothing else of the map's Workspace ships
--   3. [map] replace base Terrain with the map's (whole instance reparented —
--      Lune can't read Terrain.MaterialColors, so copying properties loses it)
--   4. tag every Workspace descendant with a "map_class" attribute "MapClass"
--   5. MaterialService rebuilt:
--      a. base variants at the service root move into "Base"; [map] any base "Maps" is dropped
--      b. [map] the map's "Maps" folder moves in whole; a variant in it whose identity
--         (Name + BaseMaterial) the base already has is dropped (the base wins), a second
--         one with the same identity is dropped (first kept)
--      c. [map] the map's non-default overrides (<Material>Name) replace the base's
--      d. merges: a variant with a string attribute "deploy_merge_into" is folded into the
--         variant of that name and the same BaseMaterial (chains followed): every BasePart
--         and override pointing at it is rewritten, then it is removed
--      e. pruning: a variant no BasePart of the whole place and no override points at is
--         removed, unless it has the attribute "deploy_keep" = true
--      f. warnings: BaseParts / overrides pointing at no variant (they render the plain
--         material), look-alike variants (same BaseMaterial + same texture maps)
-- Workspace properties and everything else outside Workspace and MaterialService stay the base's.
--
-- Prints one JSON line on stdout:
--   { hasContents, assembled, tagged, materialVariantsAdded, materialVariantsMerged,
--     materialVariantsRemoved, partsRewritten, warnings: [string] }
local roblox = require("@lune/roblox")
local fs = require("@lune/fs")
local serde = require("@lune/serde")
local process = require("@lune/process")

local basePath, mapPath, outPath = process.args[1], process.args[2], process.args[3]

local MAPS = "Maps"
local BASE = "Base"
local MERGE_ATTRIBUTE = "deploy_merge_into"
local KEEP_ATTRIBUTE = "deploy_keep"
local BROKEN_EXAMPLES = 3

local result = {
	hasContents = true,
	assembled = false,
	tagged = 0,
	materialVariantsAdded = 0,
	materialVariantsMerged = 0,
	materialVariantsRemoved = 0,
	partsRewritten = 0,
	warnings = {},
}
local warnings = result.warnings

local function emit()
	print(serde.encode("json", result))
	process.exit(0)
end

local function key(name: string, material: string)
	return `{name}\0{material}`
end

local function variantKey(variant)
	return key(variant.Name, variant.BaseMaterial.Name)
end

-- Place files store the maps as <Map>Content (Content); older ones as <Map> (string).
local function textureMap(variant, map)
	local ok, value = pcall(function()
		return variant[`{map}Content`]
	end)
	if not ok or value == nil then
		ok, value = pcall(function()
			return variant[map]
		end)
	end
	if not ok or value == nil then
		return ""
	end
	local text = tostring(value)
	if typeof(value) == "Content" then
		return string.match(text, "^Content%(Uri=(.*)%)$") or ""
	end
	return text
end

local base = roblox.deserializePlace(fs.readFile(basePath))

if base:GetService("ReplicatedStorage"):FindFirstChild("Contents") == nil then
	result.hasContents = false
	emit()
end

local bws, bms = base:GetService("Workspace"), base:GetService("MaterialService")
local map = if mapPath == "-" then nil else roblox.deserializePlace(fs.readFile(mapPath))

-- 1-3. Workspace graft ------------------------------------------------------------------------

if map then
	local mws = map:GetService("Workspace")

	for _, child in bws:GetChildren() do
		if child.Name ~= "Assets" and child.ClassName ~= "Camera" and child.ClassName ~= "Terrain" then
			child:Destroy()
		end
	end

	local mapFolder = mws:FindFirstChild(MAPS)
	if mapFolder then
		mapFolder.Parent = bws
	else
		table.insert(warnings, `map has no Workspace.{MAPS} — no map instances grafted`)
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
end

-- 4. MapClass tags ----------------------------------------------------------------------------

for _, d in bws:GetDescendants() do
	if d:GetAttribute("map_class") ~= nil then
		d:AddTag("MapClass")
		result.tagged += 1
	end
end

-- 5a-c. MaterialService: base + map variants, overrides ---------------------------------------

if map then
	for _, child in bms:GetChildren() do
		if child.Name == MAPS then
			child:Destroy()
		end
	end
end

local baseFolder = bms:FindFirstChild(BASE)
for _, child in bms:GetChildren() do
	if child.ClassName == "MaterialVariant" then
		if baseFolder == nil then
			baseFolder = roblox.Instance.new("Folder")
			baseFolder.Name = BASE
			baseFolder.Parent = bms
		end
		child.Parent = baseFolder
	end
end

local known = {}
for _, d in bms:GetDescendants() do
	if d.ClassName == "MaterialVariant" then
		if known[variantKey(d)] then
			table.insert(warnings, `base MaterialVariant "{d.Name}" [{d.BaseMaterial.Name}] duplicated in base - first kept`)
			d:Destroy()
		else
			known[variantKey(d)] = "base"
		end
	end
end

if map then
	local mms = map:GetService("MaterialService")
	local mapVariants = mms:FindFirstChild(MAPS)
	if mapVariants then
		for _, d in mapVariants:GetDescendants() do
			if d.ClassName == "MaterialVariant" then
				local k = variantKey(d)
				if known[k] == "base" then
					table.insert(warnings, `map MaterialVariant "{d.Name}" [{d.BaseMaterial.Name}] ignored - base version kept`)
					d:Destroy()
				elseif known[k] == "map" then
					table.insert(warnings, `map MaterialVariant "{d.Name}" [{d.BaseMaterial.Name}] duplicated in map - first kept`)
					d:Destroy()
				else
					known[k] = "map"
					result.materialVariantsAdded += 1
				end
			end
		end
		mapVariants.Parent = bms
	end
end

-- Overrides: every <Material>Name property Lune's reflection database knows.
-- Default = the material's own name (or "").
local overrides = {}
for name, property in roblox.getReflectionDatabase():GetClass("MaterialService").Properties do
	if property.Datatype == "String" and name ~= "Name" and string.sub(name, -4) == "Name" then
		table.insert(overrides, { property = name, material = string.sub(name, 1, -5) })
	end
end
table.sort(overrides, function(a, b)
	return a.property < b.property
end)

local function overrideValue(service, override)
	local value = service[override.property]
	return if value == override.material or value == "" then nil else value
end

if map then
	local mms = map:GetService("MaterialService")
	for _, override in overrides do
		local mapValue = overrideValue(mms, override)
		if mapValue then
			local baseValue = overrideValue(bms, override)
			if baseValue and baseValue ~= mapValue then
				table.insert(
					warnings,
					`MaterialService override {override.material}: base "{baseValue}" replaced by map "{mapValue}"`
				)
			end
			bms[override.property] = mapValue
		end
	end
end

-- 5d. merges ----------------------------------------------------------------------------------

local variants = {} -- key -> MaterialVariant, the output's variants
for _, d in bms:GetDescendants() do
	if d.ClassName == "MaterialVariant" then
		variants[variantKey(d)] = d
	end
end

local function resolveMerge(variant)
	local material = variant.BaseMaterial.Name
	local seen = { [variantKey(variant)] = true }
	local current = variant
	while true do
		local into = current:GetAttribute(MERGE_ATTRIBUTE)
		if into == nil then
			return current
		end
		if typeof(into) ~= "string" or into == "" then
			table.insert(warnings, `"{current.Name}" [{material}]: {MERGE_ATTRIBUTE} must be a variant name - not merged`)
			return nil
		end
		local k = key(into, material)
		local target = variants[k]
		if target == nil then
			table.insert(warnings, `"{current.Name}" [{material}]: {MERGE_ATTRIBUTE} "{into}" names no {material} variant - not merged`)
			return nil
		end
		if seen[k] then
			table.insert(warnings, `"{variant.Name}" [{material}]: {MERGE_ATTRIBUTE} loops back to "{into}" - not merged`)
			return nil
		end
		seen[k] = true
		current = target
	end
end

local redirects = {} -- key -> target name (same material)
for k, variant in variants do
	if variant:GetAttribute(MERGE_ATTRIBUTE) ~= nil then
		local target = resolveMerge(variant)
		if target then
			redirects[k] = target.Name
		end
	end
end

local parts = {}
for _, d in base:GetDescendants() do
	if d.ClassName ~= "Terrain" and d:IsA("BasePart") and d.MaterialVariant ~= "" then
		table.insert(parts, d)
	end
end

local mergeCounts = {} -- key -> { parts, overrides }
for k in redirects do
	mergeCounts[k] = { parts = 0, overrides = 0 }
end

for _, part in parts do
	local k = key(part.MaterialVariant, part.Material.Name)
	local into = redirects[k]
	if into then
		part.MaterialVariant = into
		mergeCounts[k].parts += 1
		result.partsRewritten += 1
	end
end

for _, override in overrides do
	local value = overrideValue(bms, override)
	if value then
		local k = key(value, override.material)
		local into = redirects[k]
		if into then
			bms[override.property] = into
			mergeCounts[k].overrides += 1
		end
	end
end

local mergeLines = {}
for k, into in redirects do
	local variant = variants[k]
	local counts = mergeCounts[k]
	table.insert(
		mergeLines,
		`merged "{variant.Name}" into "{into}" [{variant.BaseMaterial.Name}]: {counts.parts} part(s), {counts.overrides} override(s) rewritten`
	)
	variant:Destroy()
	variants[k] = nil
	result.materialVariantsMerged += 1
end
table.sort(mergeLines)
table.move(mergeLines, 1, #mergeLines, #warnings + 1, warnings)

-- 5e. pruning ---------------------------------------------------------------------------------

local used = {}
local broken = {} -- key -> { count, examples }
for _, part in parts do
	local k = key(part.MaterialVariant, part.Material.Name)
	if variants[k] then
		used[k] = true
	else
		local entry = broken[k] or { name = part.MaterialVariant, material = part.Material.Name, count = 0, examples = {} }
		entry.count += 1
		if #entry.examples < BROKEN_EXAMPLES then
			table.insert(entry.examples, part:GetFullName())
		end
		broken[k] = entry
	end
end

local brokenOverrides = {}
for _, override in overrides do
	local value = overrideValue(bms, override)
	if value then
		local k = key(value, override.material)
		if variants[k] then
			used[k] = true
		else
			table.insert(
				brokenOverrides,
				`MaterialService override {override.material} -> "{value}": no such {override.material} MaterialVariant - terrain falls back to the default`
			)
		end
	end
end

local removed = {}
for k, variant in variants do
	if not used[k] and variant:GetAttribute(KEEP_ATTRIBUTE) ~= true then
		table.insert(removed, `"{variant.Name}" [{variant.BaseMaterial.Name}]`)
		variant:Destroy()
		variants[k] = nil
	end
end
table.sort(removed)
result.materialVariantsRemoved = #removed
if #removed > 0 then
	table.insert(warnings, `{#removed} unused MaterialVariant(s) removed: {table.concat(removed, ", ")}`)
end

-- folders left without any variant go too
local function prune(folder)
	for _, child in folder:GetChildren() do
		if child.ClassName == "Folder" then
			prune(child)
		end
	end
	if folder ~= bms and folder.ClassName == "Folder" and #folder:GetChildren() == 0 then
		folder:Destroy()
	end
end
prune(bms)

-- 5f. warnings --------------------------------------------------------------------------------

local brokenLines = {}
for _, entry in broken do
	table.insert(
		brokenLines,
		`{entry.count} part(s) use missing MaterialVariant "{entry.name}" [{entry.material}] - plain material rendered (e.g. {table.concat(entry.examples, ", ")})`
	)
end
table.sort(brokenLines)
table.move(brokenLines, 1, #brokenLines, #warnings + 1, warnings)
table.move(brokenOverrides, 1, #brokenOverrides, #warnings + 1, warnings)

local groups = {}
for _, variant in variants do
	local maps = {}
	for _, textureName in { "ColorMap", "NormalMap", "MetalnessMap", "RoughnessMap" } do
		table.insert(maps, textureMap(variant, textureName))
	end
	if table.concat(maps) ~= "" then
		local k = `{variant.BaseMaterial.Name}\0{table.concat(maps, "\0")}`
		groups[k] = groups[k] or {}
		table.insert(groups[k], variant)
	end
end

local lookAlikes = {}
for _, group in groups do
	if #group > 1 then
		local names = {}
		for _, variant in group do
			table.insert(
				names,
				`"{variant.Name}" ({variant.Parent.Name}, {variant.StudsPerTile} studs, {variant.MaterialPattern.Name})`
			)
		end
		table.sort(names)
		table.insert(
			lookAlikes,
			`look-alike MaterialVariants [{group[1].BaseMaterial.Name}], same textures: {table.concat(names, ", ")}`
		)
	end
end
table.sort(lookAlikes)
table.move(lookAlikes, 1, #lookAlikes, #warnings + 1, warnings)

fs.writeFile(outPath, roblox.serializePlace(base))
result.assembled = true
emit()
