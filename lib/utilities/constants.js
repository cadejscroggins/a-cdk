module.exports = {
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
    NAMESPACE: 'namespace',
    PERMISSIONS: 'permissions',
  },
  DATA_SOURCE_TYPE: {
    DYNAMODB: 'ddb',
    NONE: 'none',
    POSTGRES: 'pg',
  },
  ID_SUFFIX: {
    API: 'Api',
    DATA_SOURCE: 'DataSource',
    IDENTITIES: 'Identities',
    PG_CLUSTER: 'PostgresCluster',
    PG_CLUSTER_VPC: 'PostgresClusterVpc',
    PG_MIGRATIONS: 'PostgresMigrations',
    PG_MIGRATIONS_CUSTOM_RESOURCE: 'PostgresMigrationsCustomResource',
    PG_MIGRATIONS_LAMBDA_ASSET: 'PostgresMigrationsLambdaAsset',
    POLICY: 'Policy',
    ROLE_ATTACHMENT: 'RoleAttachment',
    USERS: 'Users',
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
    DATABASES_DDB_DIR: `${process.cwd()}/src/databases/ddb`,
    DATABASES_PG_MIGRATIONS_DIR: `${process.cwd()}/src/databases/pg/migrations`,
    DATABASES_PG_MIGRATIONS_LAMBDA: `${__dirname}/../assets/lambdas/postgres-migrations/index.js`,
    LAMBDAS_DIR: `${process.cwd()}/src/lambdas`,
    RESOLVERS_DIR: `${process.cwd()}/src/graphql/resolvers`,
    RESOLVER_FUNCTIONS_DIR: `${process.cwd()}/src/graphql/resolvers/functions`,
    SCHEMA_DEFINITION_FILE: `${process.cwd()}/src/graphql/schema.graphql`,
  },
};
