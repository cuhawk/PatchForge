/// <reference path="./fixture-api.d.ts" />
import { relay } from "./helper.js";
fetch(Math.random() > 0.5 ? relay(req.body) : "sample");
