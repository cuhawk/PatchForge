/// <reference path="./fixture-api.d.ts" />
import { relay } from "./helper.js";
fs.readFile(`reports/${relay(req.query)}`);
