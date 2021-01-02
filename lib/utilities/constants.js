const path = require('path');

module.exports = {
  ACTION: {
    DESCRIBE_SECRET: 'DescribeSecret',
    GET_SECRET_VALUE: 'GetSecretValue',
  },
  ACTION_PREFIX: {
    COGNITO_IDP: 'cognito-idp:',
    RDS_DATA: 'rds-data:',
    SECRETSMANAGER: 'secretsmanager:',
    SES: 'ses:',
  },
  AUTH_ROLE: {
    AUTHENTICATED: 'authenticated',
    UNAUTHENTICATED: 'unauthenticated',
  },
  AUTH_TRIGGER: {
    CUSTOM_MESSAGE: 'auth-custom-message-trigger',
    PRE_SIGNUP: 'auth-pre-signup-trigger',
  },
  CONTEXT_KEY: {
    AUTH: 'auth',
    DATABASES: 'databases',
    LAMBDAS: 'lambdas',
    NAMESPACE: 'namespace',
    PERMISSIONS: 'permissions',
  },
  DATA_SOURCE_TYPE: {
    DYNAMODB: 'ddb',
    LAMBDA: 'lambda',
    NONE: 'none',
    POSTGRES: 'pg',
  },
  ENV_VAR_KEY: {
    PG_CLUSTER_ARN: 'pgClusterArn',
    PG_CLUSTER_DB_NAME: 'pgClusterDbName',
    PG_CLUSTER_MIGRATIONS_LAMBDA_MIGRATIONS_DIR:
      'pgClusterMigrationsLambdaMigrationsDir',
    PG_CLUSTER_MIGRATIONS_TABLE_NAME: 'pgClusterMigrationsTableName',
    PG_CLUSTER_SECRET_ARN: 'pgClusterSecretArn',
  },
  ID_PART: {
    API: 'Api',
    CLUSTER: 'Cluster',
    CUSTOM_RESOURCE: 'CustomResource',
    CUSTOM_RESOURCE_PROVIDER: 'CustomResourceProvider',
    DATA_SOURCE: 'DataSource',
    DEFAULT_POLICY: 'DefaultPolicy',
    DYNAMODB: 'Dynamodb',
    IDENTITIES: 'Identities',
    ISOLATED: 'Isolated',
    LAMBDA: 'Lambda',
    LAMBDA_ASSET: 'LambdaAsset',
    MIGRATIONS: 'Migrations',
    PARAMETER_GROUP: 'ParameterGroup',
    PERMISSIONS: 'Permissions',
    POLICY: 'Policy',
    POSTGRES: 'Postgres',
    PRIVATE_SUBNET: 'PrivateSubnet',
    PUBLIC_SUBNET: 'PublicSubnet',
    ROLE_ATTACHMENT: 'RoleAttachment',
    ROUTE_TABLE: 'RouteTable',
    SCHEMA: 'Schema',
    SECRET_ATTACHMENT: 'SecretAttachment',
    SECURITY_GROUP: 'SecurityGroup',
    SERVICE_ROLE: 'ServiceRole',
    SUBNET: 'Subnet',
    SUBNET_GROUP: 'SubnetGroup',
    USERS: 'Users',
    VPC: 'Vpc',
    WEB_CLIENT: 'WebClient',
  },
  MAPPING_TEMPLATE_DEFAULT: {
    REQUEST: 'null',
    RESPONSE: '$util.toJson($ctx.result)',
  },
  MAPPING_TEMPLATE_KEY: {
    REQUEST: 'req',
    RESPONSE: 'res',
    SEQUENCE: 'seq',
  },
  PATH: {
    DATABASES_DDB_TABLES_DIR: path.join(
      process.cwd(),
      'src/databases/dynamodb/tables'
    ),
    DATABASES_PG_MIGRATIONS_DIR: path.join(
      process.cwd(),
      '/src/databases/postgres/migrations'
    ),
    DATABASES_PG_MIGRATIONS_LAMBDA: path.join(
      __dirname,
      '../assets/lambdas/postgres-migrations/index.js'
    ),
    LAMBDAS_DIR: path.join(process.cwd(), '/src/lambdas'),
    RESOLVERS_DIR: path.join(process.cwd(), '/src/graphql/resolvers'),
    RESOLVER_FUNCTIONS_DIR: path.join(
      process.cwd(),
      '/src/graphql/resolvers/functions'
    ),
    SCHEMA_DEFINITION_FILE: path.join(
      process.cwd(),
      '/src/graphql/schema.graphql'
    ),
  },
  TABLE_NAME: {
    A_CDK_MIGRATIONS: 'a_cdk_migrations',
  },
};
