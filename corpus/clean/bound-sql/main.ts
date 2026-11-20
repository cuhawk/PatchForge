/// <reference path="./fixture-api.d.ts" />
db.query("SELECT label FROM reports WHERE label = ?", [req.params]);
