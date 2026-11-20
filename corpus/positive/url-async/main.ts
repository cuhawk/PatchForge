/// <reference path="./fixture-api.d.ts" />
async function select(input: string) { return input; } async function run() { fetch(await select(req.body)); }
