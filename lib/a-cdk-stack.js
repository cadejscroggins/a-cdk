const appsync = require('@aws-cdk/aws-appsync');
const cdk = require('@aws-cdk/core');
const changeCase = require('change-case');
const cognito = require('@aws-cdk/aws-cognito');
const customResources = require('@aws-cdk/custom-resources');
const dynamodb = require('@aws-cdk/aws-dynamodb');
const ec2 = require('@aws-cdk/aws-ec2');
const fs = require('fs');
const iam = require('@aws-cdk/aws-iam');
const lambda = require('@aws-cdk/aws-lambda');
const rds = require('@aws-cdk/aws-rds');
const s3Assets = require('@aws-cdk/aws-s3-assets');
const tmp = require('tmp');
const webpack = require('webpack');
const formatResourceName = require('./format-resource-name');

const CWD = process.cwd();
const DATABASES_DDB_DIR = `${CWD}/src/databases/ddb`;
const DATABASES_PG_MIGRATIONS_DIR = `${CWD}/src/databases/pg/migrations`;
const DATABASES_PG_MIGRATIONS_LAMBDA = `${__dirname}/assets/lambdas/pg-migrations/index.js`;
const LAMBDAS_DIR = `${CWD}/src/lambdas`;
const RESOLVERS_DIR = `${CWD}/src/graphql/resolvers`;
const RESOLVER_FUNCTIONS_DIR = `${CWD}/src/graphql/resolvers/functions`;
const SCHEMA_DEFINITION_FILE = `${CWD}/src/graphql/schema.graphql`;

const DATA_SOURCE_TYPE_DYNAMODB = 'ddb';
const DATA_SOURCE_TYPE_NONE = 'none';
const DATA_SOURCE_TYPE_POSTGRES = 'pg';

const MAPPING_TEMPLATE_REQUEST_KEY = 'req';
const MAPPING_TEMPLATE_RESPONSE_KEY = 'res';
const MAPPING_TEMPLATE_SEQUENCE_KEY = 'seq';

const RESOURCE_SUFFIX_API = 'Api';
const RESOURCE_SUFFIX_DATA_SOURCE = 'DataSource';
const RESOURCE_SUFFIX_IDENTITIES = 'Identities';
const RESOURCE_SUFFIX_POLICY = 'Policy';
const RESOURCE_SUFFIX_POSTGRES_CLUSTER = 'PostgresCluster';
const RESOURCE_SUFFIX_POSTGRES_VPC = 'PostgresVpc';
const RESOURCE_SUFFIX_ROLE_ATTACHMENT = 'RoleAttachment';
const RESOURCE_SUFFIX_USERS = 'Users';
const RESOURCE_SUFFIX_WEB_CLIENT = 'WebClient';

const MAPPING_TEMPLATE_REQUEST_DEFAULT = 'null';
const MAPPING_TEMPLATE_RESPONSE_DEFAULT = '$util.toJson($ctx.result)';

const AUTH_AUTHENTICATED = 'authenticated';
const AUTH_UNAUTHENTICATED = 'unauthenticated';

const AUTH_CUSTOM_MESSAGE_TRIGGER = 'auth-custom-message-trigger';
const AUTH_PRE_SIGNUP_TRIGGER = 'auth-pre-signup-trigger';

const CONTEXT_KEY_AUTH = 'auth';
const CONTEXT_KEY_NAMESPACE = 'namespace';
const CONTEXT_KEY_PERMISSIONS = 'permissions';

class ACdkStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const lambdas = this.createLambdas();
    const dynamodbTables = this.createDynamodbTables();
    const postgresCluster = this.createPostgresCluster();
    const api = this.createApi({ dynamodbTables, postgresCluster });
    const userPool = this.createUserPool({ lambdas });
    const userPoolClient = this.createUserPoolClient({ userPool });
    const identityPool = this.createIdentityPool({ userPool, userPoolClient });

    this.attachAuthPermissions({ api, identityPool });
    this.attachLambdaPermissions({ lambdas, userPool });

    this.createCfnOutputs(
      this.createApiOutputs(api),
      this.createIdentityPoolOutputs(identityPool),
      this.createLambdaOutputs(lambdas),
      this.createUserPoolClientOutputs(userPoolClient),
      this.createUserPoolOutputs(userPool)
    );
  }

  attachAuthPermissions({ api, identityPool }) {
    const authenticatedRole = this.createIdentityPoolRole({
      api,
      identityPool,
      roleType: AUTH_AUTHENTICATED,
    });

    const roles = { authenticated: authenticatedRole.roleArn };

    if (identityPool.allowUnauthenticatedIdentities) {
      const unauthenticatedRole = this.createIdentityPoolRole({
        api,
        identityPool,
        roleType: AUTH_UNAUTHENTICATED,
      });

      roles.unauthenticated = unauthenticatedRole.roleArn;
    }

    new cognito.CfnIdentityPoolRoleAttachment(
      this,
      formatResourceName(
        identityPool.identityPoolName,
        RESOURCE_SUFFIX_ROLE_ATTACHMENT
      ),
      { identityPoolId: identityPool.ref, roles }
    );
  }

  attachLambdaPermissions({ lambdas, userPool }) {
    const permissionsConf = this.node.tryGetContext(CONTEXT_KEY_PERMISSIONS);

    Object.entries(lambdas).forEach(([name, lambda]) => {
      const lambdaActions = permissionsConf?.lambdas?.[name];
      const lambdaAuthActions = lambdaActions?.auth || [];
      const statements = [];

      if (lambdaAuthActions.length) {
        statements.push(
          new iam.PolicyStatement({
            actions: lambdaAuthActions.map((a) => `cognito-idp:${a}`),
            resources: [userPool.userPoolArn],
          })
        );
      }

      if (statements.length) {
        lambda.role.attachInlinePolicy(
          new iam.Policy(
            this,
            formatResourceName(lambda.physicalName, RESOURCE_SUFFIX_POLICY),
            { statements }
          )
        );
      }
    });
  }

  createApi({ dynamodbTables, postgresCluster }) {
    const apiResourceName = formatResourceName(
      this.artifactId,
      RESOURCE_SUFFIX_API
    );

    const api = new appsync.GraphqlApi(this, apiResourceName, {
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.IAM,
        },
      },
      name: apiResourceName,
      schema: appsync.Schema.fromAsset(SCHEMA_DEFINITION_FILE),
    });

    api.addNoneDataSource(formatResourceName(DATA_SOURCE_TYPE_NONE));

    this.createApiResolvers({
      api,
      dynamodbDataSources: this.createApiDynamodbDataSources({
        api,
        dynamodbTables,
      }),
      pipelineFunctions: this.createApiPipelineFunctions({ api }),
      postgresDataSource: this.createApiPostgresDataSource({
        api,
        postgresCluster,
      }),
    });

    return api;
  }

  createApiDynamodbDataSources({ api, dynamodbTables }) {
    if (!fs.existsSync(DATABASES_DDB_DIR)) return {};

    return fs.readdirSync(DATABASES_DDB_DIR).reduce((acc, fileName) => {
      const [tableName] = fileName.split('.');

      const dataSourceResourceName = formatResourceName(
        DATA_SOURCE_TYPE_DYNAMODB,
        tableName,
        RESOURCE_SUFFIX_DATA_SOURCE
      );

      acc[
        dataSourceResourceName
      ] = api.addDynamoDbDataSource(
        dataSourceResourceName,
        dynamodbTables[formatResourceName(this.artifactId, tableName)],
        { name: dataSourceResourceName }
      );

      return acc;
    }, {});
  }

  createApiOutputs(api) {
    return {
      apiArn: api.arn,
      apiAuthenticationType: 'AWS_IAM',
      apiGraphqlEndpoint: api.graphqlUrl,
      apiRegion: this.region,
    };
  }

  createApiPipelineFunctions({ api }) {
    if (!fs.existsSync(RESOLVER_FUNCTIONS_DIR)) return {};

    return Object.entries(
      fs
        .readdirSync(RESOLVER_FUNCTIONS_DIR)
        .reduce((acc, mappingTemplateFile) => {
          const [
            functionName,
            templateType,
            templateDataSourceType,
            templateDataSourceName,
          ] = mappingTemplateFile.split('.');

          const functionResourceName = formatResourceName(functionName);

          const dataSourceResourceName = formatResourceName(
            templateDataSourceType,
            templateDataSourceName,
            RESOURCE_SUFFIX_DATA_SOURCE
          );

          acc[functionResourceName] = {
            ...acc[functionResourceName],
            dataSourceName: templateDataSourceType
              ? dataSourceResourceName
              : DATA_SOURCE_TYPE_NONE,
            [templateType]: fs.readFileSync(
              `${RESOLVER_FUNCTIONS_DIR}/${mappingTemplateFile}`,
              'utf8'
            ),
          };

          return acc;
        }, {})
    ).reduce((acc, [resourceName, conf]) => {
      const pipelineFunction = new appsync.CfnFunctionConfiguration(
        this,
        resourceName,
        {
          apiId: api.apiId,
          dataSourceName: conf.dataSourceName,
          functionVersion: '2018-05-29',
          name: resourceName,
          requestMappingTemplate: conf.req,
          responseMappingTemplate:
            conf.res || MAPPING_TEMPLATE_RESPONSE_DEFAULT,
        }
      );

      pipelineFunction.node.addDependency(api);
      return { ...acc, [resourceName]: pipelineFunction };
    }, {});
  }

  createApiPostgresDataSource({ api, postgresCluster }) {
    if (!fs.existsSync(DATABASES_PG_MIGRATIONS_DIR)) return null;

    const dataSourceResourceName = formatResourceName(
      DATA_SOURCE_TYPE_POSTGRES,
      RESOURCE_SUFFIX_DATA_SOURCE
    );

    return api.addRdsDataSource(
      dataSourceResourceName,
      postgresCluster,
      postgresCluster.secret,
      { name: dataSourceResourceName }
    );
  }

  createApiResolvers({
    api,
    dynamodbDataSources,
    pipelineFunctions,
    postgresDataSource,
  }) {
    if (!fs.existsSync(RESOLVERS_DIR)) return {};

    return Object.entries(
      fs
        .readdirSync(RESOLVERS_DIR, { withFileTypes: true })
        .filter((f) => f.isFile())
        .map((f) => f.name)
        .reduce((acc, mappingTemplateFile) => {
          const [
            typeName,
            fieldName,
            templateType,
            templateDataSourceType,
            templateDataSourceName,
          ] = mappingTemplateFile.split('.');

          const mappingTemplateFilePath = `${RESOLVERS_DIR}/${mappingTemplateFile}`;
          const resolverResourceName = formatResourceName(typeName, fieldName);

          const dataSourceResourceName = formatResourceName(
            templateDataSourceType,
            templateDataSourceName,
            RESOURCE_SUFFIX_DATA_SOURCE
          );

          let dataSource;

          switch (templateDataSourceType) {
            case DATA_SOURCE_TYPE_DYNAMODB: {
              dataSource = dynamodbDataSources[dataSourceResourceName];
              break;
            }

            case DATA_SOURCE_TYPE_POSTGRES: {
              dataSource = postgresDataSource;
              break;
            }

            default: {
              // noop
            }
          }

          let mappingTemplate;

          switch (templateType) {
            case MAPPING_TEMPLATE_SEQUENCE_KEY: {
              mappingTemplate = JSON.parse(
                fs.readFileSync(mappingTemplateFilePath, 'utf8')
              ).map(
                (functionName) =>
                  pipelineFunctions[formatResourceName(functionName)]
                    .attrFunctionId
              );

              break;
            }

            case MAPPING_TEMPLATE_REQUEST_KEY:
            case MAPPING_TEMPLATE_RESPONSE_KEY: {
              mappingTemplate = appsync.MappingTemplate.fromFile(
                mappingTemplateFilePath
              );

              break;
            }

            default: {
              // noop
            }
          }

          acc[resolverResourceName] = {
            ...acc[resolverResourceName],
            dataSource,
            fieldName: changeCase.camelCase(fieldName),
            [templateType]: mappingTemplate,
            typeName: changeCase.pascalCase(typeName),
          };

          return acc;
        }, {})
    ).reduce((acc, [resourceName, conf]) => {
      const resolver = new appsync.Resolver(this, resourceName, {
        api,
        dataSource: conf.dataSource,
        fieldName: conf.fieldName,
        pipelineConfig: conf[MAPPING_TEMPLATE_SEQUENCE_KEY],
        requestMappingTemplate:
          conf[MAPPING_TEMPLATE_REQUEST_KEY] ||
          appsync.MappingTemplate.fromString(MAPPING_TEMPLATE_REQUEST_DEFAULT),
        responseMappingTemplate:
          conf[MAPPING_TEMPLATE_RESPONSE_KEY] ||
          appsync.MappingTemplate.fromString(MAPPING_TEMPLATE_RESPONSE_DEFAULT),
        typeName: conf.typeName,
      });

      resolver.node.addDependency(api);
      return { ...acc, [resourceName]: resolver };
    }, {});
  }

  createPostgresCluster() {
    if (!fs.existsSync(DATABASES_PG_MIGRATIONS_DIR)) return null;

    const databaseName = formatResourceName(
      this.node.tryGetContext(CONTEXT_KEY_NAMESPACE)
    );

    const postgresCluster = new rds.ServerlessCluster(
      this,
      formatResourceName(this.artifactId, RESOURCE_SUFFIX_POSTGRES_CLUSTER),
      {
        engine: rds.DatabaseClusterEngine.AURORA_POSTGRESQL,
        parameterGroup: rds.ParameterGroup.fromParameterGroupName(
          this,
          'ParameterGroup',
          'default.aurora-postgresql10'
        ),
        defaultDatabaseName: databaseName,
        vpc: new ec2.Vpc(
          this,
          formatResourceName(this.artifactId, RESOURCE_SUFFIX_POSTGRES_VPC)
        ),
        scaling: { autoPause: cdk.Duration.minutes(5) },
      }
    );

    const tmpLambdaAssetDir = tmp.dirSync().name;
    const tmpMigrationsAssetDir = `${tmpLambdaAssetDir}/migrations`;
    fs.mkdirSync(tmpMigrationsAssetDir);

    fs.readdirSync(DATABASES_PG_MIGRATIONS_DIR).forEach((asset) =>
      fs.copyFileSync(
        `${DATABASES_PG_MIGRATIONS_DIR}/${asset}`,
        `${tmpMigrationsAssetDir}/${asset}`
      )
    );

    webpack(
      {
        entry: DATABASES_PG_MIGRATIONS_LAMBDA,
        mode: 'development',
        output: {
          filename: 'index.js',
          libraryTarget: 'umd',
          path: tmpLambdaAssetDir,
        },
        plugins: [
          new webpack.IgnorePlugin({
            resourceRegExp: /^(pg-hstore|pg-native)$/,
          }),
        ],
        target: 'node',
      },
      (err, stats) => {
        console.log(
          tmpLambdaAssetDir,
          fs.readdirSync(tmpLambdaAssetDir),
          stats.toJson().errors
        );

        const postgresMigrationsLambdaAsset = new s3Assets.Asset(
          this,
          formatResourceName(this.artifactId, 'PostgresMigrationsLambdaAsset'),
          {
            path: tmpLambdaAssetDir,
          }
        );

        const postgresMigrationsLambdaResourceName = formatResourceName(
          this.artifactId,
          'PostgresMigrations'
        );

        const postgresMigrationsLambda = new lambda.Function(
          this,
          postgresMigrationsLambdaResourceName,
          {
            code: lambda.Code.fromBucket(
              postgresMigrationsLambdaAsset.bucket,
              postgresMigrationsLambdaAsset.s3ObjectKey
            ),
            environment: {
              clusterDatabase: databaseName,
              clusterHost: postgresCluster.clusterEndpoint.hostname,
              clusterPort: postgresCluster.clusterEndpoint.port,
              clusterSecretArn: postgresCluster.secret.secretArn,
            },
            functionName: postgresMigrationsLambdaResourceName,
            handler: 'index.handler',
            runtime: lambda.Runtime.NODEJS_12_X,
          }
        );

        postgresCluster.grantDataApiAccess(postgresMigrationsLambda);

        new customResources.Provider(
          this,
          formatResourceName(
            this.artifactId,
            'PostgresMigrationsCustomResource'
          ),
          { onEventHandler: postgresMigrationsLambda }
        );
      }
    );

    return postgresCluster;
  }

  createCfnOutputs(...outputs) {
    Object.entries(Object.assign(...outputs)).forEach(
      ([name, value]) => new cdk.CfnOutput(this, name, { value })
    );
  }

  createDynamodbTables() {
    if (!fs.existsSync(DATABASES_DDB_DIR)) return {};

    return fs.readdirSync(DATABASES_DDB_DIR).reduce((acc, configFile) => {
      const [tableName] = configFile.split('.');
      const tableResourceName = formatResourceName(this.artifactId, tableName);
      const configFilePath = `${DATABASES_DDB_DIR}/${configFile}`;
      const config = JSON.parse(String(fs.readFileSync(configFilePath)));

      const table = new dynamodb.Table(this, tableResourceName, {
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        partitionKey: {
          name: config.KeyAttributes.PartitionKey.AttributeName,
          type: config.KeyAttributes.PartitionKey.AttributeType,
        },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        sortKey: config.KeyAttributes.SortKey
          ? {
              name: config.KeyAttributes.SortKey.AttributeName,
              type: config.KeyAttributes.SortKey.AttributeType,
            }
          : undefined,
        tableName: tableResourceName,
      });

      (config.GlobalSecondaryIndexes || []).forEach((gsi) => {
        table.addGlobalSecondaryIndex({
          indexName: gsi.IndexName,
          partitionKey: {
            name: gsi.KeyAttributes.PartitionKey.AttributeName,
            type: gsi.KeyAttributes.PartitionKey.AttributeType,
          },
          sortKey: gsi.KeyAttributes.SortKey
            ? {
                name: gsi.KeyAttributes.SortKey.AttributeName,
                type: gsi.KeyAttributes.SortKey.AttributeType,
              }
            : undefined,
        });
      });

      acc[tableResourceName] = table;
      return acc;
    }, {});
  }

  createIdentityPool({ userPool, userPoolClient }) {
    const authConf = this.node.tryGetContext(CONTEXT_KEY_AUTH);

    const identityPoolResourceName = formatResourceName(
      this.artifactId,
      RESOURCE_SUFFIX_IDENTITIES
    );

    return new cognito.CfnIdentityPool(this, identityPoolResourceName, {
      allowUnauthenticatedIdentities: !!authConf?.allowUnauthenticatedIdentities,
      cognitoIdentityProviders: [
        {
          clientId: userPoolClient.userPoolClientId,
          providerName: userPool.userPoolProviderName,
        },
      ],
      identityPoolName: identityPoolResourceName,
    });
  }

  createIdentityPoolOutputs(identityPool) {
    return {
      authIdentityPoolId: identityPool.ref,
      authMandatorySignIn: !identityPool.allowUnauthenticatedIdentities,
    };
  }

  createIdentityPoolRole({ api, identityPool, roleType }) {
    const permissionsConf = this.node.tryGetContext(CONTEXT_KEY_PERMISSIONS);
    const rolePermissions = permissionsConf?.auth?.[roleType];
    const apiPermissions = rolePermissions?.api || [];

    const role = new iam.Role(
      this,
      formatResourceName(identityPool.identityPoolName, roleType, 'role'),
      {
        assumedBy: new iam.FederatedPrincipal(
          'cognito-identity.amazonaws.com',
          {
            'ForAnyValue:StringLike': {
              'cognito-identity.amazonaws.com:amr': roleType,
            },
            StringEquals: {
              'cognito-identity.amazonaws.com:aud': identityPool.ref,
            },
          },
          'sts:AssumeRoleWithWebIdentity'
        ),
      }
    );

    if (apiPermissions.length) {
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['appsync:GraphQL'],
          effect: iam.Effect.ALLOW,
          resources: apiPermissions.map((p) => `${api.arn}/types/${p}`),
        })
      );
    }

    return role;
  }

  createLambdaOutputs(lambdas) {
    return Object.entries(lambdas)
      .filter(([name, lambda]) => name)
      .reduce(
        (acc, [name, lambda]) => ({
          ...acc,
          [changeCase.camelCase(`lambda-${name}-arn`)]: lambda.functionArn,
        }),
        {}
      );
  }

  createLambdas() {
    return fs.existsSync(LAMBDAS_DIR)
      ? fs.readdirSync(LAMBDAS_DIR).reduce((acc, name) => {
          const lambdaResourceName = formatResourceName(this.artifactId, name);

          acc[name] = new lambda.Function(this, lambdaResourceName, {
            code: lambda.Code.fromAsset(`${LAMBDAS_DIR}/${name}`),
            functionName: lambdaResourceName,
            handler: 'index.handler',
            runtime: lambda.Runtime.NODEJS_12_X,
          });

          return acc;
        }, {})
      : {};
  }

  createUserPool({ lambdas }) {
    const userPoolResourceName = formatResourceName(
      this.artifactId,
      RESOURCE_SUFFIX_USERS
    );

    const authConf = this.node.tryGetContext(CONTEXT_KEY_AUTH);

    const userPool = new cognito.UserPool(this, userPoolResourceName, {
      autoVerify: authConf?.autoVerify,
      customAttributes: Object.entries(authConf?.customAttributes || {}).reduce(
        (acc, [attributeName, attributeConfig]) => ({
          ...acc,
          [attributeName]: new cognito[`${attributeConfig.type}Attribute`](
            attributeConfig
          ),
        }),
        {}
      ),
      lambdaTriggers: {
        customMessage: lambdas[AUTH_CUSTOM_MESSAGE_TRIGGER],
        preSignUp: lambdas[AUTH_PRE_SIGNUP_TRIGGER],
      },
      passwordPolicy: authConf?.passwordPolicy,
      selfSignUpEnabled: authConf?.selfSignUpEnabled,
      signInAliases: authConf?.signInAliases,
      standardAttributes: authConf?.standardAttributes,
      userPoolName: userPoolResourceName,
    });

    if (authConf.emailConfiguration) {
      userPool.node.defaultChild.emailConfiguration = {
        emailSendingAccount: 'DEVELOPER',
        from: `${authConf.emailConfiguration.fromName} <${authConf.emailConfiguration.fromAddress}>`,
        sourceArn: `arn:aws:ses:${this.region}:${this.account}:identity/${authConf.emailConfiguration.fromAddress}`,
      };
    }

    return userPool;
  }

  createUserPoolOutputs(userPool) {
    return {
      authRegion: this.region,
      authUserPoolArn: userPool.userPoolArn,
      authUserPoolId: userPool.userPoolId,
    };
  }

  createUserPoolClient({ userPool }) {
    const userPoolClientResourceName = formatResourceName(
      this.artifactId,
      RESOURCE_SUFFIX_WEB_CLIENT
    );

    return new cognito.UserPoolClient(this, userPoolClientResourceName, {
      userPool,
      userPoolClientName: userPoolClientResourceName,
    });
  }

  createUserPoolClientOutputs(userPoolClient) {
    return {
      authUserPoolWebClientId: userPoolClient.userPoolClientId,
    };
  }
}

module.exports = ACdkStack;
