/// <reference path="./fixture-api.d.ts" />
function report(command: string) { child_process.exec(command); } function dispatch(value: string) { report(value); } dispatch(req.query);
