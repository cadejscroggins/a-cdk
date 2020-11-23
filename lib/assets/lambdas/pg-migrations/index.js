const AWS = require('aws-sdk');
const { Sequelize } = require('sequelize');
const { SequelizeStorage, Umzug } = require('umzug');

exports.handler = async (event) => {
  const secretsmanager = new AWS.SecretsManager();

  const clusterSecret = await secretsmanager
    .getSecretValue({ SecretId: process.env.clusterSecretArn })
    .promise();

  const credentials = JSON.parse(clusterSecret.SecretString);

  const sequelize = Sequelize(
    process.env.clusterDatabase,
    credentials.username,
    credentials.password,
    {
      dialect: 'postgres',
      host: process.env.clusterHost,
      port: process.env.clusterPort,
    }
  );

  const umzug = new Umzug({
    context: sequelize.getQueryInterface(),
    logger: console,
    migrations: { glob: 'migrations/*.js' },
    storage: new SequelizeStorage({ sequelize }),
  });

  await umzug.up();
  return event;
};
