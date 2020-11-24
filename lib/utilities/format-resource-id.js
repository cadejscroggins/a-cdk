const changeCase = require('change-case');

const formatResourceId = (...parts) =>
  changeCase.pascalCase(parts.filter((p) => p).join('-'));

module.exports = formatResourceId;
