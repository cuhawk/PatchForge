/// <reference path="./fixture-api.d.ts" />
import { relay } from "./helper.js";
db.query(relay(req.query));
