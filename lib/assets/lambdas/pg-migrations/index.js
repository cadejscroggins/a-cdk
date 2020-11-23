const AWS = require('aws-sdk');
const Postgrator = require('postgrator');

exports.handler = async (event) => {
  const secretsmanager = new AWS.SecretsManager();

  const clusterSecret = await secretsmanager
  .getSecretValue({ SecretId: process.env.clusterSecretArn })
  .promise();

  const credentials = JSON.parse(clusterSecret);

  const postgrator = new Postgrator({
    database: process.env.clusterDatabaseName,
    driver: 'pg',
    host: process.env.clusterEndpoint,
    migrationDirectory: 'migrations',
    password: credentials.password,
    port: 5432,
    username: credentials.username,
  });

  await postgrator.migrate();
};
