/// <reference path="./fixture-api.d.ts" />
import { relay } from "./helper.js";
async function select(input: string) { return input; } async function run() { fetch(await select(relay(req.body))); }
