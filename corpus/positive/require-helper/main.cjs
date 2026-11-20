const { forward: copy } = require("patchforge-fixture/forward");
function handler(req) {
  const value = copy(req.query.value);
  fs.readFile(value);
}
exports.handler = handler;
