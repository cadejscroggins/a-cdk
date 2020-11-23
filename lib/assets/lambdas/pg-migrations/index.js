const pg = require('@bbitgmbh/bbit.rdsdata.postgres');
const { Sequelize } = require('sequelize');
const { SequelizeStorage, Umzug } = require('umzug');

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  const encodedClusterDatabase = encodeURIComponent(
    process.env.clusterDatabase
  );

  const encodedClusterSecretArn = encodeURIComponent(
    process.env.clusterSecretArn
  );

  const encodedClusterName = encodeURIComponent(process.env.clusterName);

  const { database, host, password, port, user } = new pg.Client(
    `awsrds://${encodedClusterDatabase}:${encodedClusterSecretArn}@${process.env.clusterRegion}.${process.env.awsAccountId}.aws/${encodedClusterName}`
  ).dataApiRetrievePostgresDataApiClientConfig();

  const sequelize = new Sequelize({
    database,
    dialect: 'postgres',
    dialectModule: pg,
    host,
    password,
    port,
    user,
  });

  const umzug = new Umzug({
    context: sequelize.getQueryInterface(),
    logger: console,
    migrations: { glob: 'migrations/*.js' },
    storage: new SequelizeStorage({ sequelize }),
  });

  await umzug.up();
  return event;
};
