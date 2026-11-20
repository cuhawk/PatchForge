/// <reference path="./fixture-api.d.ts" />
import { relay } from "./helper.js";
const record: Record<string, string> = Object.create(null); const key = relay(mcp.toolArgs); record[key] = "sample";
