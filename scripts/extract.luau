-- Serializes instances of a place file to binary .rbxm files.
-- Invoked by the bridge (src/places.ts) via `lune run`.
--
-- usage: lune run extract.luau <place.rbxl> <outDir> <path> [<path> ...]
--   path = dot-separated from the DataModel, e.g. "ReplicatedStorage.Contents"
--   (names containing dots are not addressable).
--   "MaterialService" = the base's MaterialVariants: every descendant outside a
--   top-level "Maps" folder (a map's own variants), as ONE flat multi-root .rbxm
--   (the service, its folders and its overrides are not included).
--
-- Writes <outDir>/<i>.rbxm for each found path (i = 1-based arg index) and
-- prints one JSON line on stdout: [{ path, ok, roots?, file?, detail? }]
local roblox = require("@lune/roblox")
local fs = require("@lune/fs")
local serde = require("@lune/serde")
local process = require("@lune/process")

local game = roblox.deserializePlace(fs.readFile(process.args[1]))
local outDir = process.args[2]

local function resolve(path: string)
	local current = game
	for _, name in string.split(path, ".") do
		local child = current:FindFirstChild(name)
		if child == nil then
			return nil, `"{name}" not found under {if current == game then "the place" else current:GetFullName()}`
		end
		current = child
	end
	return current
end

local items = {}
for i = 3, #process.args do
	local path = process.args[i]
	local file = `{outDir}/{i - 2}.rbxm`
	if path == "MaterialService" then
		local variants = {}
		for _, child in game:GetService("MaterialService"):GetChildren() do
			if child.Name ~= "Maps" then
				if child.ClassName == "MaterialVariant" then
					table.insert(variants, child)
				end
				for _, d in child:GetDescendants() do
					if d.ClassName == "MaterialVariant" then
						table.insert(variants, d)
					end
				end
			end
		end
		fs.writeFile(file, roblox.serializeModel(variants))
		table.insert(items, { path = path, ok = true, roots = #variants, file = file })
		continue
	end
	local instance, detail = resolve(path)
	if instance == nil or instance == game then
		table.insert(items, { path = path, ok = false, detail = detail or "empty path" })
	else
		fs.writeFile(file, roblox.serializeModel({ instance }))
		table.insert(items, { path = path, ok = true, roots = 1, file = file })
	end
end

print(serde.encode("json", items))
