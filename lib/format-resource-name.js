const changeCase = require('change-case');

const formatResourceName = (...parts) => changeCase.pascalCase(parts.join('-'));

module.exports = formatResourceName;
