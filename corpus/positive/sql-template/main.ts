/// <reference path="./fixture-api.d.ts" />
import { relay } from "./helper.js";
db.query(`SELECT label FROM reports WHERE label = ${relay(req.params)}`);
