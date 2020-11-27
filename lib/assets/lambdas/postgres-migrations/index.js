/* eslint-disable no-console */

import dataClient from 'data-api-client';
import fs from 'fs';

const db = dataClient({
  database: process.env.pgClusterDbName,
  resourceArn: process.env.pgClusterArn,
  secretArn: process.env.pgClusterSecretArn,
});

const log = (name, value) =>
  console.log(`
-- ${name}:

${value}
  `);

const handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.RequestType !== 'Update') return event;

  await db.query(
    `create table if not exists "${process.env.pgClusterMigrationsTableName}" ("migrationKey" text);`
  );

  const executedMigrations = await db.query(
    `select * from "${process.env.pgClusterMigrationsTableName}";`
  );

  const newMigrationKeys = [];

  const migrationSql = fs
    .readdirSync(process.env.pgClusterMigrationsLambdaMigrationsDir)
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
        `${process.env.pgClusterMigrationsLambdaMigrationsDir}/${migrationFileName}`
      );

      return `${acc}${migrationScript}`;
    }, '');

  if (!newMigrationKeys.length) return event;
  const migrationRes = await db.query(migrationSql);

  log(`migration sql (${newMigrationKeys})`, migrationSql);
  log('migration response', JSON.stringify(migrationRes, null, 2));

  await db.query(
    `insert into ${process.env.pgClusterMigrationsTableName} ("migrationKey") values (:key)`,
    newMigrationKeys.map((key) => [{ key }])
  );

  return event;
};

export default { handler };
