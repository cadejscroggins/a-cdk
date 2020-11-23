const AWS = require('aws-sdk');
const Postgrator = require('postgrator');

exports.handler = async (event) => {
  const secretsmanager = new AWS.SecretsManager();

  const clusterSecret = await secretsmanager
    .getSecretValue({ SecretId: process.env.clusterSecretArn })
    .promise();

  const credentials = JSON.parse(clusterSecret.SecretString);

  const postgrator = new Postgrator({
    database: process.env.clusterDatabase,
    driver: 'pg',
    host: process.env.clusterHost,
    migrationDirectory: 'migrations',
    password: credentials.password,
    port: process.env.clusterPort,
    username: credentials.username,
  });

  await postgrator.migrate();

  return event;
};
