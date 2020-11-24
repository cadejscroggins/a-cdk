const AWS = require('aws-sdk');

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  const rds = new AWS.RDSDataService();

  await rds.executeStatement({
    resourceArn: process.env.clusterArn,
    secretArn: process.env.secretArn,
    sql: `
      create table users (
        "email" text,
        "firstName" text,
        "id" char(27),
        "lastName" text,
        "zipcode" varchar(10),
        primary key ("id")
      );
    `,
  }).promise();

  return event;
};
