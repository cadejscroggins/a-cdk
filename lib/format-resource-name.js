const changeCase = require('change-case');

const formatResourceName = (...parts) =>
  changeCase.pascalCase(parts.filter((p) => p).join('-'));

module.exports = formatResourceName;
