/// <reference path="./fixture-api.d.ts" />
Promise.resolve(req.params).then(value => fetch(value));
