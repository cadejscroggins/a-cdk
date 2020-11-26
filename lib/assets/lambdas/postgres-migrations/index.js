/* eslint-disable no-console */

const dataClient = require('data-api-client');
const fs = require('fs');

const db = dataClient({
  database: process.env.databaseName,
  resourceArn: process.env.clusterArn,
  secretArn: process.env.secretArn,
});

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  await db.query(
    `create table if not exists "${process.env.migrationsTableName}" ("migrationKey" text);`
  );

  const executedMigrations = await db.query(
    `select * from "${process.env.migrationsTableName}";`
  );

  const newMigrationKeys = [];

  const migrationSql = fs
    .readdirSync(process.env.migrationsDir)
    .reduce((acc, migrationFileName) => {
      const [migrationKey] = migrationFileName.split('.');

      if (
        executedMigrations.records
          .map((r) => r.migrationKey)
          .includes(migrationKey)
      ) {
        return acc;
      }

      newMigrationKeys.push(migrationKey);

      const migrationScript = fs.readFileSync(
        `${process.env.migrationsDir}/${migrationFileName}`
      );

      return `${acc}${migrationScript}`;
    }, '');

  if (!newMigrationKeys.length) {
    console.log('no new migrations!');
    return event;
  }

  const migrationRes = await db.query(migrationSql);

  const keyUpdateRes = await db.query(
    `insert into ${process.env.migrationsTableName} ("migrationKey") values (:key)`,
    [newMigrationKeys.map((key) => [{ key }])]
  );

  console.log(`
    migration sql:

    ${migrationSql}

    migrations keys:

    ${newMigrationKeys}
  `);

  console.log(`
    migration response:

    ${migrationRes}

    migration keys update response:

    ${keyUpdateRes}
  `);

  return event;
};
