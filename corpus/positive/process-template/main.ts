/// <reference path="./fixture-api.d.ts" />
import { relay } from "./helper.js";
child_process.exec(`report ${relay(req.body)}`);
