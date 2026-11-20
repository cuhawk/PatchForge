/// <reference path="./fixture-api.d.ts" />
import { relay } from "./helper.js";
function read(path: string) { fs.readFile(path); } read(relay(req.params));
