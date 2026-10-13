const app = require('../src/server');
module.exports = app;
const app = require('../src/server.js');

module.exports = (req, res) => {
  app(req, res);
};
