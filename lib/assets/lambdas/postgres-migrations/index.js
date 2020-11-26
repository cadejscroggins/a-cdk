/* eslint-disable no-console */

const dataClient = require('data-api-client');
const fs = require('fs');

const db = dataClient({
  database: process.env.databaseName,
  resourceArn: process.env.clusterArn,
  secretArn: process.env.secretArn,
});

const log = (name, value) =>
  console.log(`
-- ${name}:

${value}
  `);

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.RequestType !== 'Update') return event;

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

  if (!newMigrationKeys.length) return event;
  const migrationRes = await db.query(migrationSql);

  log(`migration sql (${newMigrationKeys})`, migrationSql);
  log('migration response', JSON.stringify(migrationRes, null, 2));

  await db.query(
    `insert into ${process.env.migrationsTableName} ("migrationKey") values (:key)`,
    newMigrationKeys.map((key) => [{ key }])
  );

  return event;
};
