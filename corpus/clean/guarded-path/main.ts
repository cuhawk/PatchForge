/// <reference path="./fixture-api.d.ts" />
import * as path from "node:path"; const base = "/example"; const file = path.resolve(base, req.params); if (!file.startsWith(base + path.sep)) throw new Error(); fs.readFile(file);
