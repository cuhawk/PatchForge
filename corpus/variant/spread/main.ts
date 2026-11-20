/// <reference path="./fixture-api.d.ts" />
const first = { key: req.body }; const { key } = { ...first }; const record: Record<string, string> = Object.create(null); record[key] = "sample";
