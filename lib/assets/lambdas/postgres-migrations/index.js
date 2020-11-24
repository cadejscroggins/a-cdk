const AWS = require('aws-sdk');

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  const rds = new AWS.RDSDataService();

  const res = await rds
    .executeStatement({
      resourceArn: process.env.clusterArn,
      schema: 'public',
      secretArn: process.env.secretArn,
      sql: `
        drop table if exists users;

        create table users (
          "email" text,
          "firstName" text,
          "id" char(27) primary key,
          "lastName" text,
          "zipcode" varchar(10)
        );

        insert into users ("email", "firstName", "id", "lastName", "zipcode")
          values ('cade@spraoi.ai', 'Cade', '123456789123456789123456789', 'Scroggins', 97041);
      `,
    })
    .promise();

  // eslint-disable-next-line no-console
  console.log(res);

  return event;
};
