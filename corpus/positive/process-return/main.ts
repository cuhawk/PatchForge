/// <reference path="./fixture-api.d.ts" />
import { relay } from "./helper.js";
function selected() { return relay(mcp.toolArgs); } child_process.exec(selected());
